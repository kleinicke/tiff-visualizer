/**
 * Reads a Xenium bundle's cell table and outlines off the UI thread and
 * hands back typed arrays.
 *
 *   load { cells, cellBoundaries, nucleusBoundaries?, pixelSizeUm }
 *     -> { table, cells, nuclei }
 */

import { readParquetColumns, toFloat64, toStrings } from './modules/cells/parquet-reader.js';
import { buildCellTable } from './modules/cells/cell-table.js';
import { buildPolygonSet, type PolygonSet } from './modules/cells/polygon-set.js';
import { addShapeColumns } from './modules/cells/cells-derived.js';

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
	const response = await fetch(url);
	if (!response.ok) { throw new Error(`Could not read ${url.split('/').pop()} (${response.status})`); }
	return response.arrayBuffer();
}

async function boundaries(url: string, rowOfId: (id: string) => number, scale: number): Promise<PolygonSet> {
	const columns = await readParquetColumns(await fetchBuffer(url), ['cell_id', 'vertex_x', 'vertex_y']);
	const ids = columns.get('cell_id'), xs = columns.get('vertex_x'), ys = columns.get('vertex_y');
	if (!ids || !xs || !ys) { throw new Error('The boundary file has no cell_id, vertex_x and vertex_y columns.'); }
	return buildPolygonSet(toStrings(ids), toFloat64(xs), toFloat64(ys), rowOfId, scale);
}

function transferables(set: PolygonSet | null): ArrayBuffer[] {
	return set ? [set.offsets.buffer as ArrayBuffer, set.xy.buffer as ArrayBuffer, set.bounds.buffer as ArrayBuffer, set.rows.buffer as ArrayBuffer] : [];
}

self.onmessage = async (event: MessageEvent): Promise<void> => {
	const { id, type } = event.data ?? {};
	try {
		if (type !== 'load') { throw new Error(`unknown message ${String(type)}`); }
		const { cells, cellBoundaries, nucleusBoundaries, pixelSizeUm } = event.data as {
			cells: string; cellBoundaries: string; nucleusBoundaries?: string; pixelSizeUm: number;
		};
		const table = buildCellTable(await readParquetColumns(await fetchBuffer(cells)));
		const rowOfId = (cellId: string): number => table.rowOfId.get(cellId) ?? -1;
		const scale = 1 / pixelSizeUm;
		const cellSet = await boundaries(cellBoundaries, rowOfId, scale);
		const nucleusSet = nucleusBoundaries ? await boundaries(nucleusBoundaries, rowOfId, scale).catch((): null => null) : null;
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
