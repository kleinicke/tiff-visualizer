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
}

/** Decode independently compressed EXR ZIP16 blocks across the shared pool. */
export async function decodeExrZipBlocks(plan: ExrZipBlockPlan): Promise<{
	data: Float32Array;
	min: number;
	max: number;
	workers: number;
	durationMs: number;
} | null> {
	const { width, height, dataY, counts, yCoordinates, compressed } = plan;
	if (counts.length < MIN_PARALLEL_TIFF_STRIPS || counts.length !== yCoordinates.length
		|| width * height < MIN_PARALLEL_TIFF_PIXELS) { return null; }
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

	const workerCount = Math.min(pool.size, counts.length);
	const target = totalCompressed / workerCount;
	const ranges: { first: number; last: number }[] = [];
	let cursor = 0;
	for (let workerIndex = 0; workerIndex < workerCount && cursor < counts.length; workerIndex++) {
		const remainingWorkers = workerCount - workerIndex;
		const maxEnd = counts.length - (remainingWorkers - 1);
		let end = cursor;
		let bytes = 0;
		while (end < maxEnd && (bytes < target || end === cursor)) { bytes += counts[end++]; }
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
		}, [blob.buffer, rangeCounts.buffer, rangeRows.buffer], workerIndex);
	});

	const output = new Float32Array(width * height);
	let min = Infinity;
	let max = -Infinity;
	try {
		await Promise.all(jobs.map(async (job, index) => {
			const part = await job;
			const row = yCoordinates[ranges[index].first] - dataY;
			output.set(part.samples, row * width);
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
	return { data: output, min, max, workers: ranges.length, durationMs };
}

/**
 * Decode `buffer` across the pool, or return `null` when this file is not a
 * shape the parallel path handles (the caller then uses the normal route).
 *
 * `wasm` must be an already-initialized main-thread module exposing
 * `tiff_float_strip_plan` and `tiff_strip_metadata`; both parse the IFD only.
 */
export async function tryStripParallelDecode(
	buffer: ArrayBuffer,
	wasm: any,
): Promise<StripParallelResult | null> {
	if (!wasm || typeof wasm.tiff_float_strip_plan !== 'function') { return null; }
	const bytes = new Uint8Array(buffer);

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

	// Balance by COMPRESSED BYTES rather than strip count: strips vary in cost,
	// and an even strip split leaves workers idle (160 strips over 8 workers
	// measured slower than over 6).
	const workerCount = Math.min(activePool.size, stripCount, desiredWorkers);
	let totalBytes = 0;
	for (let i = 0; i < stripCount; i++) { totalBytes += unitBytes(i); }
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
			acc += unitBytes(end);
			end++;
		}
		if (w === workerCount - 1) { end = stripCount; }
		ranges.push({ first: cursor, last: end });
		cursor = end;
		if (remainingStrips <= remainingWorkers) { /* one strip each from here */ }
	}

	const raw = carrierFor(plan.bits_per_sample, plan.sample_format);
	const dispatchStart = performance.now();
	const jobs = ranges.map((range, index) => {
		// Blocks, not units: a tile row contributes `blocksPerUnit` of them.
		const firstBlock = range.first * blocksPerUnit;
		const lastBlock = range.last * blocksPerUnit;
		let blobLength = 0;
		for (let i = firstBlock; i < lastBlock; i++) { blobLength += counts[i]; }
		const blob = new Uint8Array(blobLength);
		const rangeCounts = new Uint32Array(lastBlock - firstBlock);
		let position = 0;
		for (let i = firstBlock; i < lastBlock; i++) {
			const offset = offsets[i];
			const count = counts[i];
			blob.set(bytes.subarray(offset, offset + count), position);
			position += count;
			rangeCounts[i - firstBlock] = count;
		}
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
	let min = Infinity;
	let max = -Infinity;
	let copyMs = 0;
	try {
		await Promise.all(jobs.map(async (job, index) => {
			const part = await job;
			const copyStart = performance.now();
			if (part.transposed) {
				const bandWidth = Number(part.bandWidth);
				const destinationStart = Number(part.destinationStart);
				for (let row = 0; row < outputHeight; row++) {
					const sourceStart = row * bandWidth * channels;
					const destination = (row * outputWidth + destinationStart) * channels;
					data.set(part.samples.subarray(sourceStart, sourceStart + bandWidth * channels), destination);
				}
			} else {
				data.set(part.samples, Number(part.destinationStart) * width * channels);
			}
			copyMs += performance.now() - copyStart;
			if (part.min < min) { min = part.min; }
			if (part.max > max) { max = part.max; }
		}));
	} catch (error) {
		console.warn('[StripPool] Range decode failed, falling back:', error);
		return null;
	}
	timings.push({ name: 'strip-workers', durationMs: performance.now() - dispatchStart });
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
		photometricInterpretation: meta?.photometric_interpretation ?? 1,
		pageCount: meta?.page_count ?? 1,
		allTagsJson: meta?.all_tags_json ?? '[]',
		omeXml: meta?.ome_xml || undefined,
		geoJson: meta?.geo_json || undefined,
		pageDirectoryJson: meta?.page_directory_json || undefined,
		data,
		min, max,
		workers: ranges.length,
		timings,
	};
}
