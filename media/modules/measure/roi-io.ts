"use strict";

import { compileExpression, type ExpressionScope } from './expression.js';
import type {
	Calibration,
	MeasurementColumn,
	MeasurementProvenance,
	MeasurementRow,
	Roi,
} from './types.js';

/**
 * Persistence and export.
 *
 * The design decision that matters here: ROIs are stored as a **text sidecar**
 * next to the image (`image.tif.rois.json`), not in an opaque binary. That file
 * is diffable, reviewable in a pull request, editable by hand, and readable by
 * any script — which is the whole argument for doing measurement inside an
 * editor rather than in a separate application. ImageJ's `.roi`/`RoiSet.zip`
 * remains supported for interop, but it is not the native format.
 *
 * The export side exists to remove the reason people paste results into a
 * spreadsheet. Rows come out in long/tidy form with full provenance attached,
 * so nobody has to reconstruct which file, channel, or threshold produced a
 * number.
 */

export const SIDECAR_VERSION = 2;

export interface DerivedColumn {
	name: string;
	expression: string;
}

export interface RoiSidecar {
	version: number;
	/** Name of the image these ROIs belong to, as a sanity check on load. */
	image?: string;
	imageWidth?: number;
	imageHeight?: number;
	calibration: Calibration;
	columns?: MeasurementColumn[];
	derivedColumns?: DerivedColumn[];
	rois: SerializedRoi[];
	createdBy?: string;
	createdAt?: string;
}

/** ROI as stored. Mask payloads are run-length encoded to keep files legible. */
export type SerializedRoi = Omit<Roi, 'mask'> & {
	mask?: never;
	/** Run-length encoding of the mask: alternating run lengths starting at 0. */
	maskRuns?: number[];
};

/**
 * Run-length encode a mask.
 *
 * Segmentation masks are mostly long uniform runs, so this is both far smaller
 * than a base64 blob and — the point — still readable in a diff, where a
 * changed object shows up as a handful of changed numbers.
 */
export function encodeMaskRuns(mask: Uint8Array): number[] {
	const runs: number[] = [];
	let current = 0;
	let length = 0;
	for (let i = 0; i < mask.length; i++) {
		const value = mask[i] ? 1 : 0;
		if (value === current) {
			length++;
		} else {
			runs.push(length);
			current = value;
			length = 1;
		}
	}
	runs.push(length);
	return runs;
}

export function decodeMaskRuns(runs: number[], expectedLength: number): Uint8Array {
	const mask = new Uint8Array(expectedLength);
	let index = 0;
	let value = 0;
	for (const run of runs) {
		if (value) {
			const end = Math.min(expectedLength, index + run);
			mask.fill(1, index, end);
		}
		index += run;
		value = value ? 0 : 1;
		if (index >= expectedLength) { break; }
	}
	return mask;
}

export function serializeRoi(roi: Roi): SerializedRoi {
	if (roi.kind === 'mask') {
		const { mask, ...rest } = roi;
		return { ...rest, maskRuns: encodeMaskRuns(mask) } as SerializedRoi;
	}
	return { ...roi } as SerializedRoi;
}

export function deserializeRoi(stored: SerializedRoi): Roi | null {
	if (!stored || typeof stored !== 'object' || !stored.kind) { return null; }
	if (stored.kind === 'mask') {
		const { maskRuns, ...rest } = stored as SerializedRoi & { width: number; height: number };
		const expected = (rest.width || 0) * (rest.height || 0);
		if (!maskRuns || expected <= 0) { return null; }
		return { ...rest, mask: decodeMaskRuns(maskRuns, expected) } as Roi;
	}
	return stored as unknown as Roi;
}

export function buildSidecar(
	rois: Roi[],
	calibration: Calibration,
	context: {
		image?: string;
		imageWidth?: number;
		imageHeight?: number;
		columns?: MeasurementColumn[];
		derivedColumns?: DerivedColumn[];
		version?: string;
	},
): RoiSidecar {
	return {
		version: SIDECAR_VERSION,
		image: context.image,
		imageWidth: context.imageWidth,
		imageHeight: context.imageHeight,
		calibration,
		columns: context.columns,
		derivedColumns: context.derivedColumns,
		rois: rois.map(serializeRoi),
		createdBy: context.version ? `tiff-visualizer ${context.version}` : 'tiff-visualizer',
		createdAt: new Date().toISOString(),
	};
}

export interface ParsedSidecar {
	rois: Roi[];
	calibration?: Calibration;
	columns?: MeasurementColumn[];
	derivedColumns?: DerivedColumn[];
	warnings: string[];
}

export function parseSidecar(text: string): ParsedSidecar {
	const warnings: string[] = [];
	let parsed: RoiSidecar;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { rois: [], warnings: [`Could not parse the ROI file: ${(error as Error).message}`] };
	}
	if (!parsed || !Array.isArray(parsed.rois)) {
		return { rois: [], warnings: ['The ROI file has no "rois" array.'] };
	}
	if (parsed.version > SIDECAR_VERSION) {
		warnings.push(`The file was written by a newer version (${parsed.version}); unknown fields were ignored.`);
	}

	const rois: Roi[] = [];
	for (const stored of parsed.rois) {
		const roi = deserializeRoi(stored);
		if (roi) { rois.push(roi); } else { warnings.push('Skipped an ROI entry that could not be read.'); }
	}

	return {
		rois,
		calibration: parsed.calibration,
		columns: parsed.columns,
		derivedColumns: parsed.derivedColumns,
		warnings,
	};
}

// ---------------------------------------------------------------------------
// Tabular export
// ---------------------------------------------------------------------------

export interface ExportOptions {
	/** Column separator. Comma for CSV, tab for pasting into a spreadsheet. */
	delimiter?: ',' | ';' | '\t';
	/**
	 * Decimal separator. German-locale Excel reads "412.7" as a date, which is
	 * itself a common reason results get retyped by hand; offering the comma
	 * removes that failure mode at the source.
	 */
	decimal?: '.' | ',';
	/** Prepend a UTF-8 BOM so Excel opens the file as UTF-8 without a dialog. */
	bom?: boolean;
	/** Significant digits for floating-point output. */
	precision?: number;
	includeProvenance?: boolean;
	derivedColumns?: DerivedColumn[];
	/** Extra constant columns, e.g. grouping captured from the filename. */
	extraColumns?: Record<string, string | number>;
}

const PROVENANCE_KEYS: (keyof MeasurementProvenance)[] = [
	'fileName', 'unit', 'pixelWidth', 'pixelHeight', 'calibrationOrigin',
	'thresholdMethod', 'thresholdLow', 'thresholdHigh', 'preprocessing',
	'extensionVersion', 'settingsHash',
];

/** Column order for the exported table. */
const ROW_KEYS: (keyof MeasurementRow)[] = [
	'fileName', 'page', 'roiId', 'roiName', 'roiKind', 'group', 'channel',
	'pixelCount', 'area', 'perimeter', 'length',
	'bx', 'by', 'width', 'height',
	'major', 'minor', 'angle',
	'feret', 'minFeret', 'feretAngle', 'feretX', 'feretY',
	'circularity', 'aspectRatio', 'roundness', 'solidity',
	'centroidX', 'centroidY', 'centerOfMassX', 'centerOfMassY',
	'mean', 'stdDev', 'min', 'max', 'median', 'mode',
	'skewness', 'kurtosis',
	'integratedDensity', 'rawIntegratedDensity', 'nonFiniteCount',
];

/**
 * Render measurement rows as delimited text in long/tidy form.
 *
 * One row per ROI per channel, with every provenance field repeated on every
 * row. The repetition is deliberate: it is what lets a downstream `groupby` or
 * a `pandas.concat` of several exports work without any manual bookkeeping.
 */
export function rowsToDelimitedText(
	rows: MeasurementRow[],
	provenance: MeasurementProvenance,
	options: ExportOptions = {},
): string {
	const delimiter = options.delimiter ?? ',';
	const decimal = options.decimal ?? '.';
	const precision = options.precision ?? 6;
	const includeProvenance = options.includeProvenance !== false;

	const derived = (options.derivedColumns || []).map(column => {
		try {
			return { name: column.name, evaluate: compileExpression(column.expression) };
		} catch {
			// A broken expression must not abort the export; the column is simply
			// absent, and the panel already shows the parse error.
			return null;
		}
	}).filter((entry): entry is { name: string; evaluate: (scope: ExpressionScope) => number } => !!entry);

	const extraKeys = Object.keys(options.extraColumns || {});
	const presentKeys = ROW_KEYS.filter(key => rows.some(row => row[key] !== undefined && row[key] !== null));

	const header: string[] = [
		...extraKeys,
		...presentKeys.map(String),
		...derived.map(column => column.name),
		...(includeProvenance ? PROVENANCE_KEYS.filter(key => provenance[key] !== undefined).map(String) : []),
	];

	const formatValue = (value: unknown): string => {
		if (value === undefined || value === null) { return ''; }
		if (typeof value === 'number') {
			if (!Number.isFinite(value)) { return Number.isNaN(value) ? 'NaN' : (value > 0 ? 'Inf' : '-Inf'); }
			const text = Number.isInteger(value) ? String(value) : trimFloat(value, precision);
			return decimal === ',' ? text.replace('.', ',') : text;
		}
		return String(value);
	};

	const quote = (text: string): string => {
		if (text.includes(delimiter) || text.includes('"') || text.includes('\n')) {
			return `"${text.replace(/"/g, '""')}"`;
		}
		return text;
	};

	const lines: string[] = [header.map(quote).join(delimiter)];

	for (const row of rows) {
		const scope: ExpressionScope = {};
		for (const key of presentKeys) {
			const value = row[key];
			if (typeof value === 'number') { scope[String(key)] = value; }
		}

		const cells: string[] = [];
		for (const key of extraKeys) { cells.push(quote(formatValue(options.extraColumns![key]))); }
		for (const key of presentKeys) { cells.push(quote(formatValue(row[key]))); }
		for (const column of derived) {
			let value: number;
			try { value = column.evaluate(scope); } catch { value = NaN; }
			cells.push(quote(formatValue(value)));
		}
		if (includeProvenance) {
			for (const key of PROVENANCE_KEYS) {
				if (provenance[key] === undefined) { continue; }
				cells.push(quote(formatValue(provenance[key])));
			}
		}
		lines.push(cells.join(delimiter));
	}

	const text = lines.join('\n') + '\n';
	return options.bom ? `﻿${text}` : text;
}

/** Fixed significant digits without trailing zeros or exponent surprises. */
function trimFloat(value: number, precision: number): string {
	const magnitude = Math.abs(value);
	if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e10)) {
		return value.toExponential(Math.max(1, precision - 1));
	}
	const text = value.toFixed(precision);
	return text.replace(/\.?0+$/, '') || '0';
}

// ---------------------------------------------------------------------------
// Filename-derived grouping
// ---------------------------------------------------------------------------

export interface FilenamePattern {
	/** e.g. "{condition}_{replicate}_{index}.tif" */
	pattern: string;
}

/**
 * Extract grouping columns from a filename.
 *
 * This is precisely the join people otherwise perform by hand in a spreadsheet:
 * the experimental condition is encoded in the file name, and the analysis
 * needs it as a column. Braces name a capture; everything else matches
 * literally, and `*` matches any run of characters.
 */
export function matchFilenamePattern(fileName: string, pattern: string): Record<string, string> | null {
	if (!pattern) { return null; }
	const names: string[] = [];
	let regexSource = '^';

	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === '{') {
			const end = pattern.indexOf('}', i);
			if (end < 0) { return null; }
			const name = pattern.slice(i + 1, end).trim();
			if (!name) { return null; }
			names.push(name);
			// Non-greedy so the literal separators between captures win.
			regexSource += '(.+?)';
			i = end;
			continue;
		}
		if (ch === '*') { regexSource += '.*'; continue; }
		regexSource += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
	regexSource += '$';

	let regex: RegExp;
	try { regex = new RegExp(regexSource); } catch { return null; }
	const base = fileName.split('/').pop() || fileName;
	const match = regex.exec(base);
	if (!match) { return null; }

	const result: Record<string, string> = {};
	for (let i = 0; i < names.length; i++) { result[names[i]] = match[i + 1] ?? ''; }
	return result;
}

// ---------------------------------------------------------------------------
// Grouped summaries
// ---------------------------------------------------------------------------

export interface GroupSummary {
	key: string;
	n: number;
	mean: number;
	stdDev: number;
	sem: number;
	min: number;
	max: number;
}

/**
 * Summarise one numeric column by a grouping key.
 *
 * Shown in the panel for reading only — the exported artefact stays the raw
 * long table. Aggregating on export would throw away the rows a reviewer needs
 * to check the aggregate, which is exactly the failure mode of pasting
 * pre-summarised numbers into a spreadsheet.
 */
export function summarizeByGroup(
	rows: MeasurementRow[],
	valueKey: keyof MeasurementRow,
	groupKey: (row: MeasurementRow) => string,
): GroupSummary[] {
	const buckets = new Map<string, number[]>();
	for (const row of rows) {
		const value = row[valueKey];
		if (typeof value !== 'number' || !Number.isFinite(value)) { continue; }
		const key = groupKey(row);
		const bucket = buckets.get(key);
		if (bucket) { bucket.push(value); } else { buckets.set(key, [value]); }
	}

	const summaries: GroupSummary[] = [];
	for (const [key, values] of buckets) {
		const n = values.length;
		let mean = 0;
		for (const value of values) { mean += value; }
		mean /= n;
		let variance = 0;
		for (const value of values) { variance += (value - mean) * (value - mean); }
		variance = n > 1 ? variance / (n - 1) : 0;
		const stdDev = Math.sqrt(variance);
		summaries.push({
			key,
			n,
			mean,
			stdDev,
			sem: n > 0 ? stdDev / Math.sqrt(n) : 0,
			min: Math.min(...values),
			max: Math.max(...values),
		});
	}
	summaries.sort((a, b) => a.key.localeCompare(b.key));
	return summaries;
}

// ---------------------------------------------------------------------------
// Python starter script
// ---------------------------------------------------------------------------

export interface PandasScriptContext {
	csvName: string;
	/** Columns actually present in the export. */
	columns: string[];
	unit: string;
	pixelWidth: number;
	pixelHeight: number;
	calibrationOrigin: Calibration['origin'];
	/** Grouping columns captured from the filename, if any. */
	groupColumns: string[];
	derivedColumns: DerivedColumn[];
	thresholdMethod?: string;
	roiCount: number;
	channelCount: number;
}

/**
 * Translate a measurement expression into something `DataFrame.eval` accepts.
 *
 * The syntaxes are nearly identical — both are infix arithmetic over bare
 * column names — with one incompatibility that matters: `^` is exponentiation
 * here and bitwise XOR in pandas, so leaving it alone would produce a wrong
 * answer silently rather than an error.
 */
function expressionToPandas(expression: string): string {
	return expression.replace(/\^/g, '**');
}

/**
 * Emit a pandas script alongside a CSV export.
 *
 * Many users would rather do the statistics in Python and are only avoiding the
 * boilerplate. The script is written from the *current* session — the columns
 * that actually exist, the unit and pixel size in force, the threshold that
 * produced the objects, and any derived columns as real pandas expressions — so
 * it is a record of the analysis rather than a generic stub. Where it cannot
 * know the user's intent (which column to summarise, which grouping matters) it
 * picks a sensible default and says so in a comment.
 */
export function buildPandasScript(context: PandasScriptContext): string {
	const has = (name: string) => context.columns.indexOf(name) >= 0;
	// Summarise whatever the measurements actually contain, in order of how
	// often it is the quantity of interest.
	const valueColumn = ['area', 'mean', 'length', 'integratedDensity', 'pixelCount']
		.find(has) || context.columns.find(name => name !== 'channel') || 'area';

	const grouping = context.groupColumns.length > 0
		? context.groupColumns
		: (has('group') ? ['group'] : ['fileName']);
	const groupingLiteral = grouping.map(name => JSON.stringify(name)).join(', ');

	const scaleNote = context.calibrationOrigin === 'none'
		? 'Uncalibrated: lengths are in pixels and areas in pixels squared.'
		: `Calibrated at ${context.pixelWidth} × ${context.pixelHeight} ${context.unit} per pixel `
		+ `(${context.calibrationOrigin}), so "area" is in ${context.unit}² and lengths in ${context.unit}.`;

	const thresholdNote = context.thresholdMethod
		? `Objects came from the "${context.thresholdMethod}" threshold; the exact cut is in the\nthresholdLow/thresholdHigh columns.`
		: 'ROIs were drawn or imported rather than thresholded.';

	const derivedLines = context.derivedColumns.length > 0
		? '\n# Derived columns, carried over from the measurement panel.\n'
		+ context.derivedColumns
			.map(column => `df[${JSON.stringify(column.name)}] = df.eval(${JSON.stringify(expressionToPandas(column.expression))})`)
			.join('\n') + '\n'
		: '';

	const channelLines = context.channelCount > 1
		? `\n# This image has ${context.channelCount} channels and the export has one row per ROI
# per channel. Aggregating without picking one would count every object once per
# channel.
df = df[df["channel"] == 0]
`
		: '';

	return `"""Analysis of ${context.csvName}.

Written by the Scientific Image Visualizer measurement panel from the session
that produced this CSV.

${scaleNote}
${thresholdNote}
${context.roiCount} ROI(s) measured. Intensity columns (mean, min, max, StdDev,
integratedDensity) are raw sample values and are never affected by display
settings such as normalisation or gamma.

The CSV is long/tidy — one row per ROI per channel with provenance repeated on
every row — so several exports concatenate with pd.concat and no bookkeeping.

Available columns: ${context.columns.join(', ')}
"""

import pandas as pd

df = pd.read_csv(${JSON.stringify(context.csvName)})
${channelLines}${derivedLines}
# Grouped by ${grouping.join(' and ')}; change this to whatever your comparison is.
summary = (
    df.groupby([${groupingLiteral}])[${JSON.stringify(valueColumn)}]
      .agg(["count", "mean", "std", "sem", "min", "max"])
      .reset_index()
)

print(summary.to_string(index=False))

# summary.to_csv("summary.csv", index=False)
`;
}
