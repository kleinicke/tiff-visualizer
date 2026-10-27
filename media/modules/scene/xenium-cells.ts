/** Main-thread side of the Xenium cell loader: owns the worker, returns plain data. */

import type { CellTable } from '../cells/cell-table.js';
import type { PolygonSet } from '../cells/polygon-set.js';

export interface XeniumCellFiles { cells: string; cellBoundaries: string; nucleusBoundaries?: string }

export interface LoadedCells { table: CellTable; cells: PolygonSet; nuclei: PolygonSet | null }

async function createWorker(): Promise<Worker> {
	const url: string | undefined = (globalThis as { __tiffVisualizerVendorAssets?: { workers?: Record<string, string> } }).__tiffVisualizerVendorAssets?.workers?.['xeniumCellsWorker.bundle.js'];
	if (!url) { throw new Error('The cell loader is not available in this build.'); }
	const response = await fetch(url);
	if (!response.ok) { throw new Error(`Could not load the cell loader (${response.status}).`); }
	const blobUrl = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
	const worker = new Worker(blobUrl, { type: 'module' });
	URL.revokeObjectURL(blobUrl);
	return worker;
}

async function fetchBuffer(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
	const response = await fetch(url, { signal });
	if (!response.ok) { throw new Error(`Could not read ${decodeURIComponent(url.split('/').pop() ?? url)} (${response.status})`); }
	return response.arrayBuffer();
}

export async function loadXeniumCells(files: XeniumCellFiles, pixelSizeUm: number, signal?: AbortSignal): Promise<LoadedCells> {
	// Fetched here, on the page, then handed over: see the note in the worker.
	const [cells, cellBoundaries, nucleusBoundaries] = await Promise.all([
		fetchBuffer(files.cells, signal),
		fetchBuffer(files.cellBoundaries, signal),
		files.nucleusBoundaries ? fetchBuffer(files.nucleusBoundaries, signal).catch((): undefined => undefined) : Promise.resolve(undefined),
	]);
	const worker = await createWorker();
	try {
		return await new Promise<LoadedCells>((resolve, reject) => {
			const abort = (): void => reject(new Error('Cancelled'));
			if (signal?.aborted) { abort(); return; }
			signal?.addEventListener('abort', abort, { once: true });
			worker.onerror = event => reject(new Error(event.message || 'The cell loader failed.'));
			worker.onmessage = (event: MessageEvent) => {
				const data = event.data;
				if (!data?.ok) { reject(new Error(String(data?.error ?? 'The cells could not be read.'))); return; }
				const rowOfId = new Map<string, number>();
				(data.table.ids as string[]).forEach((id, row) => rowOfId.set(id, row));
				resolve({ table: { ...data.table, rowOfId }, cells: data.cells, nuclei: data.nuclei });
			};
			const transfer = [cells, cellBoundaries, ...(nucleusBoundaries ? [nucleusBoundaries] : [])];
			worker.postMessage({ id: 1, type: 'load', cells, cellBoundaries, nucleusBoundaries, pixelSizeUm }, transfer);
		});
	} finally { worker.terminate(); }
}
