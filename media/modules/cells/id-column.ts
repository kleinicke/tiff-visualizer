/** Which column of a table names the cell: `cell_id`, or a name from `tiffVisualizer.cells.cellIdCol`. */

export const DEFAULT_ID_COLUMN = 'cell_id';

/** The first of `cell_id` and the configured names that the table has (case-insensitive), as the table spells it. */
export function pickIdColumn(names: readonly string[], configured: readonly string[] = []): string | null {
	for (const wanted of [DEFAULT_ID_COLUMN, ...configured]) {
		const key = String(wanted).trim().toLowerCase();
		if (!key) { continue; }
		const found = names.find(name => name.trim().toLowerCase() === key);
		if (found !== undefined) { return found; }
	}
	return null;
}

export function missingIdColumnMessage(names: readonly string[]): string {
	const shown = names.slice(0, 10).join(', ') + (names.length > 10 ? ', …' : '');
	return `The file has no cell_id column (columns: ${shown || 'none'}). Add the name of the column that identifies the cell to tiffVisualizer.cells.cellIdCol in settings.json.`;
}

/** Spreadsheet exports write whole-number ids as 1.0 or " 1 "; masks and Parquet tables write 1. */
export function normalizeId(raw: string): string {
	const text = raw.trim();
	return /^[+-]?\d+\.0+$/.test(text) ? text.replace(/\.0+$/, '') : text;
}
