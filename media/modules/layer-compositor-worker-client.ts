"use strict";

import type { CompositeRegion, CompositeResult, Layer } from './layer-compositor.js';

type TypedPixels = Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array | Int8Array | Int16Array | Int32Array | Float32Array | Float64Array;
type PendingRequest = {
	layers: Layer[];
	width: number;
	height: number;
	scale: number;
	resolve: (result: CompositeResult | null) => void;
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
		region?: CompositeRegion;
	} | null = null;
	private queued: PendingRequest | null = null;
	private lastResult: CompositeResult | null = null;
	private lastStates: LayerState[] | null = null;
	private lastWidth = 0;
	private lastHeight = 0;
	private lastTileStats: TileStat[] | null = null;
	private static readonly TILE_SIZE = 256;

	start(): Promise<void> {
		if (!this.startPromise) {
			this.startPromise = this.boot().catch(error => {
				console.warn('[LayerCompositorWorker] Unavailable; using main-thread fallback:', error);
				this.teardown();
			});
		}
		return this.startPromise;
	}

	private async boot(): Promise<void> {
		const candidates = [
			new URL('./layerCompositorWorker.bundle.js', import.meta.url).href,
			new URL('../layerCompositorWorker.bundle.js', import.meta.url).href,
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
		// esbuild emits a self-contained worker, so classic mode avoids module
		// Blob restrictions on opaque/embedded webview origins.
		const worker = new Worker(this.blobUrl);
		this.worker = worker;
		worker.onmessage = event => this.onMessage(event.data);
		worker.onerror = event => {
			console.warn('[LayerCompositorWorker] Worker error:', event.message || event);
			this.teardown();
		};
		await new Promise<void>((resolve, reject) => {
			this.readyResolve = resolve;
			setTimeout(() => reject(new Error('worker init timeout')), 20_000);
		});
		this.ready = true;
	}

	compose(layers: Layer[], width: number, height: number, scale = 1): Promise<CompositeResult | null> | null {
		if (!this.ready || !this.worker) { return null; }
		return new Promise(resolve => {
			const request: PendingRequest = { layers, width, height, scale, resolve };
			if (this.active) {
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
		if (request.scale === 1 && this.lastResult && this.lastStates && this.lastWidth === request.width && this.lastHeight === request.height) {
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
			this.active.resolve(null);
			this.active = null;
			this.teardown();
		}, COMPOSITE_TIMEOUT_MS);
		this.active = { id, timer, resolve: request.resolve, states, width: request.width, height: request.height, scale: request.scale, region };
		worker.postMessage({ type: 'compose', id, layers: descriptors, assets, width: request.width, height: request.height, scale: request.scale, region }, transfers);
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
		if (message?.type === 'ready') {
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
				this.lastResult = result;
				this.lastStates = active.states;
				this.lastWidth = active.width;
				this.lastHeight = active.height;
				if (!active.region || !this.lastTileStats) { this.lastTileStats = this.buildTileStats(result); }
			}
			console.log(`[LayerCompositorWorker] ${result.width}×${result.height} composed in ${Number(message.durationMs).toFixed(1)}ms`);
			resolve(result);
		} else {
			console.warn('[LayerCompositorWorker] Composition failed:', message.error);
			resolve(null);
		}
		const queued = this.queued;
		this.queued = null;
		if (queued) { this.dispatch(queued); }
	}

	private teardown(): void {
		this.ready = false;
		try { this.worker?.terminate(); } catch { /* already stopped */ }
		this.worker = null;
		if (this.active) {
			clearTimeout(this.active.timer);
			this.active.resolve(null);
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
		this.lastTileStats = null;
		this.readyResolve = null;
		this.startPromise = null;
	}

	dispose(): void { this.teardown(); }
}
