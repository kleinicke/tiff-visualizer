"use strict";

/**
 * Main-thread client for the decode Web Worker (media/decode-worker.js).
 *
 * Boots the worker from a blob URL (VS Code webviews block creating workers
 * directly from webview URIs — same bootstrap the RAW processor uses) and
 * exchanges file bytes / decoded results via zero-copy transfers.
 *
 * Resilient by design: if the worker can't be created, isn't ready yet,
 * crashes, or a decode fails, callers fall back to their local decoder —
 * behavior and performance are then identical to not having a worker at all.
 */

import { PerfTrace } from './perf-trace.js';

const DECODE_TIMEOUT_MS = 30000;
const WASM_FETCH_TIMEOUT_MS = 3000;

export interface DecodeWorkerLike {
	start(): Promise<void>;
	canDecode(format: string): boolean;
	decode(format: string, buffer: ArrayBuffer, options?: Record<string, any>): Promise<any> | null;
	retireAfterDecode?(): void;
}

/**
 * Fetch the first available resource without allowing a broken webview URI to
 * hold worker startup indefinitely.
 */
async function fetchFirstArrayBuffer(urls: string[]): Promise<ArrayBuffer | null> {
	for (const url of urls) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), WASM_FETCH_TIMEOUT_MS);
		try {
			const response = await fetch(url, { signal: controller.signal });
			if (response.ok) {
				return await response.arrayBuffer();
			}
		} catch { /* try next candidate */ }
		finally {
			clearTimeout(timer);
		}
	}
	return null;
}

export class DecodeWorkerClient {
	_workerBundleName: string;
	_needsWasm: boolean;
	_worker: Worker | null;
	_ready: boolean;
	_caps: { tiff?: boolean; tiffWasm?: boolean };
	_pending: Map<number, (response: any) => void>;
	_nextId: number;
	_startPromise: Promise<void> | null;
	_readyResolve: ((caps: any) => void) | undefined;
	_blobUrl: string | null;
	_tiffWasmBytes: ArrayBuffer | null;
	_tiffWasmFetchPromise: Promise<ArrayBuffer | null> | null;
	_tiffWasmModule: WebAssembly.Module | null;
	_tiffWasmCompilePromise: Promise<WebAssembly.Module | null> | null;
	/**
	 * The two on-demand WebAssembly modules — JPEG XL, and the heavy-codec
	 * build — compiled HERE rather than in the worker: blob workers cannot
	 * fetch webview-resource URLs (the same constraint documented in
	 * strip-parallel-decode.ts). Each is fetched the first time a decode
	 * actually needs it and never before, and retained across a worker respawn
	 * so only instantiation is repaid.
	 */
	_extraWasmUrls: { jxl: string[] };
	_extraModulePromises: { jxl: Promise<WebAssembly.Module | null> | null };
	_extraModuleWorkers: { jxl: Worker | null };

	constructor(workerBundleName = 'decodeWorker.bundle.js', needsWasm = true) {
		this._workerBundleName = workerBundleName;
		this._needsWasm = needsWasm;
		this._worker = null;
		this._ready = false;
		this._caps = {};
		this._pending = new Map();
		this._nextId = 1;
		this._startPromise = null;
		this._readyResolve = undefined;
		this._blobUrl = null;
		this._tiffWasmBytes = null;
		this._tiffWasmFetchPromise = null;
		this._tiffWasmModule = null;
		this._tiffWasmCompilePromise = null;
		this._extraWasmUrls = { jxl: [] };
		this._extraModulePromises = { jxl: null };
		this._extraModuleWorkers = { jxl: null };
	}

	/** Begin booting the worker in the background. Never throws. */
	start() {
		if (!this._startPromise) {
			this._startPromise = this._boot().catch(error => {
				console.warn('[DecodeWorker] Unavailable, decoding stays on the main thread:', error);
				this._teardown();
			});
		}
		return this._startPromise;
	}

	async _boot() {
		const warmup = (globalThis as any).__tiffVisualizerDecoderWarmup as {
			bundleName?: string;
			sourcePromise?: Promise<string>;
			wasmBytesPromise?: Promise<ArrayBuffer>;
			getWasmBytes?: () => Promise<ArrayBuffer>;
			wasmModulePromise?: Promise<WebAssembly.Module>;
			workerPromise?: Promise<{
				worker: Worker;
				blobUrl: string;
				caps: { tiff?: boolean; tiffWasm?: boolean };
				wasmModule?: WebAssembly.Module | null;
			}>;
		} | undefined;
		const matchingWarmup = warmup?.bundleName === this._workerBundleName ? warmup : undefined;
		if (matchingWarmup?.workerPromise) {
			try {
				const adopted = await matchingWarmup.workerPromise;
				this._worker = adopted.worker;
				this._blobUrl = adopted.blobUrl;
				this._caps = adopted.caps || {};
				this._tiffWasmModule = adopted.wasmModule || null;
				adopted.worker.onmessage = event => this._onMessage(event.data);
				adopted.worker.onerror = event => {
					if (this._worker !== adopted.worker) { return; }
					console.warn('[DecodeWorker] Adopted worker error:', event.message || event);
					this._teardown();
				};
				this._ready = true;
				console.log(`[DecodeWorker] Adopted warm worker (tiff=${!!this._caps.tiff}, tiffWasm=${!!this._caps.tiffWasm})`);
				return;
			} catch { /* fall through to ordinary startup */ }
		}
		const assets = (globalThis as any).__tiffVisualizerVendorAssets;
		const candidates = [
			assets?.workers?.[this._workerBundleName],
			new URL(`./${this._workerBundleName}`, import.meta.url).href,
			new URL(`../${this._workerBundleName}`, import.meta.url).href,
		].filter(Boolean) as string[];
		const tiffWasmUrls = [
			assets?.wasm,
			new URL('./wasm/tiff-wasm.wasm', import.meta.url).href,
			new URL('../wasm/tiff-wasm.wasm', import.meta.url).href,
		].filter(Boolean) as string[];
		// Recorded but NOT fetched: nothing reads these until a decode asks for
		// one of the modules in `_ensureExtraModule`.
		const wasmCandidates = (configured: string | undefined, name: string) => [
			configured,
			new URL(`./wasm/${name}`, import.meta.url).href,
			new URL(`../wasm/${name}`, import.meta.url).href,
		].filter(Boolean) as string[];
		this._extraWasmUrls = { jxl: wasmCandidates(assets?.jxlWasm, 'jxl-wasm.wasm') };
		if (this._needsWasm && !this._tiffWasmBytes && !this._tiffWasmFetchPromise) {
			const warmBytes = matchingWarmup?.wasmBytesPromise || matchingWarmup?.getWasmBytes?.();
			if (warmBytes) {
				this._tiffWasmFetchPromise = warmBytes
					.then(bytes => {
						this._tiffWasmBytes = bytes;
						return bytes;
					})
					.catch(() => fetchFirstArrayBuffer(tiffWasmUrls))
					.finally(() => { this._tiffWasmFetchPromise = null; });
			} else {
			this._tiffWasmFetchPromise = fetchFirstArrayBuffer(tiffWasmUrls)
				.then(bytes => {
					this._tiffWasmBytes = bytes;
					return bytes;
				})
				.finally(() => {
					this._tiffWasmFetchPromise = null;
				});
			}
		}
		let source: string | null = null;
		if (matchingWarmup?.sourcePromise) {
			try { source = await matchingWarmup.sourcePromise; } catch { /* use ordinary candidates */ }
		}
		for (const url of candidates) {
			if (source) { break; }
			try {
				const response = await fetch(url);
				if (response.ok) {
					source = await response.text();
					break;
				}
			} catch { /* try next candidate */ }
		}
		if (!source) {
			throw new Error(`${this._workerBundleName} not found`);
		}

		const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
		this._blobUrl = blobUrl;
		const worker = new Worker(blobUrl, { type: 'module' });
		this._worker = worker;
		worker.onmessage = (event) => this._onMessage(event.data);
		worker.onerror = (event) => {
			if (this._worker !== worker) {
				return;
			}
			console.warn('[DecodeWorker] Worker error:', event.message || event);
			this._teardown();
		};

		// VS Code webview-resource URLs are authorized in the webview, but a
		// blob worker may be unable to fetch them. Fetch the WASM here and
		// transfer a copy into the worker; retain URLs as a browser fallback.
		const cachedWasmBytes = this._needsWasm ? (this._tiffWasmBytes || await this._tiffWasmFetchPromise) : null;
		// Large decoded rasters retire their worker to release its expanded WASM
		// heap. Keep the immutable compiled module in the webview so the next
		// worker can instantiate it without recompiling the multi-megabyte binary.
		if (!this._tiffWasmModule && !this._tiffWasmCompilePromise && matchingWarmup?.wasmModulePromise) {
			this._tiffWasmCompilePromise = matchingWarmup.wasmModulePromise
				.then(module => {
					this._tiffWasmModule = module;
					return module;
				})
				.catch((): WebAssembly.Module | null => null)
				.finally((): void => { this._tiffWasmCompilePromise = null; });
		} else if (!this._tiffWasmModule && !this._tiffWasmCompilePromise && cachedWasmBytes) {
			this._tiffWasmCompilePromise = WebAssembly.compile(cachedWasmBytes)
				.then(module => {
					this._tiffWasmModule = module;
					return module;
				})
				.catch((error: unknown): WebAssembly.Module | null => {
					console.warn('[DecodeWorker] WASM precompile failed; sending bytes:', error);
					return null;
				})
				.finally((): void => { this._tiffWasmCompilePromise = null; });
		}
		const tiffWasmModule = this._tiffWasmModule || await this._tiffWasmCompilePromise;
		const tiffWasmBuffer = tiffWasmModule ? null : (cachedWasmBytes?.slice(0) || null);
		const caps: any = await new Promise((resolve, reject) => {
			this._readyResolve = resolve;
			setTimeout(() => reject(new Error('worker init timeout')), 20000);
			const initMessage = { type: 'init', tiffWasmModule, tiffWasmBuffer, tiffWasmUrls };
			worker.postMessage(initMessage, tiffWasmBuffer ? [tiffWasmBuffer] : []);
		});
		if (this._worker !== worker) {
			return; // torn down while initializing
		}
		this._caps = caps || {};
		this._ready = true;
		console.log(`[DecodeWorker] Ready (tiff=${!!this._caps.tiff}, tiffWasm=${!!this._caps.tiffWasm})`);
	}

	canDecode(format: string): boolean {
		if (!this._ready || !this._worker) {
			return false;
		}
		// TIFF is routed to this worker only when its primary WASM decoder is
		// available. geotiff.js now belongs exclusively to the lazy webview
		// fallback path.
		if (format === 'tiff' || format === 'tiff-region') {
			return !!this._caps.tiff;
		}
		return true;
	}

	/**
	 * Compile one of the on-demand modules on this thread and hand it to
	 * `worker`, once per worker instance. Resolves to false when the module
	 * cannot be loaded: the worker then fails the decode and
	 * `decodeWithFallback` runs the decoder on the main thread, which can fetch
	 * the payload itself.
	 */
	async _ensureExtraModule(kind: 'jxl', worker: Worker): Promise<boolean> {
		if (this._extraModuleWorkers[kind] === worker) { return true; }
		if (!this._extraModulePromises[kind]) {
			this._extraModulePromises[kind] = (async () => {
				for (const url of this._extraWasmUrls[kind]) {
					try {
						const response = await fetch(url);
						if (response.ok) { return await WebAssembly.compile(await response.arrayBuffer()); }
					} catch { /* try the next candidate */ }
				}
				console.warn(`[DecodeWorker] ${kind} WASM not found for the worker; decoding on the main thread`);
				return null;
			})();
		}
		const compiled = await this._extraModulePromises[kind];
		if (!compiled) { return false; }
		if (this._worker !== worker) { return false; }
		worker.postMessage({ type: 'jxl-module', jxlModule: compiled });
		this._extraModuleWorkers[kind] = worker;
		return true;
	}

	/**
	 * Decode off-thread. Ownership of `buffer` is transferred to the worker.
	 * Resolves to {ok:true, result} on success or {ok:false, error, buffer?}
	 * on failure (with the input bytes transferred back when possible).
	 * Returns null — synchronously, with `buffer` untouched — when the worker
	 * can't handle this format or isn't available.
	 */
	decode(format: string, buffer: ArrayBuffer, options: Record<string, any> = {}): Promise<any> | null {
		if (!this.canDecode(format)) {
			return null;
		}
		const worker = this._worker as Worker;
		const id = this._nextId++;
		return new Promise<any>(resolve => {
			const timer = setTimeout(() => {
				// A hung decode (e.g. a WASM panic loop) must not wedge image
				// loading; kill the worker and let callers decode locally.
				console.warn('[DecodeWorker] Decode timed out, terminating worker');
				this._teardown();
			}, DECODE_TIMEOUT_MS);
			this._pending.set(id, (response) => {
				clearTimeout(timer);
				resolve(response);
			});
			const send = () => {
				worker.postMessage({ id, format, buffer, options }, [buffer]);
			};
			try {
				if (format === 'jxl') {
					this._ensureExtraModule('jxl', worker).then(send, send);
				} else {
					send();
				}
			} catch (error) {
				clearTimeout(timer);
				this._pending.delete(id);
				resolve({ ok: false, error: String(error), buffer });
			}
		});
	}

	_onMessage(msg: any) {
		if (msg && msg.type === 'ready') {
			this._readyResolve?.(msg.caps);
			return;
		}
		if (msg && msg.type === 'caps') {
			this._caps = { ...this._caps, ...msg.caps };
			console.log(`[DecodeWorker] Capabilities updated (tiff=${!!this._caps.tiff}, tiffWasm=${!!this._caps.tiffWasm})`);
			return;
		}
		const resolve = this._pending.get(msg?.id);
		if (resolve) {
			this._pending.delete(msg.id);
			if (msg?.retireWorker === true && this._pending.size === 0) {
				// The result's transferable buffers have already arrived. Terminate
				// before resolving so the old WASM heap is released before WebGL
				// starts its full-raster upload on the continuation microtask.
				this._teardown();
				setTimeout(() => { void this.start(); }, 0);
			}
			resolve(msg);
		}
	}

	/**
	 * Stop CPU work for superseded image loads. Web Workers cannot interrupt a
	 * synchronous decoder, so terminating the worker is the only reliable
	 * cancellation mechanism. It is restarted lazily by the newest load.
	 */
	cancelActiveDecodes(): void {
		if (this._pending.size === 0) {
			return;
		}
		console.log(`[DecodeWorker] Cancelling ${this._pending.size} superseded decode(s)`);
		this._teardown();
	}

	/** Release a WASM heap after a large decode result has safely transferred. */
	retireAfterDecode(): void {
		if (this._pending.size !== 0) { return; }
		this._teardown();
		setTimeout(() => { void this.start(); }, 0);
	}

	_teardown(): void {
		this._ready = false;
		const worker = this._worker;
		this._worker = null;
		try {
			worker?.terminate();
		} catch { /* already gone */ }
		for (const resolve of this._pending.values()) {
			resolve({ ok: false, error: 'decode worker unavailable' });
		}
		this._pending.clear();
		if (this._blobUrl) {
			URL.revokeObjectURL(this._blobUrl);
			this._blobUrl = null;
		}
		this._caps = {};
		this._readyResolve = undefined;
		this._startPromise = null;
	}

	/**
	 * Fetch a source as bytes with consistent performance breakdown for
	 * worker-decoded formats.
	 */
	static async takeSpeculativeDecode(src: string, signal: AbortSignal | undefined, format: string): Promise<any | null> {
		const warmup = (globalThis as any).__tiffVisualizerDecoderWarmup as {
			imageSourceUri?: string;
			speculativeFormat?: string;
			speculativeDecodePromise?: Promise<any>;
			speculativeDecodeMetrics?: { durationMs?: number; fileBytes?: number };
			speculativeDecodeClaimed?: boolean;
			imageBufferClaimed?: boolean;
		} | undefined;
		if (warmup?.imageSourceUri !== src || warmup.speculativeFormat !== format ||
			!warmup.speculativeDecodePromise || warmup.speculativeDecodeClaimed) {
			return null;
		}
		warmup.speculativeDecodeClaimed = true;
		// The speculative request transferred this buffer. If it cannot return the
		// bytes, the ordinary fallback must refetch rather than adopt a detached
		// ArrayBuffer from imageBufferPromise.
		warmup.imageBufferClaimed = true;
		let response: any;
		try {
			response = await warmup.speculativeDecodePromise;
		} catch {
			// Bootstrap work is optional. Let the caller claim the prefetched source
			// bytes or use its ordinary fetch/decode fallback.
			return null;
		}
		if (signal?.aborted) { throw new DOMException('The operation was aborted.', 'AbortError'); }
		const decodeDuration = Number(warmup.speculativeDecodeMetrics?.durationMs || 0);
		if (response && typeof response === 'object') {
			response.bootstrapDecodeDurationMs = decodeDuration;
		}
		PerfTrace.markWithTail(`fetch(${format})`, `decode-worker(${format})`, decodeDuration);
		PerfTrace.note(`fetch-${format}-bytes`, `${(Number(warmup.speculativeDecodeMetrics?.fileBytes || 0) / (1024 * 1024)).toFixed(1)}MB`);
		PerfTrace.note(`decode-${format}-bootstrap`, response?.ok ? 'adopted' : 'fallback');
		return response;
	}

	static async fetchArrayBuffer(src: string, signal: AbortSignal | undefined, format: string): Promise<ArrayBuffer> {
		const warmup = (globalThis as any).__tiffVisualizerDecoderWarmup as {
			imageSourceUri?: string;
			imageBufferPromise?: Promise<ArrayBuffer>;
			sourceReadMetrics?: { responseMs?: number; arrayBufferMs?: number };
			imageBufferClaimed?: boolean;
		} | undefined;
		if (warmup?.imageSourceUri === src && warmup.imageBufferPromise && !warmup.imageBufferClaimed) {
			warmup.imageBufferClaimed = true;
			try {
				const waitStart = performance.now();
				const buffer = await warmup.imageBufferPromise;
				if (signal?.aborted) { throw new DOMException('The operation was aborted.', 'AbortError'); }
				const waitDuration = performance.now() - waitStart;
				const responseDuration = Number(warmup.sourceReadMetrics?.responseMs || 0);
				const readDuration = Number(warmup.sourceReadMetrics?.arrayBufferMs || 0);
				PerfTrace.detail(`fetch-${format}-bootstrap-wait`, waitDuration);
				PerfTrace.detail(`fetch-${format}-response`, responseDuration);
				PerfTrace.detail(`fetch-${format}-arrayBuffer`, readDuration);
				const megabytes = buffer.byteLength / (1024 * 1024);
				PerfTrace.note(`fetch-${format}-bytes`, `${megabytes.toFixed(1)}MB`);
				if (readDuration > 0) {
					PerfTrace.note(`fetch-${format}-arrayBuffer-rate`, `${(megabytes / (readDuration / 1000)).toFixed(0)}MB/s`);
				}
				PerfTrace.mark(`fetch(${format})`);
				return buffer;
			} catch (error) {
				if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) { throw error; }
				// Optional bootstrap failed; preserve the normal fetch path.
			}
		}
		const responseStart = performance.now();
		const response = await fetch(src, { signal });
		PerfTrace.detail(`fetch-${format}-response`, performance.now() - responseStart);
		const readStart = performance.now();
		const buffer = await response.arrayBuffer();
		const readDuration = performance.now() - readStart;
		PerfTrace.detail(`fetch-${format}-arrayBuffer`, readDuration);
		const megabytes = buffer.byteLength / (1024 * 1024);
		PerfTrace.note(`fetch-${format}-bytes`, `${megabytes.toFixed(1)}MB`);
		if (readDuration > 0) {
			PerfTrace.note(`fetch-${format}-arrayBuffer-rate`, `${(megabytes / (readDuration / 1000)).toFixed(0)}MB/s`);
		}
		PerfTrace.mark(`fetch(${format})`);
		return buffer;
	}

	/**
	 * Decode `buffer` via the worker when possible, falling back to
	 * `parseLocal` on the main thread. The buffer may have been transferred
	 * to a failed worker decode; if it can't be recovered, the file is
	 * refetched (rare error path only).
	 */
	static async decodeWithFallback(
		client: DecodeWorkerLike | null | undefined,
		format: string,
		buffer: ArrayBuffer,
		src: string,
		signal: AbortSignal | undefined,
		parseLocal: (buffer: ArrayBuffer, options?: Record<string, any>) => any,
		options: Record<string, any> = {},
	) {
		const workerStart = performance.now();
		const response = client ? await client.decode(format, buffer, options) : null;
		const workerDuration = performance.now() - workerStart;
		if (signal?.aborted) {
			throw new DOMException('Load superseded', 'AbortError');
		}
		if (response?.ok) {
			PerfTrace.mark(`decode-worker(${format})`);
			if (Array.isArray(response.result?.decodeTimings)) {
				let measuredWorkerTime = 0;
				let topLevelDecodeTime = 0;
				for (const timing of response.result.decodeTimings) {
					const durationMs = Number(timing?.durationMs);
					if (!Number.isFinite(durationMs)) { continue; }
					const name = String(timing.name || `${format}-decode-detail`);
					measuredWorkerTime += durationMs;
					if (
						name === `decode-${format}-rust` ||
						name === `decode-${format}-parse-exr` ||
						name === `decode-${format}-upng` ||
						name === `decode-${format}-parse`
					) {
						topLevelDecodeTime += durationMs;
					}
					PerfTrace.detail(name, durationMs);
				}
				PerfTrace.detail(`decode-${format}-worker-transfer+overhead`, workerDuration - (topLevelDecodeTime || measuredWorkerTime));
			}
			return response.result;
		}
		if (response) {
			console.warn(`[DecodeWorker] ${format} worker decode failed, decoding locally:`, response.error);
		}
		let localBuffer = response ? response.buffer : buffer;
		if (!localBuffer || localBuffer.byteLength === 0) {
			const refetched = await fetch(src, { signal });
			localBuffer = await refetched.arrayBuffer();
		}
		const result = await parseLocal(localBuffer, options);
		PerfTrace.mark(`decode-local(${format})`);
		return result;
	}
}
