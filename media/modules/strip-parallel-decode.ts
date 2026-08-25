"use strict";
/**
 * Parallel TIFF decoding across a pool of workers, one strip range each.
 *
 * Strips in a TIFF are compressed independently, so a contiguous run of them is
 * a self-contained unit of work. `tiff_float_strip_plan` reports the layout
 * from the IFD alone; this module slices the file per worker so each one
 * receives ONLY its own strips' compressed bytes (total bytes crossing the
 * worker boundary is one file's worth, not one copy per worker), then
 * assembles the returned samples.
 *
 * Eligibility is decided in Rust: the plan is returned only for byte-aligned
 * chunky strip layouts with predictor 1/2/3 and no pixel post-processing
 * pending (no orientation flip, palette, CMYK or CFA), so nothing here has to
 * re-implement those transforms.
 *
 * Falls back to `null` for anything it cannot handle; the caller then uses the
 * ordinary single-worker path.
 */
/** Below this many strips the pool costs more than it saves. */
const MIN_STRIPS = 16;
/** Below this many pixels a single worker is already fast enough. */
const MIN_PIXELS = 2_000_000;
/** Cap the pool: more workers than this stops helping and costs memory. */
const MAX_WORKERS = 8;

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
	rowsPerStrip: number;
	stripCount: number;
	photometricInterpretation: number;
	pageCount: number;
	allTagsJson: string;
	omeXml: string | undefined;
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

	/** Spawn the pool once; safe to call repeatedly. */
	async ensure(): Promise<boolean> {
		if (this._workers.length) { return true; }
		if (!this._bootPromise) {
			this._bootPromise = this._boot().catch(error => {
				console.warn('[StripPool] Unavailable, falling back to single-worker decode:', error);
				this._teardown();
				return false;
			});
		}
		return this._bootPromise;
	}

	private async _boot(): Promise<boolean> {
		const candidates = [
			new URL('./stripDecodeWorker.bundle.js', import.meta.url).href,
			new URL('../stripDecodeWorker.bundle.js', import.meta.url).href,
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
			return this._spawn(this._module);
		}
		const warmup = (globalThis as any).__tiffVisualizerDecoderWarmup as {
			wasmModulePromise?: Promise<WebAssembly.Module>;
		} | undefined;
		if (warmup?.wasmModulePromise) {
			try {
				this._module = await warmup.wasmModulePromise;
				return this._spawn(this._module);
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
		return this._spawn(compiled);
	}

	private async _spawn(compiled: WebAssembly.Module): Promise<boolean> {
		const cores = (globalThis.navigator as any)?.hardwareConcurrency || 4;
		// Leave a core for the UI thread and the ordinary decode worker.
		const count = Math.max(2, Math.min(MAX_WORKERS, cores - 1));

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
		this._workers = booted.filter((w): w is PoolWorker => w !== null);
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
	if (stripCount < MIN_STRIPS || width * height < MIN_PIXELS) { return null; }

	const ok = await pool.ensure();
	if (!ok || pool.size < 2) { return null; }

	const channels: number = plan.channels;
	const offsets: Float64Array = plan.offsets;
	const counts: Float64Array = plan.counts;
	const rowsPerStrip: number = plan.rows_per_strip;
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
	const workerCount = Math.min(pool.size, stripCount);
	let totalBytes = 0;
	for (let i = 0; i < stripCount; i++) { totalBytes += counts[i]; }
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
			acc += counts[end];
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
		let blobLength = 0;
		for (let i = range.first; i < range.last; i++) { blobLength += counts[i]; }
		const blob = new Uint8Array(blobLength);
		const rangeCounts = new Uint32Array(range.last - range.first);
		let position = 0;
		for (let i = range.first; i < range.last; i++) {
			const offset = offsets[i];
			const count = counts[i];
			blob.set(bytes.subarray(offset, offset + count), position);
			position += count;
			rangeCounts[i - range.first] = count;
		}
		return pool.run({
			raw: !!raw,
			blob: blob.buffer,
			counts: rangeCounts.buffer,
			firstStrip: range.first,
			width, height, channels,
			bitsPerSample: plan.bits_per_sample,
			compression: plan.compression,
			rowsPerStrip,
			predictor: plan.predictor,
			sampleFormat: plan.sample_format,
			littleEndian: plan.little_endian,
		}, [blob.buffer, rangeCounts.buffer], index);
	});

	// Copy each range in as it ARRIVES rather than after Promise.all: the
	// workers finish at different times, so the copies hide behind the ranges
	// still decoding instead of running as one serial pass at the end.
	const total = width * height * channels;
	const data: Float32Array | Uint16Array | Uint8Array =
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
			data.set(part.samples, ranges[index].first * rowsPerStrip * width * channels);
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

	const meta = await metadataPromise;

	// Retire the pool before returning so its expanded WASM heaps are released
	// on this task, ahead of the caller's WebGL upload. Same reasoning as the
	// decode worker's `retireWorker`, and the same 64MB threshold.
	if (data.byteLength >= 64 * 1024 * 1024) {
		pool.retire();
		setTimeout(() => { void pool.ensure(); }, 0);
		timings.push({ name: 'strip-pool-retired', durationMs: 0 });
	}

	return {
		width, height, channels,
		bitsPerSample: plan.bits_per_sample,
		sampleFormat: plan.sample_format,
		compression: plan.compression,
		predictor: plan.predictor,
		rowsPerStrip,
		stripCount,
		photometricInterpretation: meta?.photometric_interpretation ?? 1,
		pageCount: meta?.page_count ?? 1,
		allTagsJson: meta?.all_tags_json ?? '[]',
		omeXml: meta?.ome_xml || undefined,
		data,
		min, max,
		workers: ranges.length,
		timings,
	};
}
