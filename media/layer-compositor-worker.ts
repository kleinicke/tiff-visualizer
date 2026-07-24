"use strict";

import { composite, compositeRegion, type CompositeResult, type Layer } from './modules/layer-compositor.js';

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

self.onmessage = (event: MessageEvent) => {
	const message = event.data;
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
		const result: CompositeResult = requestedRegion
			? compositeRegion(layers, width, height, requestedRegion)
			: composite(layers, width, height);
		self.postMessage({
			type: 'composite-result',
			id: message.id,
			result,
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

self.postMessage({ type: 'ready' });
