"use strict";

import { parsePageDirectory } from '../tiff-pages.js';
import { sceneLevels, type Rect, type SceneLevel } from './pyramid.js';

/**
 * One channel file of a scene: a pyramidal OME-TIFF read a rectangle at a time.
 *
 * The decoding happens in a worker of its own (`xenium-tile-worker.ts`), so four
 * channels decode in parallel and none of it touches the page. For now the
 * worker is given the whole file once; a rectangle read then costs only the
 * blocks it touches. Reading the file in ranges instead would change this class
 * and nothing that uses it.
 */

export interface RegionSamples {
	width: number;
	height: number;
	/** Raw samples; unsigned integer sources keep their integer type. */
	data: Uint8Array | Uint16Array | Float32Array;
}

interface Job {
	run: () => Promise<void>;
	signal?: AbortSignal;
	cancel: () => void;
}

function narrow(data: Float32Array, bitsPerSample: number, sampleFormat: number): RegionSamples['data'] {
	// sampleFormat 1 is unsigned integer. Keeping 8/16-bit sources in their own
	// type quarters/halves the memory of every cached tile.
	if (sampleFormat === 1 && bitsPerSample === 16) {
		const out = new Uint16Array(data.length);
		for (let i = 0; i < data.length; i++) { out[i] = data[i]; }
		return out;
	}
	if (sampleFormat === 1 && bitsPerSample === 8) {
		const out = new Uint8Array(data.length);
		for (let i = 0; i < data.length; i++) { out[i] = data[i]; }
		return out;
	}
	return data;
}

/** Create the tile worker from the bundle named in the page's vendor assets. */
async function createWorker(): Promise<Worker> {
	const url: string | undefined = (globalThis as any).__tiffVisualizerVendorAssets?.workers?.['xeniumTileWorker.bundle.js'];
	if (!url) { throw new Error('The tile decoder is not available in this page.'); }
	const response = await fetch(url);
	if (!response.ok) { throw new Error(`Could not load the tile decoder (HTTP ${response.status}).`); }
	const blobUrl = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
	const worker = new Worker(blobUrl, { type: 'module' });
	// The worker keeps running from the blob; the URL itself is no longer needed.
	setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
	return worker;
}

export class TiffChannelSource {
	readonly levels: SceneLevel[];
	readonly description: string | undefined;
	/** How many SubIFD levels had to be linked to read the pyramid. */
	readonly linkedLevels: number;
	private readonly worker: Worker;
	private readonly waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	private readonly queue: Job[] = [];
	private nextId = 1;
	private busy = false;
	private disposed = false;

	private constructor(worker: Worker, levels: SceneLevel[], description: string | undefined, linkedLevels: number) {
		this.worker = worker;
		this.levels = levels;
		this.description = description;
		this.linkedLevels = linkedLevels;
		worker.onmessage = event => this.settle(event.data);
		worker.onerror = event => this.failAll(new Error(event.message || 'The tile decoder stopped.'));
	}

	/** Fetch `src`, hand it to a new worker and read its level directory. */
	static async open(src: string, codecModule: WebAssembly.Module, signal?: AbortSignal): Promise<TiffChannelSource> {
		const worker = await createWorker();
		const call = (message: Record<string, unknown>, transfer: Transferable[] = []) => new Promise<any>((resolve, reject) => {
			const id = Math.random();
			const handler = (event: MessageEvent) => {
				if (event.data?.id !== id) { return; }
				worker.removeEventListener('message', handler);
				event.data.ok ? resolve(event.data) : reject(new Error(String(event.data.error || 'Decoder failed')));
			};
			worker.addEventListener('message', handler);
			worker.postMessage({ id, ...message }, transfer);
		});
		try {
			await call({ type: 'init', module: codecModule });
			const response = await fetch(src, { signal });
			if (!response.ok) { throw new Error(`Could not read ${src.split('/').pop()} (HTTP ${response.status}).`); }
			const bytes = await response.arrayBuffer();
			const opened = await call({ type: 'open', bytes }, [bytes]);
			const levels = sceneLevels(parsePageDirectory(opened.directory));
			if (levels.length === 0) { throw new Error('The file has no readable image.'); }
			return new TiffChannelSource(worker, levels, opened.description, Number(opened.linkedLevels) || 0);
		} catch (error) {
			worker.terminate();
			throw error;
		}
	}

	/** Read `rect` (in the level's own pixels) of `levels[levelPosition]`. */
	readRegion(levelPosition: number, rect: Rect, signal?: AbortSignal): Promise<RegionSamples> {
		const level = this.levels[levelPosition];
		if (!level) { return Promise.reject(new Error(`No level ${levelPosition}`)); }
		return new Promise<RegionSamples>((resolve, reject) => {
			const abort = () => reject(new DOMException('Region read cancelled', 'AbortError'));
			const job: Job = {
				signal,
				cancel: abort,
				run: async () => {
					if (signal?.aborted) { return abort(); }
					try {
						const result = await this.request({ type: 'region', page: level.index, ...rect });
						resolve({ width: result.width, height: result.height, data: narrow(result.data, result.bitsPerSample, result.sampleFormat) });
					} catch (error) { reject(error); }
				},
			};
			this.queue.push(job);
			void this.pump();
		});
	}

	private async pump(): Promise<void> {
		if (this.busy) { return; }
		this.busy = true;
		try {
			// One request at a time keeps the worker's queue empty, so a read that
			// stops being wanted is dropped here instead of decoding for nothing.
			while (this.queue.length && !this.disposed) {
				const job = this.queue.shift()!;
				if (job.signal?.aborted) { job.cancel(); continue; }
				await job.run();
			}
		} finally { this.busy = false; }
	}

	private request(message: Record<string, unknown>): Promise<any> {
		return new Promise((resolve, reject) => {
			const id = this.nextId++;
			this.waiting.set(id, { resolve, reject });
			this.worker.postMessage({ id, ...message });
		});
	}

	private settle(data: any): void {
		const entry = this.waiting.get(data?.id);
		if (!entry) { return; }
		this.waiting.delete(data.id);
		data.ok ? entry.resolve(data) : entry.reject(new Error(String(data.error || 'Decoder failed')));
	}

	private failAll(error: Error): void {
		for (const entry of this.waiting.values()) { entry.reject(error); }
		this.waiting.clear();
	}

	dispose(): void {
		this.disposed = true;
		for (const job of this.queue.splice(0)) { job.cancel(); }
		this.failAll(new Error('Closed'));
		this.worker.terminate();
	}
}
