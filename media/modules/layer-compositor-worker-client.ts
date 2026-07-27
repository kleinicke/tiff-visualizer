"use strict";

import type { CompositeRegion, CompositeResult, Layer } from './layer-compositor.js';

export type LayerCompositorBackend = 'webgpu' | 'gpu' | 'wasm' | 'javascript';
export type LayerCompositorBackendSelection = 'auto' | LayerCompositorBackend;
type WorkerCompositorBackend = Exclude<LayerCompositorBackend, 'webgpu' | 'gpu'>;

type TypedPixels = Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array | Int8Array | Int16Array | Int32Array | Float32Array | Float64Array;
type PendingRequest = {
	layers: Layer[];
	width: number;
	height: number;
	scale: number;
	backend: WorkerCompositorBackend;
	resolve: (result: CompositeResult | null) => void;
	reject: (error: Error) => void;
};
type LayerState = {
	key: string;
	signature: string;
	kind: Layer['kind'];
	parentId?: string;
	clipped: boolean;
	hasMask: boolean;
	visible: boolean;
	opacity: number;
	blendMode: string;
	channels: number;
	isFloat: boolean;
	typeMax: number;
	x: number;
	y: number;
	width: number;
	height: number;
};
type TileStat = { min: number; max: number; covered: number };

const COMPOSITE_TIMEOUT_MS = 120_000;
export const INTERACTIVE_COMPOSITE_MAX_EDGE = 768;
export const INTERACTIVE_PREVIEW_DOCUMENT_EDGE_THRESHOLD = 1500;

export function shouldUseLayerInteractionPreview(width: number, height: number): boolean {
	return width > INTERACTIVE_PREVIEW_DOCUMENT_EDGE_THRESHOLD ||
		height > INTERACTIVE_PREVIEW_DOCUMENT_EDGE_THRESHOLD;
}

/**
 * The layer editor keeps original pixels at full precision. Interactive edits
 * use a bounded preview, then settle to the native document resolution.
 */
export function layerDisplayScale(width: number, height: number, interactive = false): number {
	const edge = Math.max(1, width, height);
	return interactive && shouldUseLayerInteractionPreview(width, height)
		? Math.min(1, INTERACTIVE_COMPOSITE_MAX_EDGE / edge)
		: 1;
}

function clonePixels(source: ArrayLike<number>): TypedPixels {
	if (ArrayBuffer.isView(source)) {
		const view = source as unknown as TypedPixels;
		const Constructor = view.constructor as { new(source: ArrayLike<number>): TypedPixels };
		return new Constructor(view);
	}
	return Float32Array.from(source);
}

function layerSignature(layer: Layer, dataAssetId?: number, maskAssetId?: number): string {
	return JSON.stringify({
		id: layer.id, kind: layer.kind, parentId: layer.parentId, width: layer.width, height: layer.height,
		channels: layer.channels, isFloat: layer.isFloat, typeMax: layer.typeMax,
		offsetX: layer.offsetX, offsetY: layer.offsetY, opacity: layer.opacity, blendMode: layer.blendMode,
		visible: layer.visible, clipped: layer.clipped, maskCondition: layer.maskCondition,
		adjustment: layer.adjustment, dataAssetId, maskAssetId,
		rasterMask: layer.rasterMask ? {
			width: layer.rasterMask.width, height: layer.rasterMask.height, channels: layer.rasterMask.channels,
			typeMax: layer.rasterMask.typeMax, offsetX: layer.rasterMask.offsetX, offsetY: layer.rasterMask.offsetY,
			invert: layer.rasterMask.invert,
		} : undefined,
	});
}

export class LayerCompositorWorkerClient {
	private logger: (message: string) => void = message => console.log(message);
	private worker: Worker | null = null;
	private ready = false;
	private startPromise: Promise<void> | null = null;
	private readyResolve: (() => void) | null = null;
	private blobUrl: string | null = null;
	private nextRequestId = 1;
	private nextAssetId = 1;
	private assetIds = new WeakMap<object, number>();
	private sentAssets = new Set<number>();
	private active: {
		id: number;
		timer: ReturnType<typeof setTimeout>;
		resolve: (result: CompositeResult | null) => void;
		states: LayerState[];
		width: number;
		height: number;
		scale: number;
		backend: WorkerCompositorBackend;
		region?: CompositeRegion;
		reject: (error: Error) => void;
	} | null = null;
	private queued: PendingRequest | null = null;
	private rustCompositor = false;
	private rustCapabilityKnown = false;
	private rustCapabilityWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
	private lastResult: CompositeResult | null = null;
	private lastStates: LayerState[] | null = null;
	private lastWidth = 0;
	private lastHeight = 0;
	private lastBackend: WorkerCompositorBackend | null = null;
	private lastTileStats: TileStat[] | null = null;
	private static readonly TILE_SIZE = 256;

	setLogger(logger: (message: string) => void): void {
		this.logger = logger;
	}

	invalidateCompositeCache(): void {
		this.lastResult = null;
		this.lastStates = null;
		this.lastWidth = 0;
		this.lastHeight = 0;
		this.lastBackend = null;
		this.lastTileStats = null;
	}

	start(): Promise<void> {
		if (!this.startPromise) {
			this.startPromise = this.boot().catch(error => {
				console.warn('[LayerCompositorWorker] Unavailable; using main-thread fallback:', error);
				this.teardown();
			});
		}
		return this.startPromise;
	}

	async isWasmAvailable(): Promise<boolean> {
		await this.start();
		if (!this.ready || !this.worker) { return false; }
		if (this.rustCapabilityKnown) { return this.rustCompositor; }
		try {
			await this.waitForRustCapability();
			return true;
		} catch {
			return false;
		}
	}

	private async boot(): Promise<void> {
		const candidates = [
			new URL('./layerCompositorWorker.bundle.js', import.meta.url).href,
			new URL('../layerCompositorWorker.bundle.js', import.meta.url).href,
		];
		const wasmCandidates = [
			new URL('./wasm/tiff-wasm.wasm', import.meta.url).href,
			new URL('../wasm/tiff-wasm.wasm', import.meta.url).href,
		];
		let source: string | null = null;
		for (const url of candidates) {
			try {
				const response = await fetch(url);
				if (response.ok) { source = await response.text(); break; }
			} catch { /* try next candidate */ }
		}
		if (!source) { throw new Error('layerCompositorWorker.bundle.js not found'); }
		this.blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
		const worker = new Worker(this.blobUrl);
		this.worker = worker;
		worker.onmessage = event => this.onMessage(event.data);
		worker.onerror = event => {
			console.warn('[LayerCompositorWorker] Worker error:', event.message || event);
			this.teardown();
		};
		const ready = new Promise<void>((resolve, reject) => {
			this.readyResolve = resolve;
			setTimeout(() => reject(new Error('worker init timeout')), 20_000);
		});
		let wasmPosted = false;
		for (const url of wasmCandidates) {
			try {
				const response = await fetch(url);
				if (!response.ok) { continue; }
				const buffer = await response.arrayBuffer();
				worker.postMessage({ type: 'init-wasm', buffer }, [buffer]);
				wasmPosted = true;
				break;
			} catch { /* the worker retains its TypeScript fallback */ }
		}
		if (!wasmPosted) { this.resolveRustCapability(false); }
		await ready;
		this.ready = true;
	}

	private waitForRustCapability(): Promise<void> {
		if (this.rustCapabilityKnown) {
			return this.rustCompositor
				? Promise.resolve()
				: Promise.reject(new Error('Rust/Wasm compositor initialization failed'));
		}
		return new Promise((resolve, reject) => {
			const waiter = { resolve, reject };
			this.rustCapabilityWaiters.push(waiter);
			setTimeout(() => {
				const index = this.rustCapabilityWaiters.indexOf(waiter);
				if (index < 0) { return; }
				this.rustCapabilityWaiters.splice(index, 1);
				reject(new Error('Timed out waiting for the Rust/Wasm compositor to initialize'));
			}, 20_000);
		});
	}

	private resolveRustCapability(available: boolean): void {
		this.rustCompositor = available;
		this.rustCapabilityKnown = true;
		const waiters = this.rustCapabilityWaiters.splice(0);
		for (const waiter of waiters) {
			if (available) { waiter.resolve(); }
			else { waiter.reject(new Error('Rust/Wasm compositor initialization failed')); }
		}
	}

	compose(
		layers: Layer[],
		width: number,
		height: number,
		scale = 1,
		backend?: WorkerCompositorBackend,
	): Promise<CompositeResult | null> | null {
		if (!this.ready || !this.worker) {
			if (!backend) { return null; }
			return this.start().then(() => {
				if (!this.ready || !this.worker) {
					throw new Error(`The ${backend === 'wasm' ? 'Rust/Wasm' : 'JavaScript'} compositor worker is unavailable`);
				}
				return this.compose(layers, width, height, scale, backend) as Promise<CompositeResult | null>;
			});
		}
		if (backend === 'wasm' && !this.rustCompositor) {
			return this.waitForRustCapability().then(() =>
				this.compose(layers, width, height, scale, backend) as Promise<CompositeResult | null>);
		}
		const selectedBackend = backend || (this.rustCompositor ? 'wasm' : 'javascript');
		return new Promise((resolve, reject) => {
			const request: PendingRequest = { layers, width, height, scale, backend: selectedBackend, resolve, reject };
			if (this.active) {
				// A settled native render can be hundreds of MB and cannot be
				// interrupted from inside a synchronous Wasm call. If a newer
				// interactive preview arrives, terminate that stale worker and
				// restart immediately instead of making the UI wait for work
				// whose result is already obsolete.
				if (scale < 1 && this.active.scale === 1) {
					const superseded = this.active;
					clearTimeout(superseded.timer);
					this.active = null;
					superseded.resolve(null);
					this.queued?.resolve(null);
					this.queued = null;
					this.teardown();
					void this.start().then(() => {
						if (!this.ready || !this.worker) {
							throw new Error(`The ${selectedBackend === 'wasm' ? 'Rust/Wasm' : 'JavaScript'} compositor worker could not restart`);
						}
						this.dispatch(request);
					}).catch(reject);
					return;
				}
				this.queued?.resolve(null);
				this.queued = request;
			} else {
				this.dispatch(request);
			}
		});
	}

	private assetId(data: ArrayLike<number> | undefined, assets: { id: number; data: TypedPixels }[], transfers: ArrayBuffer[]): number | undefined {
		if (!data || (typeof data !== 'object' && typeof data !== 'function')) { return undefined; }
		const object = data as object;
		let id = this.assetIds.get(object);
		if (!id) { id = this.nextAssetId++; this.assetIds.set(object, id); }
		if (!this.sentAssets.has(id)) {
			const copy = clonePixels(data);
			assets.push({ id, data: copy });
			transfers.push(copy.buffer as ArrayBuffer);
			this.sentAssets.add(id);
		}
		return id;
	}

	private dispatch(request: PendingRequest): void {
		const worker = this.worker;
		if (!worker || !this.ready) { request.resolve(null); return; }
		const assets: { id: number; data: TypedPixels }[] = [];
		const transfers: ArrayBuffer[] = [];
		const states: LayerState[] = [];
		const descriptors = request.layers.map((layer, index) => {
			const dataAssetId = this.assetId(layer.data, assets, transfers);
			const maskAssetId = this.assetId(layer.rasterMask?.data, assets, transfers);
			const rasterMask = layer.rasterMask && maskAssetId !== undefined ? {
				width: layer.rasterMask.width, height: layer.rasterMask.height, channels: layer.rasterMask.channels,
				typeMax: layer.rasterMask.typeMax, offsetX: layer.rasterMask.offsetX, offsetY: layer.rasterMask.offsetY,
				invert: layer.rasterMask.invert, dataAssetId: maskAssetId,
			} : undefined;
			const signature = layerSignature(layer, dataAssetId, maskAssetId);
			const key = String(layer.id || `index-${index}`);
			states.push({
				key,
				signature,
				kind: layer.kind || 'raster',
				parentId: layer.parentId,
				clipped: !!layer.clipped,
				hasMask: !!layer.rasterMask,
				visible: layer.visible !== false,
				opacity: layer.opacity ?? 1,
				blendMode: layer.blendMode || 'normal',
				channels: layer.channels,
				isFloat: !!layer.isFloat,
				typeMax: layer.typeMax ?? 1,
				x: Math.round(layer.offsetX || 0),
				y: Math.round(layer.offsetY || 0),
				width: layer.width,
				height: layer.height,
			});
			const descriptor: any = {
				...layer,
				key,
				signature,
				data: undefined,
				dataAssetId,
				rasterMask,
			};
			return descriptor;
		});
		let region: CompositeRegion | undefined;
		if (request.backend === 'javascript' && this.lastBackend === 'javascript' && request.scale === 1
			&& this.lastResult && this.lastStates && this.lastWidth === request.width && this.lastHeight === request.height) {
			const dirty = this.dirtyRegion(this.lastStates, states, request.width, request.height);
			if (dirty === 'unchanged') {
				request.resolve(this.lastResult);
				const queued = this.queued; this.queued = null;
				if (queued) { this.dispatch(queued); }
				return;
			}
			if (dirty) { region = dirty; }
		}
		const id = this.nextRequestId++;
		const timer = setTimeout(() => {
			if (this.active?.id !== id) { return; }
			console.warn('[LayerCompositorWorker] Composition timed out; restarting worker');
			this.active.reject(new Error(`${request.backend} composition timed out after ${COMPOSITE_TIMEOUT_MS}ms`));
			this.active = null;
			this.teardown();
		}, COMPOSITE_TIMEOUT_MS);
		this.active = {
			id, timer, resolve: request.resolve, reject: request.reject, states,
			width: request.width, height: request.height, scale: request.scale,
			backend: request.backend, region,
		};
		worker.postMessage({
			type: 'compose', id, layers: descriptors, assets, width: request.width,
			height: request.height, scale: request.scale, region,
			requestedBackend: request.backend,
		}, transfers);
	}

	private dirtyRegion(previous: LayerState[], next: LayerState[], width: number, height: number): CompositeRegion | 'unchanged' | null {
		if (previous.length !== next.length || previous.some((state, index) => state.key !== next[index].key)) { return null; }
		if (this.outputFormat(previous) !== this.outputFormat(next)) { return null; }
		const changed: number[] = [];
		for (let index = 0; index < next.length; index++) if (previous[index].signature !== next[index].signature) { changed.push(index); }
		if (!changed.length) { return 'unchanged'; }
		let left = width, top = height, right = 0, bottom = 0;
		for (const index of changed) {
			const before = previous[index], after = next[index];
			// Adjustment/group, clipped-raster, and mask edits can alter scope
			// outside a simple drawable rectangle; keep those on the full path.
			if (before.kind !== 'raster' || after.kind !== 'raster' || before.clipped || after.clipped || before.hasMask || after.hasMask) { return null; }
			if (before.parentId !== after.parentId || before.channels !== after.channels
				|| before.isFloat !== after.isFloat || before.typeMax !== after.typeMax) { return null; }
			for (const state of [before, after]) {
				left = Math.min(left, state.x);
				top = Math.min(top, state.y);
				right = Math.max(right, state.x + state.width);
				bottom = Math.max(bottom, state.y + state.height);
			}
		}
		left = Math.max(0, Math.min(width, left)); top = Math.max(0, Math.min(height, top));
		right = Math.max(left, Math.min(width, right)); bottom = Math.max(top, Math.min(height, bottom));
		if (right <= left || bottom <= top) { return null; }
		const area = (right - left) * (bottom - top);
		if (area >= width * height * 0.65) { return null; }
		return { x: left, y: top, width: right - left, height: bottom - top };
	}

	private outputFormat(states: LayerState[]): string {
		const visible = states.filter(state => state.visible && state.opacity > 0);
		const arithmeticModes = new Set(['add', 'subtract', 'raw-difference', 'raw-multiply', 'divide', 'min', 'max', 'average']);
		const arithmetic = visible.some(state => arithmeticModes.has(state.blendMode));
		const channels = arithmetic
			? (visible.some(state => state.channels >= 3) ? 3 : 1)
			: visible.some(state => state.channels === 2 || state.channels === 4) ? 4 : visible.some(state => state.channels >= 3) ? 3 : 1;
		const isFloat = visible.some(state => state.isFloat) || arithmetic;
		const typeMax = visible[0]?.typeMax ?? 1;
		return `${channels}:${isFloat}:${typeMax}`;
	}

	private mergeRegion(target: CompositeResult, patch: CompositeResult, region: CompositeRegion): CompositeResult | null {
		if (target.channels !== patch.channels || target.typeMax !== patch.typeMax || target.isFloat !== patch.isFloat
			|| patch.width !== region.width || patch.height !== region.height) { return null; }
		for (let y = 0; y < region.height; y++) {
			const sourceStart = y * region.width * patch.channels;
			const targetStart = ((region.y + y) * target.width + region.x) * target.channels;
			target.data.set(patch.data.subarray(sourceStart, sourceStart + region.width * patch.channels), targetStart);
		}
		if (!this.lastTileStats) { this.lastTileStats = this.buildTileStats(target); }
		const tilesAcross = Math.ceil(target.width / LayerCompositorWorkerClient.TILE_SIZE);
		const tileLeft = Math.floor(region.x / LayerCompositorWorkerClient.TILE_SIZE);
		const tileTop = Math.floor(region.y / LayerCompositorWorkerClient.TILE_SIZE);
		const tileRight = Math.floor((region.x + region.width - 1) / LayerCompositorWorkerClient.TILE_SIZE);
		const tileBottom = Math.floor((region.y + region.height - 1) / LayerCompositorWorkerClient.TILE_SIZE);
		for (let tileY = tileTop; tileY <= tileBottom; tileY++) for (let tileX = tileLeft; tileX <= tileRight; tileX++) {
			this.lastTileStats[tileY * tilesAcross + tileX] = this.scanTile(target, tileX, tileY);
		}
		this.applyTileStats(target, this.lastTileStats);
		return target;
	}

	private scanTile(result: CompositeResult, tileX: number, tileY: number): TileStat {
		const size = LayerCompositorWorkerClient.TILE_SIZE;
		const left = tileX * size, top = tileY * size;
		const right = Math.min(result.width, left + size), bottom = Math.min(result.height, top + size);
		const colorChannels = result.channels === 4 ? 3 : result.channels;
		let min = Infinity, max = -Infinity, covered = 0;
		for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
			const offset = (y * result.width + x) * result.channels;
			let pixelCovered = result.channels === 4 ? Number(result.data[offset + 3]) > 0 : false;
			if (result.channels !== 4) {
				for (let channel = 0; channel < colorChannels; channel++) if (Number.isFinite(result.data[offset + channel])) { pixelCovered = true; break; }
			}
			if (!pixelCovered) { continue; }
			covered++;
			for (let channel = 0; channel < colorChannels; channel++) {
				const value = result.data[offset + channel];
				if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); }
			}
		}
		return { min, max, covered };
	}

	private buildTileStats(result: CompositeResult): TileStat[] {
		const tilesAcross = Math.ceil(result.width / LayerCompositorWorkerClient.TILE_SIZE);
		const tilesDown = Math.ceil(result.height / LayerCompositorWorkerClient.TILE_SIZE);
		const output: TileStat[] = [];
		for (let tileY = 0; tileY < tilesDown; tileY++) for (let tileX = 0; tileX < tilesAcross; tileX++) {
			output[tileY * tilesAcross + tileX] = this.scanTile(result, tileX, tileY);
		}
		return output;
	}

	private applyTileStats(result: CompositeResult, tiles: TileStat[]): void {
		let min = Infinity, max = -Infinity, coveredCount = 0;
		for (const tile of tiles) {
			coveredCount += tile.covered;
			if (tile.min < min) { min = tile.min; }
			if (tile.max > max) { max = tile.max; }
		}
		result.stats = min === Infinity ? { min: 0, max: 0 } : { min, max };
		result.coveredCount = coveredCount;
	}

	private onMessage(message: any): void {
		if (message?.type === 'caps') {
			this.resolveRustCapability(!!message.rustCompositor);
			return;
		}
		if (message?.type === 'ready') {
			this.rustCompositor = !!message.caps?.rustCompositor;
			this.readyResolve?.();
			this.readyResolve = null;
			return;
		}
		if (!this.active || message?.id !== this.active.id) { return; }
		clearTimeout(this.active.timer);
		const active = this.active;
		const resolve = active.resolve;
		this.active = null;
		if (message.type === 'composite-result') {
			let result = message.result as CompositeResult;
			(result as CompositeResult & { compositorTiming?: { backend: string; durationMs: number } }).compositorTiming = {
				backend: String(message.backend || active.backend),
				durationMs: Number(message.durationMs || 0),
			};
			if (active.scale === 1 && active.region && this.lastResult) {
				const merged = this.mergeRegion(this.lastResult, result, active.region);
				if (!merged) {
					this.lastResult = null;
					this.lastStates = null;
					this.lastTileStats = null;
					resolve(null);
					const queued = this.queued; this.queued = null;
					if (queued) { this.dispatch(queued); }
					return;
				}
				result = merged;
			}
			if (active.scale === 1) {
				if (active.backend === 'javascript') {
					this.lastResult = result;
					this.lastStates = active.states;
					this.lastWidth = active.width;
					this.lastHeight = active.height;
					this.lastBackend = active.backend;
					// Tile statistics are only needed if a later edit is localized.
					// Building them eagerly repeats a complete main-thread image scan
					// immediately after every worker render.
					if (!active.region) { this.lastTileStats = null; }
				} else {
					this.invalidateCompositeCache();
				}
			}
			this.logger(
				`[LayerCompositorWorker] ${result.width}×${result.height} at ${Math.round(active.scale * 100)}% ` +
				`via ${message.backend || 'unknown'} in ${Number(message.durationMs).toFixed(1)}ms`,
			);
			resolve(result);
		} else {
			const error = new Error(message.error || `${active.backend} composition failed`);
			this.logger(`[LayerCompositorWorker] ${active.backend} failed: ${error.message}`);
			active.reject(error);
		}
		const queued = this.queued;
		this.queued = null;
		if (queued) { this.dispatch(queued); }
	}

	private teardown(): void {
		this.ready = false;
		this.rustCompositor = false;
		this.rustCapabilityKnown = false;
		for (const waiter of this.rustCapabilityWaiters.splice(0)) {
			waiter.reject(new Error('Layer compositor worker stopped during Rust/Wasm initialization'));
		}
		try { this.worker?.terminate(); } catch { /* already stopped */ }
		this.worker = null;
		if (this.active) {
			clearTimeout(this.active.timer);
			this.active.reject(new Error('Layer compositor worker stopped before completing the strict render'));
			this.active = null;
		}
		this.queued?.resolve(null);
		this.queued = null;
		if (this.blobUrl) { URL.revokeObjectURL(this.blobUrl); this.blobUrl = null; }
		this.sentAssets.clear();
		this.assetIds = new WeakMap();
		this.lastResult = null;
		this.lastStates = null;
		this.lastWidth = 0;
		this.lastHeight = 0;
		this.lastBackend = null;
		this.lastTileStats = null;
		this.readyResolve = null;
		this.startPromise = null;
	}

	dispose(): void { this.teardown(); }
}
