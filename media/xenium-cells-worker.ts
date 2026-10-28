/**
 * Reads a Xenium bundle's cell table and outlines off the UI thread and
 * hands back typed arrays.
 *
 *   load { cells, cellBoundaries, nucleusBoundaries?, pixelSizeUm }   (file contents as ArrayBuffers)
 *     -> { table, cells, nuclei }
 *   txOpen { size, pixelSizeUm, workerUrl?, poolSize? }   (transcripts.parquet, read through `range` requests the page answers;
 *                                                         with workerUrl, up to poolSize copies of this worker decode row groups in parallel)
 *     -> { index }   (genes and counts, from one pass over the gene column)
 *   txGenes { names }
 *     -> { genes: [name, points][] }   (points in scene pixels, sorted by x)
 *   source { buffer, kind, pixelSizeUm }   (one more file: a metrics table or a boundaries file)
 *     -> { kind: 'table', table } | { kind: 'boundaries', table, cells }
 *
 * The files are fetched by the page, not here: webview resources are served
 * through the page's service worker, which does not answer requests made from
 * a blob worker.
 */

import { parquetColumnNames, readParquetColumns } from './modules/cells/parquet-reader.js';
import { toFloat64, toStrings } from './modules/cells/column-values.js';
import { buildCellTable } from './modules/cells/cell-table.js';
import { buildPolygonSet, buildPolygonSetFromLabels, type PolygonSet } from './modules/cells/polygon-set.js';
import { readPlainColumns } from './modules/cells/parquet-fast.js';
import type { CellTable } from './modules/cells/cell-table.js';
import { addShapeColumns } from './modules/cells/cells-derived.js';
import { closeTranscripts, openTranscripts, readGenes, type DecoderSetup, type RangeFile, type TranscriptHandle } from './modules/transcripts/transcript-reader.js';
import { DecoderHost, createPool, type PoolWorker } from './modules/transcripts/transcript-pool.js';

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

/**
 * A boundaries file with no table of its own: the cells are the distinct ids
 * in file order, and the table holds only what the outlines can tell.
 */
async function standaloneBoundaries(file: ArrayBuffer, scale: number): Promise<{ table: CellTable; cells: PolygonSet }> {
	const ids = toStrings((await readParquetColumns(file, ['cell_id'])).get('cell_id') ?? []);
	if (ids.length === 0) { throw new Error('The boundary file has no vertices.'); }
	let cells: PolygonSet | null = null;
	try {
		const columns = readPlainColumns(file, ['label_id', 'vertex_x', 'vertex_y']);
		const labels = columns.get('label_id') as Int32Array;
		let consistent = labels.length === ids.length;
		for (let index = 1; consistent && index < labels.length; index++) {
			if ((labels[index] !== labels[index - 1]) !== (ids[index] !== ids[index - 1]) || labels[index] < labels[index - 1]) { consistent = false; }
		}
		if (consistent) {
			const rowOfLabel = new Map<number, number>();
			for (let index = 0; index < labels.length; index++) { if (index === 0 || labels[index] !== labels[index - 1]) { rowOfLabel.set(labels[index], rowOfLabel.size); } }
			cells = buildPolygonSetFromLabels(labels, columns.get('vertex_x')!, columns.get('vertex_y')!, label => rowOfLabel.get(label) ?? -1, scale);
		}
	} catch { cells = null; }
	if (!cells) {
		const columns = await readParquetColumns(file, ['vertex_x', 'vertex_y']);
		const rowOfId = new Map<string, number>();
		cells = buildPolygonSet(ids, toFloat64(columns.get('vertex_x') ?? []), toFloat64(columns.get('vertex_y') ?? []), id => {
			let row = rowOfId.get(id);
			if (row === undefined) { row = rowOfId.size; rowOfId.set(id, row); }
			return row;
		}, scale);
	}
	const polygonIds = new Array<string>(cells.count);
	for (let polygon = 0; polygon < cells.count; polygon++) { polygonIds[polygon] = ids[cells.offsets[polygon]]; }
	return { table: { count: cells.count, ids: polygonIds, columns: [], rowOfId: new Map() }, cells };
}

function columnBuffers(table: CellTable): ArrayBuffer[] {
	return table.columns.map(column => (column.kind === 'continuous' ? column.values : column.codes).buffer as ArrayBuffer);
}

async function readSource(buffer: ArrayBuffer, declared: string, pixelSizeUm: number): Promise<{ result: Record<string, unknown>; buffers: ArrayBuffer[] }> {
	const names = parquetColumnNames(buffer);
	const kind = names.includes('vertex_x') && names.includes('vertex_y') ? 'boundaries' : 'table';
	if (declared !== 'unknown' && declared !== kind) {
		throw new Error(kind === 'boundaries' ? 'This file has vertex_x and vertex_y columns, so it is a boundaries file, not a table.' : 'This file has no vertex_x and vertex_y columns, so it is a table, not a boundaries file.');
	}
	if (!names.includes('cell_id')) { throw new Error('The file has no cell_id column.'); }
	if (kind === 'table') {
		const table = buildCellTable(await readParquetColumns(buffer));
		return { result: { kind, table: { count: table.count, ids: table.ids, columns: table.columns } }, buffers: columnBuffers(table) };
	}
	const { table, cells } = await standaloneBoundaries(buffer, 1 / pixelSizeUm);
	addShapeColumns(table, cells, pixelSizeUm);
	return { result: { kind, table: { count: table.count, ids: table.ids, columns: table.columns }, cells }, buffers: [...transferables(cells), ...columnBuffers(table)] };
}

let transcripts: TranscriptHandle | null = null;
const rangeWaiters = new Map<number, { resolve: (buffer: ArrayBuffer) => void; reject: (error: Error) => void }>();
let rangeCounter = 0;

const decoderHost = new DecoderHost(byteLength => rangeFile(byteLength));

/** A file the page reads for us: webview resources cannot be fetched from a blob worker. */
function rangeFile(byteLength: number): RangeFile {
	return {
		byteLength,
		slice: (start, end) => new Promise<ArrayBuffer>((resolve, reject) => {
			const rid = ++rangeCounter;
			rangeWaiters.set(rid, { resolve, reject });
			(self as unknown as Worker).postMessage({ type: 'range', rid, start, end: end ?? byteLength });
		}),
	};
}

self.onmessage = async (event: MessageEvent): Promise<void> => {
	const { id, type } = event.data ?? {};
	if (type === 'rangeData') {
		const waiter = rangeWaiters.get(event.data.rid);
		rangeWaiters.delete(event.data.rid);
		if (event.data.error) { waiter?.reject(new Error(String(event.data.error))); } else { waiter?.resolve(event.data.buffer as ArrayBuffer); }
		return;
	}
	if (typeof type === 'string' && type.startsWith('dec')) {
		const out = await decoderHost.handle(event.data);
		if (out) { (self as unknown as Worker).postMessage(out.reply, out.transfer); }
		return;
	}
	try {
		if (type === 'source') {
			const { buffer, kind, pixelSizeUm } = event.data as { buffer: ArrayBuffer; kind: string; pixelSizeUm: number };
			const { result, buffers } = await readSource(buffer, kind, pixelSizeUm);
			(self as unknown as Worker).postMessage({ id, ok: true, ...result }, buffers);
			return;
		}
		if (type === 'txOpen') {
			const { size, pixelSizeUm, workerUrl, poolSize } = event.data as { size: number; pixelSizeUm: number; workerUrl?: string; poolSize?: number };
			if (transcripts) { closeTranscripts(transcripts); }
			const file = rangeFile(size);
			// Row groups are decoded by sibling workers made from the same script; the page's blob URL stays alive for them.
			const decoders = workerUrl && poolSize ? (setup: DecoderSetup) => setup.groups.length < 2 ? null : createPool(setup, file, () => new Worker(workerUrl, { type: 'module' }) as unknown as PoolWorker, Math.min(poolSize, setup.groups.length)) : undefined;
			const opening = performance.now();
			transcripts = await openTranscripts(file, 1 / pixelSizeUm, (done, total) => (self as unknown as Worker).postMessage({ type: 'progress', id, done, total }), decoders);
			console.info(`[transcripts] opened ${transcripts.groups.length} row groups in ${((performance.now() - opening) / 1000).toFixed(2)} s, ${transcripts.decoder ? `${transcripts.decoder.size} decoder workers` : 'decoding in one thread'}${workerUrl ? '' : ' (no worker URL)'}, pool size asked ${poolSize ?? 0}`);
			(self as unknown as Worker).postMessage({ id, ok: true, index: transcripts.index });
			return;
		}
		if (type === 'txGenes') {
			if (!transcripts) { throw new Error('The transcripts file is not open.'); }
			const { names } = event.data as { names: string[] };
			const reading = performance.now();
			const genes = [...(await readGenes(transcripts, names, (done, total) => (self as unknown as Worker).postMessage({ type: 'progress', id, done, total }))).entries()];
			console.info(`[transcripts] read ${genes.length} genes (${genes.reduce((sum, [, points]) => sum + points.x.length, 0).toLocaleString()} points) in ${((performance.now() - reading) / 1000).toFixed(2)} s, ${transcripts.packed.size} row groups in memory`);
			(self as unknown as Worker).postMessage({ id, ok: true, genes }, genes.flatMap(([, points]) => [points.x.buffer as ArrayBuffer, points.y.buffer as ArrayBuffer, points.qv.buffer as ArrayBuffer]));
			return;
		}
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
