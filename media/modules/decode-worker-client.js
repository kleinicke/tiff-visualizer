// @ts-check
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

const DECODE_TIMEOUT_MS = 30000;

export class DecodeWorkerClient {
	constructor() {
		/** @type {Worker|null} */
		this._worker = null;
		this._ready = false;
		/** @type {{tiffWasm?: boolean}} */
		this._caps = {};
		/** @type {Map<number, (response: any) => void>} */
		this._pending = new Map();
		this._nextId = 1;
		/** @type {Promise<void>|null} */
		this._startPromise = null;
		/** @type {((caps: any) => void)|undefined} */
		this._readyResolve = undefined;
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
		const worker = new Worker(blobUrl);
		this._worker = worker;
		worker.onmessage = (event) => this._onMessage(event.data);
		worker.onerror = (event) => {
			console.warn('[DecodeWorker] Worker error:', event.message || event);
			this._teardown();
		};

		// The worker fetches its own WASM; pass candidate URLs since the
		// blob worker can't resolve paths relative to the bundle location.
		const tiffWasmUrls = [
			new URL('./wasm/tiff-wasm.wasm', import.meta.url).href,
			new URL('../wasm/tiff-wasm.wasm', import.meta.url).href,
		];
		const caps = await new Promise((resolve, reject) => {
			this._readyResolve = resolve;
			setTimeout(() => reject(new Error('worker init timeout')), 20000);
			worker.postMessage({ type: 'init', tiffWasmUrls });
		});
		if (this._worker !== worker) {
			return; // torn down while initializing
		}
		this._caps = caps || {};
		this._ready = true;
		console.log(`[DecodeWorker] Ready (tiffWasm=${!!this._caps.tiffWasm})`);
	}

	/** @param {string} format */
	canDecode(format) {
		if (!this._ready || !this._worker) {
			return false;
		}
		// TIFF is only routed to the worker when its WASM decoder initialized;
		// otherwise the main thread's WASM path stays the fastest option.
		if (format === 'tiff') {
			return !!this._caps.tiffWasm;
		}
		return true;
	}

	/**
	 * Decode off-thread. Ownership of `buffer` is transferred to the worker.
	 * Resolves to {ok:true, result} on success or {ok:false, error, buffer?}
	 * on failure (with the input bytes transferred back when possible).
	 * Returns null — synchronously, with `buffer` untouched — when the worker
	 * can't handle this format or isn't available.
	 * @param {string} format
	 * @param {ArrayBuffer} buffer
	 * @returns {Promise<any>|null}
	 */
	decode(format, buffer) {
		if (!this.canDecode(format)) {
			return null;
		}
		const worker = /** @type {Worker} */ (this._worker);
		const id = this._nextId++;
		return new Promise(resolve => {
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
				worker.postMessage({ id, format, buffer }, [buffer]);
			} catch (error) {
				clearTimeout(timer);
				this._pending.delete(id);
				resolve({ ok: false, error: String(error), buffer });
			}
		});
	}

	/** @param {any} msg */
	_onMessage(msg) {
		if (msg && msg.type === 'ready') {
			this._readyResolve?.(msg.caps);
			return;
		}
		const resolve = this._pending.get(msg?.id);
		if (resolve) {
			this._pending.delete(msg.id);
			resolve(msg);
		}
	}

	_teardown() {
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
	}

	/**
	 * Decode `buffer` via the worker when possible, falling back to
	 * `parseLocal` on the main thread. The buffer may have been transferred
	 * to a failed worker decode; if it can't be recovered, the file is
	 * refetched (rare error path only).
	 * @param {DecodeWorkerClient|null|undefined} client
	 * @param {string} format
	 * @param {ArrayBuffer} buffer
	 * @param {string} src
	 * @param {AbortSignal|undefined} signal
	 * @param {(buffer: ArrayBuffer) => any} parseLocal
	 */
	static async decodeWithFallback(client, format, buffer, src, signal, parseLocal) {
		const response = client ? await client.decode(format, buffer) : null;
		if (signal?.aborted) {
			throw new DOMException('Load superseded', 'AbortError');
		}
		if (response?.ok) {
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
		return parseLocal(localBuffer);
	}
}
