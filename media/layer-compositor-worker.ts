"use strict";

import { composite, compositeRegion, type CompositeResult, type Layer } from './modules/layer-compositor.js';
import initTiffWasm, { RgbaLayerCompositor } from './wasm/tiff-wasm.js';

declare const self: any;

type TypedPixels = Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array | Int8Array | Int16Array | Int32Array | Float32Array | Float64Array;
type AssetMessage = { id: number; data: TypedPixels };
type LayerMessage = Omit<Layer, 'data' | 'rasterMask'> & {
	key: string;
	signature: string;
	dataAssetId?: number;
	rasterMask?: Omit<NonNullable<Layer['rasterMask']>, 'data'> & { dataAssetId: number };
};

const assets = new Map<number, TypedPixels>();
const stableLayers = new Map<string, { signature: string; layer: Layer }>();
const scaledAssets = new Map<string, TypedPixels>();
let rustCompositorReady = false;

const RUST_BLEND_MODES = new Map<string, number>([
	['normal', 0], ['multiply', 1], ['screen', 2], ['overlay', 3],
	['darken', 4], ['lighten', 5], ['difference', 6], ['exclusion', 7],
]);

function rustComposite(layers: Layer[], width: number, height: number): CompositeResult | null {
	if (!rustCompositorReady) { return null; }
	const visible = layers.filter(layer => layer.visible !== false && (layer.opacity ?? 1) > 0);
	if (!visible.length || visible.some(layer =>
		(layer.kind && layer.kind !== 'raster') || layer.parentId || layer.clipped ||
		layer.rasterMask || layer.maskCondition || layer.channels !== 4 || !layer.data ||
		!RUST_BLEND_MODES.has(layer.blendMode || 'normal') ||
		!(layer.data instanceof Uint8Array || layer.data instanceof Uint8ClampedArray ||
			layer.data instanceof Uint16Array || layer.data instanceof Float32Array) ||
		((layer.data instanceof Uint8Array || layer.data instanceof Uint8ClampedArray) && (layer.typeMax || 255) !== 255))) {
		return null;
	}
	const typeMax = visible[0].typeMax || 1;
	let compositor: any = null;
	try {
		compositor = new RgbaLayerCompositor(width, height, typeMax);
		for (const layer of visible) {
			const mode = RUST_BLEND_MODES.get(layer.blendMode || 'normal') || 0;
			const x = Math.round(layer.offsetX || 0), y = Math.round(layer.offsetY || 0);
			const opacity = Math.max(0, Math.min(1, layer.opacity ?? 1));
			if (layer.data instanceof Uint16Array) {
				compositor.add_u16(layer.data, layer.width, layer.height, layer.typeMax || 65535, x, y, opacity, mode);
			} else if (layer.data instanceof Float32Array) {
				compositor.add_f32(layer.data, layer.width, layer.height, layer.typeMax || 1, x, y, opacity, mode);
			} else {
				compositor.add_u8(layer.data as Uint8Array, layer.width, layer.height, x, y, opacity, mode);
			}
		}
		const coveredCount = compositor.covered_count;
		const min = compositor.min_value, max = compositor.max_value;
		const data = compositor.take_data();
		return {
			data, width, height, channels: 4,
			isFloat: visible.some(layer => !!layer.isFloat),
			typeMax, stats: { min, max }, coveredCount,
		};
	} catch (error) {
		console.warn('[LayerCompositorWorker] Rust composition failed; retaining TypeScript fallback:', error);
		return null;
	} finally {
		compositor?.free();
	}
}

function scaledPixels(source: TypedPixels, sourceWidth: number, sourceHeight: number, channels: number, targetWidth: number, targetHeight: number, key: string): TypedPixels {
	if (sourceWidth === targetWidth && sourceHeight === targetHeight) { return source; }
	const cached = scaledAssets.get(key);
	if (cached) { return cached; }
	const Constructor = source.constructor as { new(length: number): TypedPixels };
	const output = new Constructor(targetWidth * targetHeight * channels);
	for (let y = 0; y < targetHeight; y++) {
		const sourceY = Math.min(sourceHeight - 1, Math.floor((y + 0.5) * sourceHeight / targetHeight));
		for (let x = 0; x < targetWidth; x++) {
			const sourceX = Math.min(sourceWidth - 1, Math.floor((x + 0.5) * sourceWidth / targetWidth));
			const sourceOffset = (sourceY * sourceWidth + sourceX) * channels;
			const targetOffset = (y * targetWidth + x) * channels;
			for (let channel = 0; channel < channels; channel++) { output[targetOffset + channel] = source[sourceOffset + channel]; }
		}
	}
	scaledAssets.set(key, output);
	return output;
}

function hydrateLayer(message: LayerMessage, scale: number): Layer {
	const sourceData = message.dataAssetId === undefined ? undefined : assets.get(message.dataAssetId);
	const width = Math.max(1, Math.round(message.width * scale));
	const height = Math.max(1, Math.round(message.height * scale));
	const data = sourceData && message.dataAssetId !== undefined
		? scaledPixels(sourceData, message.width, message.height, message.channels, width, height, `${message.dataAssetId}:${width}x${height}:${message.channels}`)
		: undefined;
	let rasterMask: Layer['rasterMask'];
	if (message.rasterMask) {
		const maskSource = assets.get(message.rasterMask.dataAssetId);
		if (maskSource) {
			const maskChannels = Math.max(1, message.rasterMask.channels || 1);
			const maskWidth = Math.max(1, Math.round(message.rasterMask.width * scale));
			const maskHeight = Math.max(1, Math.round(message.rasterMask.height * scale));
			rasterMask = {
				...message.rasterMask,
				data: scaledPixels(maskSource, message.rasterMask.width, message.rasterMask.height, maskChannels, maskWidth, maskHeight, `mask:${message.rasterMask.dataAssetId}:${maskWidth}x${maskHeight}:${maskChannels}`),
				width: maskWidth,
				height: maskHeight,
				offsetX: Math.round((message.rasterMask.offsetX || 0) * scale),
				offsetY: Math.round((message.rasterMask.offsetY || 0) * scale),
			};
			delete (rasterMask as any).dataAssetId;
		}
	}
	const signature = `${message.signature}@${scale}`;
	const stableKey = `${message.key}@${scale}`;
	const existing = stableLayers.get(stableKey);
	if (existing?.signature === signature) { return existing.layer; }
	const layer: Layer = {
		...message,
		data,
		width,
		height,
		offsetX: Math.round((message.offsetX || 0) * scale),
		offsetY: Math.round((message.offsetY || 0) * scale),
		rasterMask,
	};
	delete (layer as any).key;
	delete (layer as any).signature;
	delete (layer as any).dataAssetId;
	stableLayers.set(stableKey, { signature, layer });
	return layer;
}

self.onmessage = async (event: MessageEvent) => {
	const message = event.data;
	if (message?.type === 'init-wasm') {
		try {
			if (message.buffer?.byteLength) {
				await initTiffWasm({ module_or_path: message.buffer });
				rustCompositorReady = true;
			}
		} catch (error) {
			console.warn('[LayerCompositorWorker] Rust/WASM initialization failed; retaining TypeScript fallback:', error);
		}
		self.postMessage({ type: 'caps', rustCompositor: rustCompositorReady });
		return;
	}
	if (message?.type !== 'compose') { return; }
	const started = performance.now();
	try {
		for (const asset of message.assets as AssetMessage[]) {
			assets.set(asset.id, asset.data);
		}
		const scale = Math.max(0.01, Math.min(1, Number(message.scale) || 1));
		const width = Math.max(1, Math.round(message.width * scale));
		const height = Math.max(1, Math.round(message.height * scale));
		const activeKeys = new Set<string>();
		const layers = (message.layers as LayerMessage[]).map(layer => {
			activeKeys.add(layer.key);
			return hydrateLayer(layer, scale);
		});
		for (const key of stableLayers.keys()) {
			const baseKey = key.slice(0, key.lastIndexOf('@'));
			if (!activeKeys.has(baseKey)) { stableLayers.delete(key); }
		}
		const requestedRegion = message.region && scale === 1 ? message.region : undefined;
		const rustResult = requestedRegion ? null : rustComposite(layers, width, height);
		const result: CompositeResult = requestedRegion
			? compositeRegion(layers, width, height, requestedRegion)
			: rustResult || composite(layers, width, height);
		self.postMessage({
			type: 'composite-result',
			id: message.id,
			result,
			backend: rustResult ? 'rust-wasm' : 'typescript',
			scale,
			durationMs: performance.now() - started,
			region: requestedRegion,
		}, [result.data.buffer]);
	} catch (error) {
		self.postMessage({
			type: 'composite-error',
			id: message.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
};

self.postMessage({ type: 'ready', caps: { rustCompositor: false } });
