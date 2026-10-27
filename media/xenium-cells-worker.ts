/**
 * Reads a Xenium bundle's cell table and outlines off the UI thread and
 * hands back typed arrays.
 *
 *   load { cells, cellBoundaries, nucleusBoundaries?, pixelSizeUm }   (file contents as ArrayBuffers)
 *     -> { table, cells, nuclei }
 *
 * The files are fetched by the page, not here: webview resources are served
 * through the page's service worker, which does not answer requests made from
 * a blob worker.
 */

import { readParquetColumns } from './modules/cells/parquet-reader.js';
import { toFloat64, toStrings } from './modules/cells/column-values.js';
import { buildCellTable } from './modules/cells/cell-table.js';
import { buildPolygonSet, buildPolygonSetFromLabels, type PolygonSet } from './modules/cells/polygon-set.js';
import { readPlainColumns } from './modules/cells/parquet-fast.js';
import type { CellTable } from './modules/cells/cell-table.js';
import { addShapeColumns } from './modules/cells/cells-derived.js';

/** How many leading rows to compare against the table when trusting label_id = row + 1. */
const CHECK_ROWS = 5000;

/**
 * Typed-array route: group vertices by label_id and take a cell's row to be
 * label_id - 1, which holds when the boundary file follows the table order.
 * That is checked on the first rows (cell ids) and on label order before it
 * is trusted; null means "use the general route".
 */
async function fastBoundaries(file: ArrayBuffer, table: CellTable, scale: number): Promise<PolygonSet | null> {
	let columns;
	try { columns = readPlainColumns(file, ['label_id', 'vertex_x', 'vertex_y']); } catch { return null; }
	const labels = columns.get('label_id') as Int32Array, xs = columns.get('vertex_x')!, ys = columns.get('vertex_y')!;
	for (let index = 1; index < labels.length; index++) { if (labels[index] < labels[index - 1]) { return null; } }
	if (labels.length === 0 || labels[0] < 1 || labels[labels.length - 1] > table.count) { return null; }
	const head = await readParquetColumns(file, ['cell_id'], Math.min(CHECK_ROWS, labels.length));
	const headIds = toStrings(head.get('cell_id') ?? []);
	for (let index = 0; index < headIds.length; index++) {
		if (index > 0 && labels[index] === labels[index - 1]) { continue; }
		if (table.ids[labels[index] - 1] !== headIds[index]) { return null; }
	}
	return buildPolygonSetFromLabels(labels, xs, ys, label => label >= 1 && label <= table.count ? label - 1 : -1, scale);
}

async function slowBoundaries(file: ArrayBuffer, rowOfId: (id: string) => number, scale: number): Promise<PolygonSet> {
	const columns = await readParquetColumns(file, ['cell_id', 'vertex_x', 'vertex_y']);
	const ids = columns.get('cell_id'), xs = columns.get('vertex_x'), ys = columns.get('vertex_y');
	if (!ids || !xs || !ys) { throw new Error('The boundary file has no cell_id, vertex_x and vertex_y columns.'); }
	return buildPolygonSet(toStrings(ids), toFloat64(xs), toFloat64(ys), rowOfId, scale);
}

async function boundaries(file: ArrayBuffer, table: CellTable, scale: number): Promise<PolygonSet> {
	return (await fastBoundaries(file, table, scale)) ?? slowBoundaries(file, id => table.rowOfId.get(id) ?? -1, scale);
}

function transferables(set: PolygonSet | null): ArrayBuffer[] {
	return set ? [set.offsets.buffer as ArrayBuffer, set.xy.buffer as ArrayBuffer, set.bounds.buffer as ArrayBuffer, set.rows.buffer as ArrayBuffer] : [];
}

self.onmessage = async (event: MessageEvent): Promise<void> => {
	const { id, type } = event.data ?? {};
	try {
		if (type !== 'load') { throw new Error(`unknown message ${String(type)}`); }
		const { cells, cellBoundaries, nucleusBoundaries, pixelSizeUm } = event.data as {
			cells: ArrayBuffer; cellBoundaries: ArrayBuffer; nucleusBoundaries?: ArrayBuffer; pixelSizeUm: number;
		};
		const table = buildCellTable(await readParquetColumns(cells));
		const scale = 1 / pixelSizeUm;
		const cellSet = await boundaries(cellBoundaries, table, scale);
		const nucleusSet = nucleusBoundaries ? await boundaries(nucleusBoundaries, table, scale).catch((): null => null) : null;
		addShapeColumns(table, cellSet, pixelSizeUm);
		const buffers: ArrayBuffer[] = [...transferables(cellSet), ...transferables(nucleusSet)];
		for (const column of table.columns) { buffers.push((column.kind === 'continuous' ? column.values : column.codes).buffer as ArrayBuffer); }
		(self as unknown as Worker).postMessage({
			id, ok: true,
			table: { count: table.count, ids: table.ids, columns: table.columns },
			cells: cellSet, nuclei: nucleusSet,
		}, buffers);
	} catch (error) {
		(self as unknown as Worker).postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
	}
};
