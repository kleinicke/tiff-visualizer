/** Join a metrics table onto another table by cell id. */

import { continuousColumn, discreteColumn, type CellColumn, type CellTable } from './cell-table.js';

export interface MergeResult {
	/** Names of the columns added to the target. */
	added: string[];
	/** Rows of `extra` whose id exists in the target. */
	matched: number;
	/** Rows in `extra`. */
	total: number;
}

/**
 * Add the columns of `extra` to `target`, aligned to the target's rows by
 * cell id and named `${label} · ${column}`. Target rows with no match get
 * NaN (numbers) or no category. Adds nothing when no id matches.
 */
export function mergeTable(target: CellTable, extra: CellTable, label: string): MergeResult {
	const targetRowOfExtra = new Int32Array(extra.count);
	let matched = 0;
	for (let row = 0; row < extra.count; row++) {
		const found = target.rowOfId.get(extra.ids[row]);
		targetRowOfExtra[row] = found === undefined ? -1 : found;
		if (found !== undefined) { matched++; }
	}
	const result: MergeResult = { added: [], matched, total: extra.count };
	if (matched === 0) { return result; }
	for (const column of extra.columns) {
		const name = `${label} · ${column.name}`;
		const aligned = alignColumn(column, name, target.count, targetRowOfExtra);
		if (aligned) { target.columns.push(aligned); result.added.push(name); }
	}
	return result;
}

function alignColumn(column: CellColumn, name: string, count: number, targetRowOfExtra: Int32Array): CellColumn | null {
	if (column.kind === 'continuous') {
		const values = new Float64Array(count).fill(NaN);
		for (let row = 0; row < targetRowOfExtra.length; row++) { if (targetRowOfExtra[row] >= 0) { values[targetRowOfExtra[row]] = column.values[row]; } }
		return continuousColumn(name, values);
	}
	const labels = new Array<string | null>(count).fill(null);
	for (let row = 0; row < targetRowOfExtra.length; row++) {
		if (targetRowOfExtra[row] >= 0 && column.codes[row] >= 0) { labels[targetRowOfExtra[row]] = column.labels[column.codes[row]]; }
	}
	return discreteColumn(name, labels);
}

/** Remove columns added by a merge. */
export function dropColumns(table: CellTable, names: readonly string[]): void {
	const drop = new Set(names);
	for (let index = table.columns.length - 1; index >= 0; index--) { if (drop.has(table.columns[index].name)) { table.columns.splice(index, 1); } }
}
