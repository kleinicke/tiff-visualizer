/** Main-thread side of the Xenium cell loader: owns the worker, returns plain data. */

import type { CellTable } from '../cells/cell-table.js';
import type { PolygonSet } from '../cells/polygon-set.js';
import type { GenePoints, TranscriptIndex } from '../transcripts/transcript-data.js';
import { RangeUnavailable, readRange } from '../ranged-source.js';

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

/** A worker whose blob URL stays valid, so the worker can start copies of itself. */
async function createTranscriptWorker(): Promise<{ worker: Worker; url: string }> {
	const source: string | undefined = (globalThis as { __tiffVisualizerVendorAssets?: { workers?: Record<string, string> } }).__tiffVisualizerVendorAssets?.workers?.['xeniumCellsWorker.bundle.js'];
	if (!source) { throw new Error('The cell loader is not available in this build.'); }
	const response = await fetch(source);
	if (!response.ok) { throw new Error(`Could not load the cell loader (${response.status}).`); }
	const url = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
	return { worker: new Worker(url, { type: 'module' }), url };
}

/**
 * Decoder workers to add beside the loader: leave cores for the page and the loader itself.
 * For experiments, set `__tiffVisualizerDecoderWorkers` (0 = decode in one thread) in the
 * webview's developer console before the transcripts are loaded.
 */
function decoderCount(): number {
	const forced = (globalThis as { __tiffVisualizerDecoderWorkers?: unknown }).__tiffVisualizerDecoderWorkers;
	if (typeof forced === 'number' && Number.isFinite(forced)) { return Math.max(0, Math.min(32, Math.floor(forced))); }
	const cores = typeof navigator === 'undefined' ? 0 : navigator.hardwareConcurrency || 0;
	const count = Math.min(8, cores - 2);
	return count >= 2 ? count : 0;
}

/** The compiled transcripts decoder, or null if it can't be loaded (the JS reader is used then). */
async function loadTranscriptsWasm(): Promise<WebAssembly.Module | null> {
	const url: string | undefined = (globalThis as { __tiffVisualizerVendorAssets?: { transcriptsWasm?: string } }).__tiffVisualizerVendorAssets?.transcriptsWasm;
	if (!url || (globalThis as { __tiffVisualizerNativeDecoder?: unknown }).__tiffVisualizerNativeDecoder === false) { return null; }
	try {
		const response = await fetch(url);
		return response.ok ? await WebAssembly.compile(await response.arrayBuffer()) : null;
	} catch { return null; }
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

export type LoadedSource =
	| { kind: 'table'; table: CellTable }
	| { kind: 'boundaries'; table: CellTable; cells: PolygonSet };

/** A metrics table or a boundaries file: from a webview URI, or from bytes the host already read. */
export async function loadCellSource(
	input: { src?: string; bytes?: ArrayBuffer; kind: 'table' | 'boundaries' | 'unknown' },
	pixelSizeUm: number,
): Promise<LoadedSource> {
	const buffer = input.bytes?.slice(0) ?? (input.src ? await fetchBuffer(input.src) : null);
	if (!buffer) { throw new Error('There is nothing to read.'); }
	const worker = await createWorker();
	try {
		return await new Promise<LoadedSource>((resolve, reject) => {
			worker.onerror = event => reject(new Error(event.message || 'The cell loader failed.'));
			worker.onmessage = (event: MessageEvent) => {
				const data = event.data;
				if (!data?.ok) { reject(new Error(String(data?.error ?? 'The file could not be read.'))); return; }
				const rowOfId = new Map<string, number>();
				(data.table.ids as string[]).forEach((id, row) => rowOfId.set(id, row));
				const table: CellTable = { ...data.table, rowOfId };
				resolve(data.kind === 'boundaries' ? { kind: 'boundaries', table, cells: data.cells } : { kind: 'table', table });
			};
			worker.postMessage({ id: 1, type: 'source', buffer, kind: input.kind, pixelSizeUm }, [buffer]);
		});
	} finally { worker.terminate(); }
}

/**
 * A transcripts.parquet read in pieces by a worker that asks this page for byte
 * ranges (the worker cannot fetch webview resources itself). Hosts that do not
 * answer Range requests fall back to one whole-file read, which only suits
 * small files.
 */
export class TranscriptSource {
	private worker: Worker | null = null;
	private workerUrl: string | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private whole: Promise<ArrayBuffer> | null = null;
	private ranged = true;
	private waiting = new Map<number, { resolve: (data: any) => void; reject: (error: Error) => void; progress?: (done: number, total: number) => void }>();
	private counter = 0;

	constructor(private readonly src: string, private readonly pixelSizeUm: number) {}

	private async slice(start: number, end: number): Promise<ArrayBuffer> {
		if (this.ranged) {
			try {
				const { bytes } = await readRange(this.src, start, end - start);
				return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
			} catch (error) {
				if (!(error instanceof RangeUnavailable)) { throw error; }
				this.ranged = false;
			}
		}
		this.whole ??= fetchBuffer(this.src);
		return (await this.whole).slice(start, end);
	}

	private async size(): Promise<number> {
		try { return (await readRange(this.src, 0, 1)).total; }
		catch (error) {
			if (!(error instanceof RangeUnavailable)) { throw error; }
			this.ranged = false;
			this.whole ??= fetchBuffer(this.src);
			return (await this.whole).byteLength;
		}
	}

	private async start(): Promise<Worker> {
		if (this.worker) { return this.worker; }
		const { worker, url } = await createTranscriptWorker();
		this.workerUrl = url;
		worker.onerror = event => this.fail(new Error(event.message || 'The transcript loader failed.'));
		worker.onmessage = (event: MessageEvent) => {
			const data = event.data;
			if (data?.type === 'range') {
				this.slice(data.start, data.end).then(
					buffer => worker.postMessage({ type: 'rangeData', rid: data.rid, buffer }, [buffer]),
					(error: unknown) => worker.postMessage({ type: 'rangeData', rid: data.rid, error: error instanceof Error ? error.message : String(error) }),
				);
				return;
			}
			const waiter = this.waiting.get(data?.id);
			if (!waiter) { return; }
			if (data.type === 'progress') { waiter.progress?.(data.done, data.total); return; }
			this.waiting.delete(data.id);
			if (data.ok) { waiter.resolve(data); } else { waiter.reject(new Error(String(data.error ?? 'The transcripts could not be read.'))); }
		};
		this.worker = worker;
		return worker;
	}

	private fail(error: Error): void {
		for (const waiter of this.waiting.values()) { waiter.reject(error); }
		this.waiting.clear();
	}

	/** One request at a time: the worker keeps the open file's state. */
	private request<T>(message: Record<string, unknown>, progress?: (done: number, total: number) => void): Promise<T> {
		const run = async (): Promise<T> => {
			const worker = await this.start();
			return new Promise<T>((resolve, reject) => {
				const id = ++this.counter;
				this.waiting.set(id, { resolve, reject, progress });
				worker.postMessage({ ...message, id });
			});
		};
		const result = this.queue.then(run, run);
		this.queue = result.catch((): void => undefined);
		return result;
	}

	/** Genes and their counts, from one pass over the gene column. */
	async open(progress?: (done: number, total: number) => void): Promise<TranscriptIndex> {
		await this.start(); // the worker's URL goes into the message below, so it must exist first
		const [size, wasm] = await Promise.all([this.size(), loadTranscriptsWasm()]);
		return (await this.request<{ index: TranscriptIndex }>({ type: 'txOpen', size, pixelSizeUm: this.pixelSizeUm, workerUrl: this.workerUrl, poolSize: decoderCount(), wasm }, progress)).index;
	}

	/** The points of the named genes (scene pixels, sorted by x). */
	async genes(names: string[], progress?: (done: number, total: number) => void): Promise<Map<string, GenePoints>> {
		return new Map((await this.request<{ genes: [string, GenePoints][] }>({ type: 'txGenes', names }, progress)).genes);
	}

	dispose(): void {
		this.worker?.terminate(); this.worker = null;
		if (this.workerUrl) { URL.revokeObjectURL(this.workerUrl); this.workerUrl = null; }
		this.fail(new Error('Closed'));
	}
}
