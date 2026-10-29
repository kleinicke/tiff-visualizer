"use strict";

/**
 * What a Xenium output bundle is, as far as the viewer needs to know.
 *
 * `experiment.xenium` is a small JSON manifest at the top of the bundle. For
 * the morphology images it names ONE file of the `morphology_focus/` set
 * (`images.morphology_focus_filepath`); the other stains sit beside it, one
 * OME-TIFF per channel. The channel NAMES are not in the manifest: every file
 * carries the same OME-XML, which lists all channels, maps each to its file,
 * and (Xenium Onboard Analysis) stores the instrument's suggested display range
 * in a structured annotation. `omeChannelHints` reads those.
 *
 * Everything here is plain data in, plain data out, so the extension host and
 * the webview share it and a test can run it without either.
 */

export interface XeniumExperiment {
	/** Microns per pixel of the morphology images. */
	pixelSizeUm: number;
	runName?: string;
	regionName?: string;
	numCells?: number;
	/** Path of one morphology_focus file, relative to the bundle. */
	morphologyFocusPath?: string;
}

export interface XeniumChannelFile {
	/** Position in the channel set, from the file name. */
	index: number;
	fileName: string;
	/** Relative to the bundle folder, with forward slashes. */
	relativePath: string;
	/** A readable name from the file name, used until the OME-XML names the channel. */
	fallbackName: string;
}

export interface SceneChannelSource {
	id: string;
	fileName: string;
	/** Where the webview reads the file. */
	src: string;
	fallbackName: string;
}

/** What the host hands the webview when a bundle opens. */
export interface SceneManifest {
	kind: 'xenium';
	title: string;
	pixelSizeUm: number;
	run?: { name?: string; region?: string; cells?: number };
	channels: SceneChannelSource[];
	/** Cell table and outlines, when the bundle has them. */
	cells?: { cells: string; cellBoundaries: string; nucleusBoundaries?: string };
	/** The bundle's transcripts.parquet, when it has one. */
	transcripts?: string;
	/** Gene names in the panel (`gene_panel.json`), so genes with no transcripts can still be listed. */
	genePanel?: string[];
	/** Extra cell files named in the settings, resolved by the host. */
	cellSources?: CellSourceSpec[];
}

/**
 * A cell file the host resolved. `kind` is what the setting declared, or
 * 'unknown' for a file the user typed or picked (the loader reads the columns
 * to decide). Exactly one of `src` (a webview URI) and `bytes` (a file outside
 * the webview's reachable folders, read by the host) is set when `found`.
 */
export interface CellSourceSpec {
	name: string;
	kind: 'table' | 'boundaries' | 'unknown';
	/** Path as shown to the user. */
	path: string;
	found: boolean;
	/** For a configured table or nucleus file: the name of the one cell set it belongs to. */
	parent?: string;
	src?: string;
	bytes?: ArrayBuffer;
}

/** Fill `{sample_name}` in a path template. */
export function expandSampleName(template: string, sampleName: string): string {
	return template.replace(/\{sample_name\}/g, sampleName);
}

export function isAbsolutePath(path: string): boolean {
	return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

/** Short display name for a path typed or picked by the user: the file name without .parquet. */
export function sourceNameFromPath(path: string): string {
	const file = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
	return file.replace(/\.parquet$/i, '') || path;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

/** The gene names in `gene_panel.json` (controls and unassigned codewords are left out); empty if the file is not a panel. */
export function parseGenePanel(source: string): string[] {
	let json: unknown;
	try { json = JSON.parse(source.replace(/^\uFEFF/, '')); } catch { return []; }
	const payload = (json as { payload?: { targets?: unknown } } | null)?.payload;
	if (!payload || !Array.isArray(payload.targets)) { return []; }
	const names = new Set<string>();
	for (const target of payload.targets as { type?: { descriptor?: unknown; data?: { name?: unknown } } }[]) {
		const name = target?.type?.data?.name;
		if (target?.type?.descriptor === 'gene' && typeof name === 'string' && name.trim()) { names.add(name.trim()); }
	}
	return [...names];
}

/** Parse `experiment.xenium`. Throws a message fit to show the user. */
export function parseExperiment(source: string): XeniumExperiment {
	let json: unknown;
	try { json = JSON.parse(source.replace(/^﻿/, '')); }
	catch { throw new Error('experiment.xenium is not valid JSON.'); }
	if (!json || typeof json !== 'object' || Array.isArray(json)) { throw new Error('experiment.xenium is not a Xenium manifest.'); }
	const record = json as Record<string, unknown>;
	const pixelSizeUm = Number(record.pixel_size);
	if (!(pixelSizeUm > 0) || !Number.isFinite(pixelSizeUm)) { throw new Error('experiment.xenium has no usable "pixel_size".'); }
	const images = record.images && typeof record.images === 'object' ? record.images as Record<string, unknown> : {};
	const numCells = Number(record.num_cells);
	return {
		pixelSizeUm,
		runName: text(record.run_name),
		regionName: text(record.region_name),
		numCells: Number.isFinite(numCells) && numCells >= 0 ? numCells : undefined,
		morphologyFocusPath: text(images.morphology_focus_filepath)?.replace(/\\/g, '/'),
	};
}

/** The folder part of a bundle-relative path, '' for a file at the top. */
export function folderOf(relativePath: string): string {
	const slash = relativePath.lastIndexOf('/');
	return slash < 0 ? '' : relativePath.slice(0, slash);
}

/** `ch0001_atp1a1_cd45_e-cadherin.ome.tif` -> index 1, name "atp1a1 cd45 e-cadherin". */
function describeChannelFile(fileName: string): { index: number; fallbackName: string } | null {
	const numbered = /^ch(\d+)_(.+?)\.ome\.tiff?$/i.exec(fileName);
	if (numbered) { return { index: Number(numbered[1]), fallbackName: numbered[2].replace(/[_]+/g, ' ') }; }
	const plain = /^morphology_focus_(\d+)\.ome\.tiff?$/i.exec(fileName);
	if (plain) { return { index: Number(plain[1]), fallbackName: `Channel ${Number(plain[1]) + 1}` }; }
	return null;
}

/**
 * The channel files of a bundle, in channel order.
 *
 * `listing` is the file names found in the folder of `morphologyFocusPath`.
 * Throws for a bundle that has no morphology_focus images (older bundles keep a
 * single `morphology.ome.tif` z-stack, which this viewer does not read).
 */
export function discoverChannelFiles(experiment: XeniumExperiment, listing: readonly string[]): XeniumChannelFile[] {
	const path = experiment.morphologyFocusPath;
	if (!path) { throw new Error('This Xenium bundle has no morphology_focus images (experiment.xenium lists none). Only morphology_focus bundles are supported.'); }
	const folder = folderOf(path);
	const prefix = folder ? `${folder}/` : '';
	const found = listing
		.map(fileName => ({ fileName, described: describeChannelFile(fileName) }))
		.filter((entry): entry is { fileName: string; described: { index: number; fallbackName: string } } => entry.described !== null)
		.sort((a, b) => a.described.index - b.described.index || a.fileName.localeCompare(b.fileName));
	if (found.length === 0) {
		// The listed file alone is still a viewable (single channel) image.
		const only = path.slice(prefix.length);
		return [{ index: 0, fileName: only, relativePath: path, fallbackName: only.replace(/\.ome\.tiff?$/i, '') }];
	}
	return found.map(({ fileName, described }) => ({
		index: described.index, fileName, relativePath: `${prefix}${fileName}`, fallbackName: described.fallbackName,
	}));
}

/** Cell files at the top of the bundle, by name. */
export function discoverCellFiles(
	rootListing: readonly string[],
	toSrc: (relativePath: string) => string,
): SceneManifest['cells'] | undefined {
	const has = (name: string) => rootListing.includes(name);
	if (!has('cells.parquet') || !has('cell_boundaries.parquet')) { return undefined; }
	return {
		cells: toSrc('cells.parquet'),
		cellBoundaries: toSrc('cell_boundaries.parquet'),
		nucleusBoundaries: has('nucleus_boundaries.parquet') ? toSrc('nucleus_boundaries.parquet') : undefined,
	};
}

export function buildSceneManifest(
	experiment: XeniumExperiment,
	files: readonly XeniumChannelFile[],
	toSrc: (relativePath: string) => string,
	title: string,
): SceneManifest {
	return {
		kind: 'xenium',
		title,
		pixelSizeUm: experiment.pixelSizeUm,
		run: { name: experiment.runName, region: experiment.regionName, cells: experiment.numCells },
		channels: files.map(file => ({ id: `channel-${file.index}`, fileName: file.fileName, src: toSrc(file.relativePath), fallbackName: file.fallbackName })),
	};
}

export interface OmeChannelHint {
	name: string;
	/** Xenium's stain purpose: "Nuclear", "Boundary", "Interior - RNA", ... */
	purpose?: string;
	/** The instrument's suggested display range, in raw units. */
	lutMin?: number;
	lutMax?: number;
	/** File holding this channel, from the OME TiffData/UUID mapping. */
	fileName?: string;
}

function decodeXml(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
		const lower = entity.toLowerCase();
		if (lower === 'amp') { return '&'; }
		if (lower === 'lt') { return '<'; }
		if (lower === 'gt') { return '>'; }
		if (lower === 'quot') { return '"'; }
		if (lower === 'apos') { return "'"; }
		const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
		return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
	});
}

function attribute(tag: string, name: string): string | undefined {
	const match = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`).exec(tag);
	return match ? decodeXml(match[2]) : undefined;
}

function finite(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === '') { return undefined; }
	const number = Number(value);
	return Number.isFinite(number) ? number : undefined;
}

/**
 * Channel names, ranges and files from an OME-XML document.
 *
 * Channel `i` is joined to its `MapAnnotation` through the `AnnotationRef` it
 * contains, and to its file through the `TiffData` whose `FirstC` is `i`. Parts
 * the document lacks are simply absent, so a plain OME-TIFF still yields names.
 */
export function omeChannelHints(xml: string | undefined | null): OmeChannelHint[] {
	if (!xml) { return []; }
	const annotations = new Map<string, Record<string, string>>();
	for (const match of xml.matchAll(/<(?:[\w.-]+:)?MapAnnotation\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?MapAnnotation\s*>/gi)) {
		const id = attribute(match[1], 'ID');
		if (!id) { continue; }
		const values: Record<string, string> = {};
		for (const pair of match[2].matchAll(/<(?:[\w.-]+:)?M\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?M\s*>/gi)) {
			const key = attribute(pair[1], 'K');
			if (key) { values[key] = decodeXml(pair[2].trim()); }
		}
		annotations.set(id, values);
	}
	const fileByChannel = new Map<number, string>();
	for (const match of xml.matchAll(/<(?:[\w.-]+:)?TiffData\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?TiffData\s*>)/gi)) {
		const firstC = finite(attribute(match[1], 'FirstC')) ?? 0;
		const file = match[2] ? attribute(/<(?:[\w.-]+:)?UUID\b([^>]*)>/i.exec(match[2])?.[1] ?? '', 'FileName') : undefined;
		if (file && !fileByChannel.has(firstC)) { fileByChannel.set(firstC, file); }
	}
	const hints: OmeChannelHint[] = [];
	for (const match of xml.matchAll(/<(?:[\w.-]+:)?Channel\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?Channel\s*>)/gi)) {
		const index = hints.length;
		const name = attribute(match[1], 'Name') ?? attribute(match[1], 'Fluor') ?? `Channel ${index + 1}`;
		const ref = match[2] ? attribute(/<(?:[\w.-]+:)?AnnotationRef\b([^>]*)>/i.exec(match[2])?.[1] ?? '', 'ID') : undefined;
		const values = ref ? annotations.get(ref) : undefined;
		hints.push({
			name,
			purpose: values?.Purpose,
			lutMin: finite(values?.['Suggested LUT min']),
			lutMax: finite(values?.['Suggested LUT max']),
			fileName: fileByChannel.get(index),
		});
	}
	return hints;
}

/** Tints for Xenium's four stain purposes: distinct, with the nuclear stain in the usual blue. */
const PURPOSE_TINTS: Readonly<Record<string, string>> = {
	'nuclear': '#4da6ff',
	'boundary': '#ff5050',
	'interior - rna': '#50ff80',
	'interior - protein': '#ffb020',
};

export function purposeTint(purpose: string | undefined): string | undefined {
	return purpose ? PURPOSE_TINTS[purpose.trim().toLowerCase()] : undefined;
}
