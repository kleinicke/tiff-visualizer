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

	constructor() {
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
		const candidates = [
			new URL('./decodeWorker.bundle.js', import.meta.url).href,
			new URL('../decodeWorker.bundle.js', import.meta.url).href,
		];
		const tiffWasmUrls = [
			new URL('./wasm/tiff-wasm.wasm', import.meta.url).href,
			new URL('../wasm/tiff-wasm.wasm', import.meta.url).href,
		];
		if (!this._tiffWasmBytes && !this._tiffWasmFetchPromise) {
			this._tiffWasmFetchPromise = fetchFirstArrayBuffer(tiffWasmUrls)
				.then(bytes => {
					this._tiffWasmBytes = bytes;
					return bytes;
				})
				.finally(() => {
					this._tiffWasmFetchPromise = null;
				});
		}
		let source = null;
		for (const url of candidates) {
			try {
				const response = await fetch(url);
				if (response.ok) {
					source = await response.text();
					break;
				}
			} catch { /* try next candidate */ }
		}
		if (!source) {
			throw new Error('decodeWorker.bundle.js not found');
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
		const cachedWasmBytes = this._tiffWasmBytes || await this._tiffWasmFetchPromise;
		const tiffWasmBuffer = cachedWasmBytes?.slice(0) || null;
		const caps: any = await new Promise((resolve, reject) => {
			this._readyResolve = resolve;
			setTimeout(() => reject(new Error('worker init timeout')), 20000);
			const initMessage = { type: 'init', tiffWasmBuffer, tiffWasmUrls };
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
		// TIFF is routed to the worker whenever either its WASM decoder or its
		// geotiff.js compatibility fallback is available.
		if (format === 'tiff') {
			return !!this._caps.tiff;
		}
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
			try {
				worker.postMessage({ id, format, buffer, options }, [buffer]);
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
	static async fetchArrayBuffer(src: string, signal: AbortSignal | undefined, format: string): Promise<ArrayBuffer> {
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
		client: DecodeWorkerClient | null | undefined,
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
