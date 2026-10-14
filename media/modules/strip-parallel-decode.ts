"use strict";
/**
 * Parallel TIFF decoding across a pool of workers, one range of units each.
 *
 * Blocks in a TIFF are compressed independently, so a contiguous run of them is
 * a self-contained unit of work. A UNIT here is one strip, or one whole tile
 * ROW: both are full-width bands of the image, so a worker's output drops into
 * the assembled image at a single offset. (A single tile would not qualify —
 * it covers only part of each row it touches.)
 *
 * `tiff_float_strip_plan` reports the layout from the IFD alone; this module
 * slices the file per worker so each one receives ONLY its own units'
 * compressed bytes (total bytes crossing the worker boundary is one file's
 * worth, not one copy per worker), then assembles the returned samples.
 *
 * Eligibility is decided in Rust: the plan is returned only for byte-aligned
 * layouts with predictor 1/2/3 and a supported block codec. Separate planes
 * are grouped into spatial bands in the plan. Orientation is fused into each
 * worker result, and common 8-bit CMYK is converted per range by the same Rust
 * routine as the whole-image path. Palette and CFA remain on that normal path.
 *
 * Falls back to `null` for anything it cannot handle; the caller then uses the
 * ordinary single-worker path.
 */
import { tiffFirstIfdPrefix, type TiffImageStream } from './tiff-stream-prefix.js';
import { cziTileJobs, mergeCziTile } from './czi-tile-merge.js';
import {
	MAX_PARALLEL_TIFF_WORKERS,
	MIN_PARALLEL_TIFF_PIXELS,
	MIN_PARALLEL_TIFF_STRIPS,
	parallelTiffWorkerCount,
	shouldUseParallelTiffPlan,
} from './tiff-parallel-policy.js';

/** Cap the pool: more workers than this stops helping and costs memory. */
const MAX_WORKERS = MAX_PARALLEL_TIFF_WORKERS;

/**
 * Which typed array the decoded samples arrive in.
 *
 * Mirrors `pickTiffArrayCtor` in tiff-processor: float or signed or >16-bit
 * needs a Float32Array carrier; other integers use the narrowest array that
 * holds the depth. Matching it matters twice over — the processor can then use
 * the interleaved buffer directly instead of rebuilding it, and the WebGL
 * renderer accepts integer data only in a Uint16Array.
 */
function carrierFor(bitsPerSample: number, sampleFormat: number): 'u8' | 'u16' | 'f32' | null {
	if (sampleFormat === 1 && bitsPerSample === 8) { return 'u8'; }
	if (sampleFormat === 1 && bitsPerSample === 16) { return 'u16'; }
	if (sampleFormat === 3 && bitsPerSample === 32) { return 'f32'; }
	// Signed, half-float, 64-bit and >16-bit integers all need widening, which
	// the f32 conversion path in Rust already does.
	return null;
}

/** Below this the page faults are too cheap to be worth moving. */
const PREFAULT_MIN_BYTES = 16 * 1024 * 1024;

/** Commits a fresh buffer's pages by writing zero (its current value) once per page. */
function prefaultPages(array: Float32Array | Uint16Array | Uint8Array): void {
	const stride = 4096 / array.BYTES_PER_ELEMENT;
	for (let i = 0; i < array.length; i += stride) { array[i] = 0; }
}

export interface StripParallelResult {
	width: number;
	height: number;
	channels: number;
	bitsPerSample: number;
	sampleFormat: number;
	compression: number;
	predictor: number;
	planarConfiguration: number;
	rowsPerStrip: number;
	stripCount: number;
	/** Tile geometry when the file was tiled; both zero for strips. */
	tileWidth: number;
	tileLength: number;
	tileCount: number;
	photometricInterpretation: number;
	pageCount: number;
	allTagsJson: string;
	omeXml: string | undefined;
	geoJson: string | undefined;
	pageDirectoryJson: string | undefined;
	data: Float32Array | Uint16Array | Uint8Array;
	/** Per-channel planes in `data`'s carrier, when the image has more than one channel. */
	planes?: Array<Float32Array | Uint16Array | Uint8Array>;
	min: number;
	max: number;
	workers: number;
	timings: { name: string, durationMs: number }[];
}

type PoolWorker = { worker: Worker, busy: boolean };

class StripDecodePool {
	private _workers: PoolWorker[] = [];
	private _blobUrl: string | null = null;
	private _module: WebAssembly.Module | null = null;
	private _bootPromise: Promise<boolean> | null = null;
	private _nextId = 1;

	get size(): number { return this._workers.length; }

	/** Spawn or grow the pool to the useful size; safe to call repeatedly. */
	async ensure(compiledModule?: WebAssembly.Module, desiredWorkers = MAX_WORKERS): Promise<boolean> {
		if (compiledModule) { this._module = compiledModule; }
		const cores = (globalThis.navigator as any)?.hardwareConcurrency || 4;
		// Leave a core for the UI thread and the ordinary decode worker. Two is
		// still worthwhile for two sufficiently expensive independent strips.
		const target = Math.max(2, Math.min(MAX_WORKERS, desiredWorkers, cores - 1));
		if (this._workers.length >= target) { return true; }
		if (this._bootPromise) {
			await this._bootPromise;
			if (this._workers.length >= target) { return true; }
		}
		if (!this._bootPromise) {
			this._bootPromise = this._boot(target).catch(error => {
				console.warn('[StripPool] Unavailable, falling back to single-worker decode:', error);
				this._teardown();
				return false;
			});
		} else {
			this._bootPromise = this._spawn(this._module!, target).catch(error => {
				console.warn('[StripPool] Could not grow worker pool:', error);
				return this._workers.length >= 2;
			});
		}
		return this._bootPromise;
	}

	private async _boot(target: number): Promise<boolean> {
		const candidates = [
			new URL('../stripDecodeWorker.bundle.js', import.meta.url).href,
			new URL('./stripDecodeWorker.bundle.js', import.meta.url).href,
		];
		if (!this._blobUrl) {
			let source: string | null = null;
			for (const url of candidates) {
				try {
					const response = await fetch(url);
					if (response.ok) { source = await response.text(); break; }
				} catch { /* try next candidate */ }
			}
			if (!source) { throw new Error('stripDecodeWorker.bundle.js not found'); }
			this._blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
		}

		// Compiled once and instantiated N times: the main thread can fetch
		// webview-resource URLs, the blob workers cannot. Retained across a
		// retire/respawn cycle so only instantiation is repaid.
		if (this._module) {
			return this._spawn(this._module, target);
		}
		const warmup = (globalThis as any).__tiffVisualizerDecoderWarmup as {
			wasmModulePromise?: Promise<WebAssembly.Module>;
		} | undefined;
		if (warmup?.wasmModulePromise) {
			try {
				this._module = await warmup.wasmModulePromise;
				return this._spawn(this._module, target);
			} catch { /* use the explicit asset below */ }
		}
		const wasmUrls = [
			(globalThis as any).__tiffVisualizerVendorAssets?.wasm,
			new URL('./wasm/tiff-wasm.wasm', import.meta.url).href,
			new URL('../wasm/tiff-wasm.wasm', import.meta.url).href,
		].filter((url): url is string => typeof url === 'string' && url.length > 0);
		let compiled: WebAssembly.Module | null = null;
		for (const url of wasmUrls) {
			try {
				const response = await fetch(url);
				if (response.ok) { compiled = await WebAssembly.compile(await response.arrayBuffer()); break; }
			} catch { /* try next candidate */ }
		}
		if (!compiled) { throw new Error('tiff-wasm.wasm not found for the strip pool'); }
		this._module = compiled;
		return this._spawn(compiled, target);
	}

	private async _spawn(compiled: WebAssembly.Module, target: number): Promise<boolean> {
		const count = Math.max(0, target - this._workers.length);
		const booted = await Promise.all(Array.from({ length: count }, () => new Promise<PoolWorker | null>(resolve => {
			const worker = new Worker(this._blobUrl!, { type: 'module' });
			const timer = setTimeout(() => resolve(null), 20000);
			worker.onmessage = (event) => {
				if (event.data?.type === 'ready') {
					clearTimeout(timer);
					resolve(event.data.error ? null : { worker, busy: false });
				}
			};
			worker.onerror = () => { clearTimeout(timer); resolve(null); };
			worker.postMessage({ type: 'init', tiffWasmModule: compiled });
		})));
		this._workers.push(...booted.filter((w): w is PoolWorker => w !== null));
		if (!this._workers.length) { throw new Error('no strip workers booted'); }
		console.log(`[StripPool] Ready with ${this._workers.length} workers`);
		return true;
	}

	run(job: Record<string, unknown>, transfer: Transferable[], index: number): Promise<any> {
		const entry = this._workers[index % this._workers.length];
		const id = this._nextId++;
		return new Promise((resolve, reject) => {
			const onMessage = (event: MessageEvent) => {
				if (event.data?.id !== id) { return; }
				entry.worker.removeEventListener('message', onMessage);
				entry.busy = false;
				if (event.data.error) { reject(new Error(event.data.error)); }
				else { resolve(event.data); }
			};
			entry.worker.addEventListener('message', onMessage);
			entry.busy = true;
			entry.worker.postMessage({ id, ...job }, transfer);
		});
	}

	/**
	 * Terminate every pool worker and allow a fresh pool to boot later.
	 *
	 * WebAssembly linear memory grows but never shrinks, so N workers whose
	 * heaps each expanded to hold a slice of a 100-500MB raster retain that
	 * memory for the session. The main thread's following WebGL upload then
	 * contends with it -- measured at 10240x10240, keeping the pool alive more
	 * than doubled `webgl-texture-upload` (201ms -> 491ms), eating most of the
	 * decode win. The compiled module is kept so respawning is cheap.
	 */
	retire() {
		for (const entry of this._workers) { entry.worker.terminate(); }
		this._workers = [];
		this._bootPromise = null;
	}

	private _teardown() {
		this.retire();
		if (this._blobUrl) { URL.revokeObjectURL(this._blobUrl); this._blobUrl = null; }
	}
}

const pool = new StripDecodePool();
/** Extended codecs use their own instances so the core EXR/TIFF pool remains warm. */
const codecPool = new StripDecodePool();

/** Small, persistent heaps for interactive detail; never share the retiring full-raster pool. */
const detailPool = new StripDecodePool();
const detailPlans = new WeakMap<ArrayBuffer, { job: Record<string, any>, offsets: Float64Array, counts: Float64Array } | null>();
let nextDetailWorker = 0;

/**
 * Decode one complete stored strip with the existing Rust strip decoder.
 * Used only for generated previews of page zero. Cropped rectangles, tiled
 * layouts and uncommon codecs retain the authoritative region-worker path.
 * No source file is retained in the detail workers, only compressed strips.
 */
export async function tryParallelTiffDetail(
	buffer: ArrayBuffer, wasm: any,
	rect: { x: number, y: number, width: number, height: number },
	signal?: AbortSignal,
): Promise<any | null> {
	if (signal?.aborted) { return null; }
	if (!detailPlans.has(buffer)) {
		let plan: any;
		let retained: NonNullable<ReturnType<typeof detailPlans.get>> | null = null;
		try {
			plan = wasm.tiff_float_strip_plan(new Uint8Array(buffer));
			if (plan && !plan.tile_width && plan.planar_configuration === 1 && plan.orientation === 1
				&& plan.channels === 1 && plan.bits_per_sample === 32 && plan.sample_format === 3
				&& plan.width * Math.min(plan.rows_per_strip, plan.height) <= 8_000_000
				&& !EXTENDED_TIFF_COMPRESSIONS.has(plan.compression)) {
				retained = {
					offsets: plan.offsets, counts: plan.counts,
					job: {
						width: plan.width, height: plan.height, channels: plan.channels,
						bitsPerSample: plan.bits_per_sample, sampleFormat: plan.sample_format,
						compression: plan.compression, predictor: plan.predictor,
						rowsPerStrip: plan.rows_per_strip, littleEndian: plan.little_endian,
						photometricInterpretation: plan.photometric_interpretation,
					},
				};
			}
		} catch { /* Unsupported plan: use the region decoder. */ }
		finally { plan?.free(); }
		detailPlans.set(buffer, retained);
	}
	const plan = detailPlans.get(buffer);
	if (!plan) { return null; }
	const { job, offsets, counts } = plan;
	const firstStrip = rect.y / job.rowsPerStrip;
	if (rect.x !== 0 || rect.width !== job.width || !Number.isInteger(firstStrip)
		|| firstStrip < 0 || firstStrip >= counts.length
		|| rect.height !== Math.min(job.rowsPerStrip, job.height - rect.y)) { return null; }
	const offset = offsets[firstStrip], count = counts[firstStrip];
	if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(count) || offset < 0 || count <= 0
		|| count > 0xffffffff || offset + count > buffer.byteLength) { return null; }
	try {
		if (!await detailPool.ensure(undefined, 4) || signal?.aborted) { return null; }
		const blob = buffer.slice(offset, offset + count);
		const rangeCounts = new Uint32Array([count]);
		const part = await detailPool.run({ ...job, firstStrip, blob, counts: rangeCounts.buffer },
			[blob, rangeCounts.buffer], nextDetailWorker++);
		if (signal?.aborted) { return null; }
		if (part.samples?.length !== rect.width * rect.height * job.channels) { return null; }
		return { width: rect.width, height: rect.height, channels: job.channels,
			bitsPerSample: job.bitsPerSample, sampleFormat: job.sampleFormat,
			blocksDecoded: 1, data: part.samples };
	} catch (error) {
		console.warn('[DetailPool] Strip failed, using region decoder:', error);
		return null;
	}
}

const EXTENDED_TIFF_COMPRESSIONS = new Set([
	34887, // LERC
	34925, // LZMA
	34712, 33003, 33004, 33005, // JPEG 2000 variants
	34934, 22610, // JPEG XR variants
]);

/**
 * Start booting the pool without waiting for it.
 *
 * Cold opens are the common case, and the pool's cost is almost all startup:
 * fetching the worker bundle, compiling the WASM once, and instantiating it in
 * N workers. Kicked off alongside the file fetch (which takes 100-300ms on its
 * own) that cost overlaps with work that had to happen anyway instead of being
 * paid serially before the first decode.
 */
export function prewarmStripPool(): void {
	void pool.ensure();
}

export interface ExrZipBlockPlan {
	width: number;
	height: number;
	dataY: number;
	counts: Uint32Array;
	yCoordinates: Int32Array;
	compressed: Uint8Array;
	/** Each channel's pixel type in the blocks (0 u32, 1 half, 2 float); one float when absent. */
	channelKinds?: Uint32Array;
	/** Displayed channels as indices into the block's channels (-1: 1.0), interleaved per pixel. */
	selection?: Int32Array;
}

export interface ParallelHdrResult {
	width: number;
	height: number;
	exposure: number;
	gamma: number;
	allTagsJson: string;
	/** Tightly packed RGB floats, identical to `decode_hdr_fast`. */
	data: Float32Array;
	workers: number;
	timings: { name: string, durationMs: number }[];
}

/**
 * Decode a Radiance HDR across the shared pool. Its RLE scanlines are
 * independent but unindexed, so `hdr_scanline_plan` walks them once without
 * writing pixels, and each worker decodes a run of scanlines from exactly its
 * bytes with the same code as the whole-file decode. Returns null when the
 * image is too small to be worth it or anything fails; the caller then
 * decodes the file whole.
 */
export async function decodeHdrParallel(buffer: ArrayBuffer, wasm: any): Promise<ParallelHdrResult | null> {
	if (typeof wasm?.hdr_scanline_plan !== 'function') { return null; }
	const bytes = new Uint8Array(buffer);
	const planStart = performance.now();
	let plan: any;
	try { plan = wasm.hdr_scanline_plan(bytes); } catch { return null; }
	const width: number = plan.width;
	const height: number = plan.height;
	const offsets: Float64Array = plan.offsets;
	const exposure: number = plan.exposure;
	const gamma: number = plan.gamma;
	const allTagsJson: string = plan.all_tags_json;
	plan.free?.();
	const timings = [{ name: 'hdr-plan', durationMs: performance.now() - planStart }];
	if (height < MIN_PARALLEL_TIFF_STRIPS || width * height < MIN_PARALLEL_TIFF_PIXELS) { return null; }
	if (!await pool.ensure() || pool.size < 2) { return null; }

	// Same cost model as the TIFF strips: compressed plus half the decoded bytes.
	const workerCount = Math.min(pool.size, height);
	const rowCost = (y: number) => offsets[y + 1] - offsets[y] + 0.5 * width * 12;
	let totalCost = 0;
	for (let y = 0; y < height; y++) { totalCost += rowCost(y); }
	const target = totalCost / workerCount;
	const ranges: { first: number; last: number }[] = [];
	let cursor = 0;
	for (let workerIndex = 0; workerIndex < workerCount && cursor < height; workerIndex++) {
		const maxEnd = height - (workerCount - workerIndex - 1);
		let end = cursor;
		let cost = 0;
		while (end < maxEnd && (cost < target || end === cursor)) { cost += rowCost(end++); }
		if (workerIndex === workerCount - 1) { end = height; }
		ranges.push({ first: cursor, last: end });
		cursor = end;
	}

	const started = performance.now();
	const output = new Float32Array(width * height * 3);
	const jobs = ranges.map(async (range, workerIndex) => {
		const blob = bytes.slice(offsets[range.first], offsets[range.last]);
		const part = await pool.run({
			kind: 'hdr-rows', blob: blob.buffer, width, rows: range.last - range.first,
		}, [blob.buffer], workerIndex);
		output.set(part.samples, range.first * width * 3);
	});
	// Every range is dispatched and no result can arrive before this task
	// ends, so commit the output's pages while the workers decode (see the
	// TIFF strips' prefault).
	if (output.byteLength >= PREFAULT_MIN_BYTES) {
		const prefaultStart = performance.now();
		prefaultPages(output);
		timings.push({ name: 'hdr-prefault', durationMs: performance.now() - prefaultStart });
	}
	try {
		await Promise.all(jobs);
	} catch (error) {
		console.warn('[StripPool] HDR scanline decode failed, falling back:', error);
		return null;
	}
	timings.push({ name: 'hdr-workers', durationMs: performance.now() - started });
	if (output.byteLength >= 64 * 1024 * 1024) {
		pool.retire();
		setTimeout(() => { void pool.ensure(); }, 0);
	}
	return { width, height, exposure, gamma, allTagsJson, data: output, workers: ranges.length, timings };
}

export interface ParallelPsdResult {
	width: number;
	height: number;
	/** RGBA, byte for byte ag-psd's composite. */
	data: Uint8ClampedArray;
	workers: number;
	timings: { name: string; durationMs: number }[];
}

/**
 * The composite of an 8-bit RGB or grayscale PSD/PSB, its rows split across
 * the pool (see `psd_composite_plan`). Every range's bytes are copied out of
 * `buffer` before this first awaits a worker, so `onSourceCopied` may hand the
 * buffer to another thread. Null when the document is not eligible, the pool
 * is unavailable, or any row fails (ag-psd then decodes it, as before).
 */
export async function decodePsdCompositeParallel(
	buffer: ArrayBuffer,
	wasm: any,
	onSourceCopied?: () => void,
): Promise<ParallelPsdResult | null> {
	if (typeof wasm?.psd_composite_plan !== 'function') { return null; }
	const bytes = new Uint8Array(buffer);
	const planStart = performance.now();
	let plan: any;
	try { plan = wasm.psd_composite_plan(bytes); } catch { return null; }
	const width: number = plan.width;
	const height: number = plan.height;
	const targets: Uint8Array = plan.targets;
	const grayscale: boolean = plan.grayscale;
	const globalAlpha: boolean = plan.global_alpha;
	const compression: number = plan.compression;
	const offsets: Float64Array = plan.row_offsets;
	const counts: Uint32Array = plan.row_counts;
	plan.free?.();
	const timings = [{ name: 'psd-plan', durationMs: performance.now() - planStart }];
	if (height < MIN_PARALLEL_TIFF_STRIPS || width * height < MIN_PARALLEL_TIFF_PIXELS) { return null; }
	if (!await pool.ensure() || pool.size < 2) { return null; }

	const channels = targets.length;
	const workerCount = Math.min(pool.size, height);
	const rowCost = (y: number) => {
		let cost = 0.5 * width * 4;
		for (let c = 0; c < channels; c++) { cost += counts[c * height + y]; }
		return cost;
	};
	let totalCost = 0;
	for (let y = 0; y < height; y++) { totalCost += rowCost(y); }
	const target = totalCost / workerCount;
	const ranges: { first: number; last: number }[] = [];
	let cursor = 0;
	for (let workerIndex = 0; workerIndex < workerCount && cursor < height; workerIndex++) {
		const maxEnd = height - (workerCount - workerIndex - 1);
		let end = cursor;
		let cost = 0;
		while (end < maxEnd && (cost < target || end === cursor)) { cost += rowCost(end++); }
		if (workerIndex === workerCount - 1) { end = height; }
		ranges.push({ first: cursor, last: end });
		cursor = end;
	}

	const started = performance.now();
	const jobs = ranges.map(range => {
		const rows = range.last - range.first;
		const rangeCounts = new Uint32Array(channels * rows);
		let total = 0;
		for (let c = 0; c < channels; c++) {
			for (let y = 0; y < rows; y++) {
				const count = counts[c * height + range.first + y];
				rangeCounts[c * rows + y] = count;
				total += count;
			}
		}
		const blob = new Uint8Array(total);
		for (let c = 0, at = 0; c < channels; c++) {
			for (let y = 0; y < rows; y++) {
				const offset = offsets[c * height + range.first + y];
				const count = rangeCounts[c * rows + y];
				blob.set(bytes.subarray(offset, offset + count), at);
				at += count;
			}
		}
		return { range, rows, rangeCounts, blob };
	});
	timings.push({ name: 'psd-copy-ranges', durationMs: performance.now() - started });
	onSourceCopied?.();
	const output = new Uint8ClampedArray(width * height * 4);
	let slowest = 0;
	try {
		await Promise.all(jobs.map(async (job, workerIndex) => {
			const part = await pool.run({
				kind: 'psd-rows', blob: job.blob.buffer, counts: job.rangeCounts, width, rows: job.rows,
				targets, compression, globalAlpha, grayscale,
			}, [job.blob.buffer, job.rangeCounts.buffer], workerIndex);
			slowest = Math.max(slowest, Number(part.ms) || 0);
			output.set(part.rgba, job.range.first * width * 4);
		}));
	} catch (error) {
		console.warn('[StripPool] PSD composite decode failed, falling back:', error);
		return null;
	}
	timings.push({ name: 'psd-workers', durationMs: performance.now() - started });
	timings.push({ name: 'psd-slowest-worker', durationMs: slowest });
	// Each worker held only its own band (an eighth of the image), so unlike
	// the HDR and TIFF paths the pool is kept rather than retired.
	return { width, height, data: output, workers: ranges.length, timings };
}

/**
 * The bounded preview of a very large single-page float TIFF (see
 * `tiff_preview_reduction`), decoded across the pool. Each worker decodes its
 * strips one unit at a time and keeps only the preview grid and the range, so
 * no thread ever holds the full-resolution image; the ranges concatenate to
 * exactly `decode_tiff_preview`'s pixels. Returns the same fields the decode
 * worker returns for a generated preview, or null to let it decode instead.
 */
export async function tryParallelTiffPreview(
	buffer: ArrayBuffer | Uint8Array,
	wasm: any,
	stream?: TiffImageStream,
	onDispatched?: () => void,
): Promise<Record<string, any> | null> {
	if (typeof wasm?.tiff_preview_header !== 'function' || typeof wasm?.tiff_float_strip_plan !== 'function') { return null; }
	// With a stream, `buffer` is only the verified IFD prefix; blocks are read
	// from the stream once they have arrived (see tryStreamingStripParallelDecode).
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	const planStart = performance.now();
	const reduction = Number(wasm.tiff_preview_reduction?.(bytes) || 0);
	if (reduction <= 0) { return null; }
	let plan: any;
	let header: any;
	try {
		plan = wasm.tiff_float_strip_plan(bytes);
		header = wasm.tiff_preview_header(bytes);
	} catch { return null; }
	if (!plan || !header) { return null; }
	// Extended codecs need the codec module's pool; leave them to the worker.
	if (EXTENDED_TIFF_COMPRESSIONS.has(Number(plan.compression))) { return null; }
	const stripCount: number = plan.strip_count;
	if (stripCount < 2 || !await pool.ensure(undefined, MAX_WORKERS) || pool.size < 2) { return null; }
	const timings = [{ name: 'preview-plan', durationMs: performance.now() - planStart }];

	const offsets: Float64Array = plan.offsets;
	const counts: Float64Array = plan.counts;
	const blocksPerUnit: number = plan.blocks_per_unit || 1;
	const tileWidth: number = plan.tile_width || 0;
	const tileLength: number = plan.tile_length || 0;
	const rowsPerUnit: number = tileLength > 0 ? tileLength : plan.rows_per_strip;
	const unitPixels = tileLength > 0 ? (plan.blocks_across || 1) * tileWidth * tileLength : plan.width * plan.rows_per_strip;
	const unitCost = (i: number) => {
		let total = 0.5 * unitPixels * 4;
		for (let b = 0; b < blocksPerUnit; b++) { total += counts[i * blocksPerUnit + b]; }
		return total;
	};
	const workerCount = Math.min(pool.size, stripCount);
	let totalCost = 0;
	for (let i = 0; i < stripCount; i++) { totalCost += unitCost(i); }
	const target = totalCost / workerCount;
	const ranges: { first: number, last: number }[] = [];
	let cursor = 0;
	for (let w = 0; w < workerCount && cursor < stripCount; w++) {
		const maxEnd = stripCount - (workerCount - w - 1);
		let end = cursor;
		let acc = 0;
		while (end < maxEnd && (acc < target || end === cursor)) { acc += unitCost(end++); }
		if (w === workerCount - 1) { end = stripCount; }
		ranges.push({ first: cursor, last: end });
		cursor = end;
	}

	if (stream) {
		for (let i = 0; i < counts.length; i++) {
			if (offsets[i] + counts[i] > stream.total) { header.free?.(); return null; }
		}
	}
	const previewWidth: number = header.width;
	const previewHeight: number = header.height;
	const data = new Float32Array(previewWidth * previewHeight);
	let dispatched = 0;
	let min = Infinity;
	let max = -Infinity;
	const started = performance.now();
	try {
		await Promise.all(ranges.map(async (range, index) => {
			const firstBlock = range.first * blocksPerUnit;
			const lastBlock = range.last * blocksPerUnit;
			let blobLength = 0;
			let rangeEnd = 0;
			for (let i = firstBlock; i < lastBlock; i++) {
				blobLength += counts[i];
				rangeEnd = Math.max(rangeEnd, offsets[i] + counts[i]);
			}
			let source = bytes;
			if (stream) {
				await stream.whenAvailable(rangeEnd);
				source = stream.bytes!;
				if (source.byteLength === 0) { throw new Error('stream bytes were released'); }
			}
			const blob = new Uint8Array(blobLength);
			const rangeCounts = new Uint32Array(lastBlock - firstBlock);
			let position = 0;
			for (let i = firstBlock; i < lastBlock; i++) {
				blob.set(source.subarray(offsets[i], offsets[i] + counts[i]), position);
				position += counts[i];
				rangeCounts[i - firstBlock] = counts[i];
			}
			if (++dispatched === ranges.length) { onDispatched?.(); }
			const part = await pool.run({
				kind: 'tiff-preview', blob: blob.buffer, counts: rangeCounts.buffer, firstStrip: range.first,
				width: plan.width, height: plan.height, channels: plan.channels,
				bitsPerSample: plan.bits_per_sample, compression: plan.compression,
				rowsPerStrip: plan.rows_per_strip, predictor: plan.predictor, sampleFormat: plan.sample_format,
				littleEndian: plan.little_endian, planarConfiguration: plan.planar_configuration || 1,
				orientation: plan.orientation || 1, tileWidth, tileLength, blocksAcross: plan.blocks_across || 1,
				lercAdditionalCompression: plan.lerc_additional_compression || 0,
				photometricInterpretation: plan.photometric_interpretation || 1, reduction,
			}, [blob.buffer, rangeCounts.buffer], index);
			// This range's first preview row: the grid rows before its first source row.
			data.set(part.samples, Math.ceil(range.first * rowsPerUnit / reduction) * previewWidth);
			if (part.min < min) { min = part.min; }
			if (part.max > max) { max = part.max; }
		}));
	} catch (error) {
		console.warn('[StripPool] Bounded preview decode failed, falling back:', error);
		header.free?.();
		return null;
	}
	timings.push({ name: 'preview-workers', durationMs: performance.now() - started });
	const result = {
		pageIndex: 1,
		pageCount: 2,
		width: previewWidth,
		height: previewHeight,
		channels: 1,
		bitsPerSample: header.bits_per_sample,
		sampleFormat: header.sample_format,
		sampleKind: Number(header.sample_kind ?? 0),
		compression: header.compression,
		predictor: header.predictor,
		photometricInterpretation: header.photometric_interpretation,
		planarConfiguration: header.planar_configuration,
		rowsPerStrip: header.rows_per_strip,
		stripCount: header.strip_count,
		stripByteCountTotal: Number(header.strip_byte_count_total || 0),
		stripByteCountMax: Number(header.strip_byte_count_max || 0),
		tileWidth: header.tile_width,
		tileLength: header.tile_length,
		tileCount: header.tile_count,
		directDecode: header.direct_decode,
		data,
		rasters: [data],
		min,
		max,
		allTagsJson: header.all_tags_json,
		omeXml: header.ome_xml || undefined,
		geoJson: header.geo_json || undefined,
		pageDirectoryJson: header.page_directory_json || undefined,
		decodedWith: `wasm (bounded preview, ${ranges.length} workers)`,
		decodeTimings: timings,
	};
	header.free?.();
	return result;
}

/** Decode independently compressed EXR ZIP16 blocks across the shared pool. */
export async function decodeExrZipBlocks(plan: ExrZipBlockPlan): Promise<{
	data: Float32Array;
	min: number;
	max: number;
	workers: number;
	durationMs: number;
	channels: number;
} | null> {
	const { width, height, dataY, counts, yCoordinates, compressed } = plan;
	const kinds = plan.channelKinds ?? Uint32Array.of(2);
	const channelCount = kinds.length;
	// One float channel shown as it is stored keeps the plain path; anything
	// else is selected, converted and interleaved by the workers.
	const plain = channelCount === 1 && kinds[0] === 2 && (!plan.selection || (plan.selection.length === 1 && plan.selection[0] === 0));
	const selection = plain ? null : plan.selection ?? Int32Array.of(0);
	const rowBytes = Array.from(kinds).reduce((sum, kind) => sum + (kind === 1 ? 2 : 4), 0) * width;
	const outChannels = selection ? selection.length : 1;
	// Work follows the stored samples: every channel of every pixel is inflated.
	if (counts.length < MIN_PARALLEL_TIFF_STRIPS || counts.length !== yCoordinates.length
		|| width * height * (plan.channelKinds?.length ?? 1) < MIN_PARALLEL_TIFF_PIXELS) { return null; }
	if (!await pool.ensure() || pool.size < 2) { return null; }

	const rows = new Uint32Array(counts.length);
	const offsets = new Uint32Array(counts.length);
	let totalCompressed = 0;
	for (let index = 0; index < counts.length; index++) {
		const row = yCoordinates[index] - dataY;
		if (row !== index * 16 || row >= height) { return null; }
		rows[index] = Math.min(16, height - row);
		offsets[index] = totalCompressed;
		totalCompressed += counts[index];
	}
	if (totalCompressed !== compressed.byteLength) { return null; }

	// Same cost model as the TIFF strips below: compressed plus half the decoded bytes.
	const workerCount = Math.min(pool.size, counts.length);
	const blockCost = (index: number) => counts[index] + 0.5 * rows[index] * rowBytes;
	let totalCost = 0;
	for (let index = 0; index < counts.length; index++) { totalCost += blockCost(index); }
	const target = totalCost / workerCount;
	const ranges: { first: number; last: number }[] = [];
	let cursor = 0;
	for (let workerIndex = 0; workerIndex < workerCount && cursor < counts.length; workerIndex++) {
		const remainingWorkers = workerCount - workerIndex;
		const maxEnd = counts.length - (remainingWorkers - 1);
		let end = cursor;
		let cost = 0;
		while (end < maxEnd && (cost < target || end === cursor)) { cost += blockCost(end++); }
		if (workerIndex === workerCount - 1) { end = counts.length; }
		ranges.push({ first: cursor, last: end });
		cursor = end;
	}

	const started = performance.now();
	const jobs = ranges.map((range, workerIndex) => {
		const blobStart = offsets[range.first];
		const last = range.last - 1;
		const blobEnd = offsets[last] + counts[last];
		const blob = compressed.slice(blobStart, blobEnd);
		const rangeCounts = counts.slice(range.first, range.last);
		const rangeRows = rows.slice(range.first, range.last);
		return pool.run({
			kind: 'exr-zip',
			blob: blob.buffer,
			counts: rangeCounts.buffer,
			rows: rangeRows.buffer,
			width,
			kinds: selection ? Array.from(kinds) : undefined,
			selection: selection ? Array.from(selection) : undefined,
		}, [blob.buffer, rangeCounts.buffer, rangeRows.buffer], workerIndex);
	});

	const output = new Float32Array(width * height * outChannels);
	let min = Infinity;
	let max = -Infinity;
	try {
		await Promise.all(jobs.map(async (job, index) => {
			const part = await job;
			const row = yCoordinates[ranges[index].first] - dataY;
			output.set(part.samples, row * width * outChannels);
			if (part.min < min) { min = part.min; }
			if (part.max > max) { max = part.max; }
		}));
	} catch (error) {
		console.warn('[StripPool] EXR ZIP range failed, falling back:', error);
		return null;
	}
	const durationMs = performance.now() - started;
	if (output.byteLength >= 64 * 1024 * 1024) {
		pool.retire();
		setTimeout(() => { void pool.ensure(); }, 0);
	}
	return { data: output, min, max, workers: ranges.length, durationMs, channels: outChannels };
}

/**
 * The tiles of one CZI region (czi-source.ts) decoded one per job across the
 * pool. Each job decodes a single subblock into exactly the output pixels it
 * covers; copying them into the region in plan (directory) order lets later
 * tiles overwrite earlier ones where a mosaic overlaps, as the single-worker
 * composition does, so the result is identical. Null when the pool is not
 * worth it or unavailable; the caller then decodes in one worker.
 */
export async function decodeCziTilesParallel(request: {
	directory: ArrayBuffer;
	options: Record<string, any>;
	codec: boolean;
	region: { x: number; y: number };
	factor: number;
	width: number;
	height: number;
	tiles: { position: number; bytes: Uint8Array; rect: [number, number, number, number] }[];
}): Promise<{ data: Float32Array; channels: number; workers: number } | null> {
	const { tiles, factor, width, height, region } = request;
	if (tiles.length < 2) { return null; }
	let activePool = pool;
	try {
		if (request.codec) {
			const { codecWasmModule } = await import('./codec-wasm-wrapper.js');
			activePool = codecPool;
			if (!await activePool.ensure(await codecWasmModule())) { return null; }
		} else if (!await activePool.ensure()) { return null; }
	} catch { return null; }
	if (activePool.size < 2) { return null; }

	const tileJobs = cziTileJobs(region, factor, width, height, tiles.map(tile => tile.rect));
	const jobs = tiles.map((tile, index) => {
		const job = tileJobs[index];
		if (!job) { return null; }
		const options = { ...request.options, factor, rect: job.rect, positions: [tile.position] };
		const blob = tile.bytes.slice().buffer;
		return { job, result: activePool.run({ kind: 'czi-tile', directory: request.directory, optionsJson: JSON.stringify(options), blob }, [blob], index) };
	});
	let output: Float32Array | null = null;
	let channels = 0;
	try {
		// Settle all, then merge strictly in plan order.
		const parts = await Promise.all(jobs.map(entry => entry?.result ?? null));
		for (let index = 0; index < parts.length; index++) {
			const part = parts[index];
			const entry = jobs[index];
			if (!part || !entry) { continue; }
			if (!output) {
				channels = part.channels;
				output = new Float32Array(width * height * channels);
			}
			if (!mergeCziTile(output, width, channels, entry.job, part)) { return null; }
		}
	} catch (error) {
		console.warn('[StripPool] CZI tile failed, decoding in one worker:', error);
		return null;
	}
	return output ? { data: output, channels, workers: Math.min(activePool.size, tiles.length) } : null;
}

/**
 * Decode a TIFF that is still being read, dispatching each worker's range as
 * soon as its bytes have arrived, so the decode overlaps the read instead of
 * following it. A TIFF too large to display whole yields its bounded preview
 * (`preview`, the decode worker's result shape); others their strips. Only for single-image files whose first IFD, with every value
 * it points at, can be read from the start of the stream; anything else
 * returns null and the caller waits for the whole file as before.
 *
 * `onDispatched` runs once no range will read the stream any more, after
 * which the bootstrap may hand the buffer to another thread.
 */
export type StreamedTiffDecode =
	| { strips: StripParallelResult; preview?: undefined }
	| { preview: Record<string, any>; strips?: undefined };

export async function tryStreamingStripParallelDecode(
	stream: TiffImageStream,
	wasm: any,
	onDispatched: () => void,
): Promise<StreamedTiffDecode | null> {
	try {
		const prefix = await tiffFirstIfdPrefix(stream);
		if (!prefix?.singleImage || !stream.bytes) { return null; }
		await stream.whenAvailable(prefix.needed);
		const head = stream.bytes.subarray(0, prefix.needed);
		if (wasm?.tiff_preview_reduction?.(head) > 0) {
			const preview = await tryParallelTiffPreview(head, wasm, stream, onDispatched);
			return preview ? { preview } : null;
		}
		const strips = await tryStripParallelDecode(head, wasm, stream, onDispatched);
		return strips ? { strips } : null;
	} catch (error) {
		console.warn('[StripPool] Streaming decode unavailable, waiting for the whole file:', error);
		return null;
	} finally {
		onDispatched();
	}
}

/**
 * A JPEG block (compression 7) as a complete stream: the shared JPEGTables
 * without their EOI, then the block without its SOI (TIFF Technote 2), exactly
 * as the Rust `build_jpeg` assembles it for whole-image and region decodes.
 */
function completeJpegBlock(tables: Uint8Array, block: Uint8Array): Uint8Array {
	const head = tables.length >= 2 && tables[tables.length - 2] === 0xff && tables[tables.length - 1] === 0xd9
		? tables.subarray(0, tables.length - 2) : tables;
	const body = block.length >= 2 && block[0] === 0xff && block[1] === 0xd8 ? block.subarray(2) : block;
	const out = new Uint8Array(head.length + body.length);
	out.set(head, 0);
	out.set(body, head.length);
	return out;
}

/**
 * Decode `buffer` across the pool, or return `null` when this file is not a
 * shape the parallel path handles (the caller then uses the normal route).
 *
 * `wasm` must be an already-initialized main-thread module exposing
 * `tiff_float_strip_plan` and `tiff_strip_metadata`; both parse the IFD only.
 */
export async function tryStripParallelDecode(
	buffer: ArrayBuffer | Uint8Array,
	wasm: any,
	stream?: TiffImageStream,
	onDispatched?: () => void,
): Promise<StripParallelResult | null> {
	if (!wasm || typeof wasm.tiff_float_strip_plan !== 'function') { return null; }
	// With a stream, `buffer` is only the verified IFD prefix (see
	// tryStreamingStripParallelDecode); strip bytes are read from the stream
	// once they have arrived.
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

	const planStart = performance.now();
	let plan: any;
	try { plan = wasm.tiff_float_strip_plan(bytes); } catch { return null; }
	if (!plan) { return null; }

	const stripCount: number = plan.strip_count;
	const width: number = plan.width;
	const height: number = plan.height;
	if (!shouldUseParallelTiffPlan(plan)) { return null; }
	const desiredWorkers = parallelTiffWorkerCount(plan);

	let activePool = pool;
	if (EXTENDED_TIFF_COMPRESSIONS.has(Number(plan.compression))) {
		try {
			const { codecWasmModule } = await import('./codec-wasm-wrapper.js');
			const compiled = await codecWasmModule();
			activePool = codecPool;
			if (!await activePool.ensure(compiled, desiredWorkers)) { return null; }
		} catch (error) {
			console.warn('[StripPool] Extended codec module unavailable, falling back:', error);
			return null;
		}
	} else if (!await activePool.ensure(undefined, desiredWorkers)) {
		return null;
	}
	if (activePool.size < 2) { return null; }

	const channels: number = Number(plan.photometric_interpretation) === 5 ? 3 : plan.channels;
	const offsets: Float64Array = plan.offsets;
	const counts: Float64Array = plan.counts;
	const rowsPerStrip: number = plan.rows_per_strip;
	// One entry per unit for a stripped file; one per tile for a tiled one.
	const blocksPerUnit: number = plan.blocks_per_unit || 1;
	const tileWidth: number = plan.tile_width || 0;
	const tileLength: number = plan.tile_length || 0;
	const blocksAcross: number = plan.blocks_across || 1;
	const lercAdditionalCompression: number = plan.lerc_additional_compression || 0;
	/** Compressed bytes of unit `i`, summed over the blocks it covers. */
	const unitBytes = (i: number) => {
		let total = 0;
		for (let b = 0; b < blocksPerUnit; b++) { total += counts[i * blocksPerUnit + b]; }
		return total;
	};
	const timings: { name: string, durationMs: number }[] = [
		{ name: 'strip-plan', durationMs: performance.now() - planStart },
	];

	// Metadata is IFD-only and independent of the pixel work, so start it now
	// and await it while the workers run.
	const metadataPromise = (async () => {
		const start = performance.now();
		try {
			const meta = wasm.tiff_strip_metadata(bytes);
			timings.push({ name: 'strip-metadata', durationMs: performance.now() - start });
			return meta;
		} catch { return null; }
	})();

	// Balance by estimated COST, not strip count or compressed bytes alone. A
	// unit's decode time grows with its compressed bytes (entropy decoding) AND
	// its decoded bytes (inflate output, predictor, copies). Compressed bytes
	// alone overloaded one worker on high-ratio files: on a 5120x5120 RGB8
	// Deflate image the slowest of 8 workers took 23 ms against 14 ms for an
	// even split. Half a cost unit per decoded byte was the best weight across
	// the benchmark corpus (Deflate f32/u16/RGB8, predictors 1/2/3, LZW).
	const workerCount = Math.min(activePool.size, stripCount, desiredWorkers);
	const unitPixels = tileLength > 0 ? blocksAcross * tileWidth * tileLength : width * rowsPerStrip;
	const decodedPerUnit = unitPixels * plan.channels * Math.max(1, plan.bits_per_sample / 8);
	const unitCost = (i: number) => unitBytes(i) + 0.5 * decodedPerUnit;
	let totalBytes = 0;
	for (let i = 0; i < stripCount; i++) { totalBytes += unitCost(i); }
	const targetPerWorker = totalBytes / workerCount;

	const ranges: { first: number, last: number }[] = [];
	let cursor = 0;
	for (let w = 0; w < workerCount && cursor < stripCount; w++) {
		const remainingWorkers = workerCount - w;
		const remainingStrips = stripCount - cursor;
		let acc = 0;
		let end = cursor;
		// Always leave at least one strip for each remaining worker.
		const maxEnd = stripCount - (remainingWorkers - 1);
		while (end < maxEnd && (acc < targetPerWorker || end === cursor)) {
			acc += unitCost(end);
			end++;
		}
		if (w === workerCount - 1) { end = stripCount; }
		ranges.push({ first: cursor, last: end });
		cursor = end;
		if (remainingStrips <= remainingWorkers) { /* one strip each from here */ }
	}

	if (stream) {
		for (let i = 0; i < counts.length; i++) {
			if (offsets[i] + counts[i] > stream.total) { return null; }
		}
	}
	const raw = carrierFor(plan.bits_per_sample, plan.sample_format);
	// JPEG blocks reach the workers as complete streams; they carry no tables.
	const jpegTables: Uint8Array | null = Number(plan.compression) === 7 && plan.jpeg_tables?.length ? plan.jpeg_tables : null;
	// Multi-channel callers need per-channel planes as well as the interleaved
	// buffer. The workers split their own bands; a transposed orientation
	// cannot be placed band by band, so those are split here afterwards.
	const orientationTag = Number(plan.orientation || 1);
	const wantPlanes = channels > 1 && !(orientationTag >= 5 && orientationTag <= 8);
	const dispatchStart = performance.now();
	let dispatched = 0;
	const jobs = ranges.map(async (range, index) => {
		// Blocks, not units: a tile row contributes `blocksPerUnit` of them.
		const firstBlock = range.first * blocksPerUnit;
		const lastBlock = range.last * blocksPerUnit;
		let blobLength = 0;
		let rangeEnd = 0;
		for (let i = firstBlock; i < lastBlock; i++) {
			blobLength += counts[i];
			rangeEnd = Math.max(rangeEnd, offsets[i] + counts[i]);
		}
		let source = bytes;
		if (stream) {
			await stream.whenAvailable(rangeEnd);
			source = stream.bytes!;
			// Released and transferred after an earlier range failed.
			if (source.byteLength === 0) { throw new Error('stream bytes were released'); }
		}
		let blob = new Uint8Array(blobLength);
		const rangeCounts = new Uint32Array(lastBlock - firstBlock);
		let position = 0;
		if (jpegTables) {
			const parts: Uint8Array[] = [];
			for (let i = firstBlock; i < lastBlock; i++) {
				const part = completeJpegBlock(jpegTables, source.subarray(offsets[i], offsets[i] + counts[i]));
				parts.push(part);
				rangeCounts[i - firstBlock] = part.length;
				position += part.length;
			}
			blob = new Uint8Array(position);
			position = 0;
			for (const part of parts) { blob.set(part, position); position += part.length; }
		} else {
			for (let i = firstBlock; i < lastBlock; i++) {
				const offset = offsets[i];
				const count = counts[i];
				blob.set(source.subarray(offset, offset + count), position);
				position += count;
				rangeCounts[i - firstBlock] = count;
			}
		}
		if (++dispatched === ranges.length) { onDispatched?.(); }
		return activePool.run({
			raw: !!raw,
			blob: blob.buffer,
			counts: rangeCounts.buffer,
			firstStrip: range.first,
			width, height, channels: plan.channels,
			outputChannels: channels,
			bitsPerSample: plan.bits_per_sample,
			compression: plan.compression,
			rowsPerStrip,
			predictor: plan.predictor,
			sampleFormat: plan.sample_format,
			littleEndian: plan.little_endian,
			planarConfiguration: plan.planar_configuration || 1,
			orientation: plan.orientation || 1,
			tileWidth, tileLength, blocksAcross,
			lercAdditionalCompression,
			photometricInterpretation: plan.photometric_interpretation || 1,
			planes: wantPlanes,
		}, [blob.buffer, rangeCounts.buffer], index);
	});

	// Copy each range in as it ARRIVES rather than after Promise.all: the
	// workers finish at different times, so the copies hide behind the ranges
	// still decoding instead of running as one serial pass at the end.
	const orientation = Number(plan.orientation || 1);
	const transposed = orientation >= 5 && orientation <= 8;
	const outputWidth = transposed ? height : width;
	const outputHeight = transposed ? width : height;
	const total = outputWidth * outputHeight * channels;
	let data: Float32Array | Uint16Array | Uint8Array =
		raw === 'u8' ? new Uint8Array(total)
			: raw === 'u16' ? new Uint16Array(total)
				: new Float32Array(total);
	const planePixels = outputWidth * outputHeight;
	const planes = wantPlanes
		? Array.from({ length: channels }, () => new (data.constructor as any)(planePixels) as typeof data)
		: undefined;
	// A fresh large buffer is committed page by page on first write, and those
	// faults, not the copy, were most of `strip-assemble`: 400 MB took ~235 ms
	// to fill fresh against ~35 ms once committed. The main thread is idle
	// while the workers decode, so commit the pages now. Nothing has been
	// copied in yet (results arrive on later tasks); only when every range was
	// dispatched synchronously, so a streamed read is never held up.
	// Uncompressed ranges finish before the faults would (43 ms against 54 ms
	// on 100 MB), which would put them back on the critical path.
	if (dispatched === ranges.length && data.byteLength >= PREFAULT_MIN_BYTES && Number(plan.compression) !== 1) {
		const prefaultStart = performance.now();
		prefaultPages(data);
		if (planes) { for (const plane of planes) { prefaultPages(plane); } }
		timings.push({ name: 'strip-prefault', durationMs: performance.now() - prefaultStart });
	}
	// A streamed read dispatches as bytes arrive and the main thread is mostly
	// waiting for them, so commit the pages a slice at a time between chunks.
	// Copies land in arbitrary order, so slices already copied into are skipped.
	const copiedBands: Array<[number, number]> = [];
	let assembled = false;
	let prefaultMs = 0;
	if (dispatched < ranges.length && !transposed && data.byteLength >= PREFAULT_MIN_BYTES && Number(plan.compression) !== 1) {
		const sliceElements = (4 * 1024 * 1024) / data.BYTES_PER_ELEMENT;
		const arrays = [data, ...(planes || [])];
		void (async () => {
			for (const array of arrays) {
				const scale = array === data ? 1 : channels;
				for (let start = 0; start < array.length && !assembled; start += sliceElements) {
					const end = Math.min(array.length, start + sliceElements);
					if (!copiedBands.some(([from, to]) => from < end * scale && to > start * scale)) {
						const sliceStart = performance.now();
						prefaultPages(array.subarray(start, end));
						prefaultMs += performance.now() - sliceStart;
					}
					await new Promise(resolve => setTimeout(resolve, 0));
				}
			}
		})();
	}
	let min = Infinity;
	let max = -Infinity;
	let copyMs = 0;
	let slowestWorkerMs = 0;
	try {
		await Promise.all(jobs.map(async (job, index) => {
			const part = await job;
			const copyStart = performance.now();
			slowestWorkerMs = Math.max(slowestWorkerMs, Number(part.ms) || 0);
			if (part.transposed) {
				const bandWidth = Number(part.bandWidth);
				const destinationStart = Number(part.destinationStart);
				for (let row = 0; row < outputHeight; row++) {
					const sourceStart = row * bandWidth * channels;
					const destination = (row * outputWidth + destinationStart) * channels;
					data.set(part.samples.subarray(sourceStart, sourceStart + bandWidth * channels), destination);
				}
			} else {
				const bandStart = Number(part.destinationStart) * width * channels;
				copiedBands.push([bandStart, bandStart + part.samples.length]);
				data.set(part.samples, bandStart);
				if (planes) {
					const bandPixels = part.samples.length / channels;
					const at = Number(part.destinationStart) * width;
					for (let c = 0; c < channels; c++) {
						planes[c].set(part.planes.subarray(c * bandPixels, (c + 1) * bandPixels), at);
					}
				}
			}
			copyMs += performance.now() - copyStart;
			if (part.min < min) { min = part.min; }
			if (part.max > max) { max = part.max; }
		}));
	} catch (error) {
		console.warn('[StripPool] Range decode failed, falling back:', error);
		return null;
	} finally {
		assembled = true;
	}
	if (prefaultMs > 0) { timings.push({ name: 'strip-prefault-streamed', durationMs: prefaultMs }); }
	timings.push({ name: 'strip-workers', durationMs: performance.now() - dispatchStart });
	// Time the slowest worker spent on its own range; the rest of
	// `strip-workers` is dispatch, messaging and scheduling.
	timings.push({ name: 'strip-slowest-worker', durationMs: slowestWorkerMs });
	// Sum of the copies themselves; most of this is off the critical path now.
	timings.push({ name: 'strip-assemble', durationMs: copyMs });

	if (orientation !== 1) { timings.push({ name: 'orientation-fused', durationMs: 0 }); }

	const meta = await metadataPromise;

	// Retire the pool before returning so its expanded WASM heaps are released
	// on this task, ahead of the caller's WebGL upload. Same reasoning as the
	// decode worker's `retireWorker`, and the same 64MB threshold.
	if (data.byteLength >= 64 * 1024 * 1024) {
		activePool.retire();
		setTimeout(() => { void activePool.ensure(); }, 0);
		timings.push({ name: 'strip-pool-retired', durationMs: 0 });
	}

	return {
		tileWidth, tileLength,
		tileCount: tileWidth > 0 ? counts.length : 0,
		width: outputWidth, height: outputHeight, channels,
		bitsPerSample: plan.bits_per_sample,
		sampleFormat: plan.sample_format,
		compression: plan.compression,
		predictor: plan.predictor,
		planarConfiguration: plan.planar_configuration || 1,
		rowsPerStrip,
		stripCount,
		// JPEG decodes YCbCr to RGB, as the whole-image path reports it.
		photometricInterpretation: Number(plan.compression) === 7 && meta?.photometric_interpretation === 6
			? 2 : meta?.photometric_interpretation ?? 1,
		pageCount: meta?.page_count ?? 1,
		allTagsJson: meta?.all_tags_json ?? '[]',
		omeXml: meta?.ome_xml || undefined,
		geoJson: meta?.geo_json || undefined,
		pageDirectoryJson: meta?.page_directory_json || undefined,
		data,
		planes,
		min, max,
		workers: ranges.length,
		timings,
	};
}
