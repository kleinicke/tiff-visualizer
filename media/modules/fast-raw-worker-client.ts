"use strict";

import type { DecodeWorkerLike } from './decode-worker-client.js';

const TIMEOUT_MS = 30_000;

export class FastRawWorkerClient implements DecodeWorkerLike {
	private worker: Worker | null = null;
	private ready = false;
	private startPromise: Promise<void> | null = null;
	private blobUrl: string | null = null;
	private nextId = 1;
	private pending = new Map<number, (response: any) => void>();
	private fallback: DecodeWorkerLike | null;

	constructor(fallback: DecodeWorkerLike | null = null) {
		this.fallback = fallback;
	}

	start(): Promise<void> {
		if (!this.startPromise) this.startPromise = this.boot().catch(error => {
			console.warn('[FastRawWorker] Unavailable; using the Rust fallback:', error);
			this.teardown();
		});
		return this.startPromise;
	}

	canDecode(format: string): boolean {
		return this.ready && (format === 'ppm' || format === 'npy' || format === 'pfm');
	}

	private async boot(): Promise<void> {
		const candidates = [
			new URL('./fastRawWorker.bundle.js', import.meta.url).href,
			new URL('../fastRawWorker.bundle.js', import.meta.url).href,
		];
		let source: string | null = null;
		for (const url of candidates) {
			try { const response = await fetch(url); if (response.ok) { source = await response.text(); break; } }
			catch { /* try the next packaged location */ }
		}
		if (!source) throw new Error('fastRawWorker.bundle.js not found');
		this.blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
		const worker = new Worker(this.blobUrl);
		this.worker = worker;
		worker.onmessage = event => {
			if (event.data?.type === 'ready') { this.ready = true; return; }
			const resolve = this.pending.get(event.data?.id);
			if (resolve) { this.pending.delete(event.data.id); resolve(event.data); }
		};
		worker.onerror = () => this.teardown();
		worker.postMessage({ type: 'init' });
		const deadline = performance.now() + 10_000;
		while (!this.ready && this.worker === worker && performance.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 1));
		}
		if (!this.ready) throw new Error('fast raw worker init timeout');
	}

	decode(format: string, buffer: ArrayBuffer, options: Record<string, any> = {}): Promise<any> | null {
		if (format !== 'ppm' && format !== 'npy' && format !== 'pfm') return null;
		if (!this.ready || !this.worker) {
			return this.start().then(() => this.ready && this.worker
				? this.decode(format, buffer, options)
				: { ok: false, error: 'fast raw worker unavailable', buffer });
		}
		return this.decodeFast(format, buffer, options).then(async response => {
			if (response?.ok || !response?.buffer || !this.fallback) return response;
			await this.fallback.start();
			return this.fallback.decode(format, response.buffer, options) || response;
		});
	}

	private decodeFast(format: string, buffer: ArrayBuffer, options: Record<string, any>): Promise<any> {
		const id = this.nextId++;
		const worker = this.worker;
		return new Promise(resolve => {
			const timer = setTimeout(() => { this.teardown(); resolve({ ok: false, error: 'fast raw worker timeout' }); }, TIMEOUT_MS);
			this.pending.set(id, response => { clearTimeout(timer); resolve(response); });
			try { worker.postMessage({ id, format, buffer, options }, [buffer]); }
			catch (error) { clearTimeout(timer); this.pending.delete(id); resolve({ ok: false, error: String(error), buffer }); }
		});
	}

	cancelActiveDecodes(): void {
		if (this.pending.size) this.teardown();
	}

	dispose(): void { this.teardown(); }

	private teardown(): void {
		try { this.worker?.terminate(); } catch { /* already gone */ }
		this.worker = null;
		this.ready = false;
		for (const resolve of this.pending.values()) resolve({ ok: false, error: 'fast raw worker unavailable' });
		this.pending.clear();
		if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
		this.blobUrl = null;
		this.startPromise = null;
	}
}
