/** One row per cell, with named columns that are either categories or numbers. */

import { columnKind, toFloat64, toStrings } from './column-values.js';

export interface DiscreteColumn {
	kind: 'discrete';
	name: string;
	/** Category names, most common first. */
	labels: string[];
	/** Index into `labels` per row; -1 when missing. */
	codes: Int32Array;
	counts: number[];
}

export interface ContinuousColumn {
	kind: 'continuous';
	name: string;
	values: Float64Array;
	min: number;
	max: number;
	/** 1st and 99th percentile: a better first colour range than min and max. */
	low: number;
	high: number;
}

export type CellColumn = DiscreteColumn | ContinuousColumn;

export interface CellTable {
	count: number;
	ids: string[];
	columns: CellColumn[];
	rowOfId: Map<string, number>;
}

const MAX_CATEGORIES = 5000;
const MAX_INTEGER_CATEGORIES = 8;

export function percentile(sorted: Float64Array, fraction: number): number {
	if (sorted.length === 0) { return NaN; }
	const at = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
	return sorted[at];
}

export function continuousColumn(name: string, values: Float64Array): ContinuousColumn {
	const finite = values.filter(Number.isFinite).sort();
	return {
		kind: 'continuous', name, values,
		min: finite.length ? finite[0] : NaN, max: finite.length ? finite[finite.length - 1] : NaN,
		low: percentile(finite, 0.01), high: percentile(finite, 0.99),
	};
}

export function discreteColumn(name: string, labelsPerRow: ArrayLike<string | null>, order?: 'count' | 'numeric'): DiscreteColumn | null {
	const tally = new Map<string, number>();
	for (let row = 0; row < labelsPerRow.length; row++) {
		const label = labelsPerRow[row];
		if (label !== null) { tally.set(label, (tally.get(label) ?? 0) + 1); }
	}
	if (tally.size === 0 || tally.size > MAX_CATEGORIES) { return null; }
	const labels = [...tally.keys()];
	if (order === 'numeric') { labels.sort((a, b) => Number(a) - Number(b)); }
	else { labels.sort((a, b) => (tally.get(b) ?? 0) - (tally.get(a) ?? 0) || a.localeCompare(b)); }
	const code = new Map(labels.map((label, index) => [label, index]));
	const codes = new Int32Array(labelsPerRow.length);
	for (let row = 0; row < labelsPerRow.length; row++) {
		const label = labelsPerRow[row];
		codes[row] = label === null ? -1 : code.get(label)!;
	}
	return { kind: 'discrete', name, labels, codes, counts: labels.map(label => tally.get(label) ?? 0) };
}

/** Build a table from decoded Parquet columns; `cell_id` names the rows. */
export function buildCellTable(source: Map<string, ArrayLike<unknown>>, idColumn = 'cell_id'): CellTable {
	const ids = toStrings(source.get(idColumn) ?? []);
	const rowOfId = new Map<string, number>();
	ids.forEach((id, row) => rowOfId.set(id, row));
	const columns: CellColumn[] = [];
	for (const [name, values] of source) {
		if (name === idColumn) { continue; }
		const kind = columnKind(values);
		if (kind === 'empty') { continue; }
		if (kind === 'string' || kind === 'boolean') {
			const labels = Array.from(values, value => value === null || value === undefined ? null : String(value));
			const column = discreteColumn(name, labels);
			if (column) { columns.push(column); }
			continue;
		}
		const numbers = toFloat64(values);
		if (kind === 'integer') {
			const distinct = new Set<number>();
			for (const value of numbers) { if (Number.isFinite(value)) { distinct.add(value); if (distinct.size > MAX_INTEGER_CATEGORIES) { break; } } }
			if (distinct.size <= MAX_INTEGER_CATEGORIES) {
				const column = discreteColumn(name, Array.from(numbers, value => Number.isFinite(value) ? String(value) : null), 'numeric');
				if (column) { columns.push(column); continue; }
			}
		}
		columns.push(continuousColumn(name, numbers));
	}
	return { count: ids.length, ids, columns, rowOfId };
}

export function findColumn(table: CellTable, name: string | null): CellColumn | null {
	return name === null ? null : table.columns.find(column => column.name === name) ?? null;
}

export function formatNumber(value: number): string {
	if (!Number.isFinite(value)) { return '—'; }
	const magnitude = Math.abs(value);
	if (magnitude !== 0 && (magnitude < 0.01 || magnitude >= 100000)) { return value.toExponential(2); }
	return String(Math.round(value * 100) / 100);
}

export function formatValue(column: CellColumn, row: number): string {
	if (column.kind === 'discrete') { const code = column.codes[row]; return code < 0 ? '—' : column.labels[code]; }
	return formatNumber(column.values[row]);
}

/** Counts per bin between `low` and `high`, for the colour-range histogram. */
export function histogram(values: Float64Array, low: number, high: number, bins: number): number[] {
	const out = new Array<number>(bins).fill(0);
	const span = high - low;
	if (!(span > 0)) { return out; }
	for (const value of values) {
		if (!Number.isFinite(value)) { continue; }
		out[Math.max(0, Math.min(bins - 1, Math.floor((value - low) / span * bins)))]++;
	}
	return out;
}

/** A column of numbers keyed by polygon: NaN for rows without a polygon. */
export function derivedColumn(name: string, table: CellTable, compute: (row: number) => number): ContinuousColumn {
	const values = new Float64Array(table.count);
	for (let row = 0; row < table.count; row++) { values[row] = compute(row); }
	return continuousColumn(name, values);
}
