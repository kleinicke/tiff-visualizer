"use strict";

import { composite, compositeRegion, evaluateCurvePoints, type AdjustmentChannel, type CompositeResult, type Layer, type LayerAdjustment } from './modules/layer-compositor.js';
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
const rustMaskFloatCache = new WeakMap<object, Float32Array>();
let rustCompositorReady = false;

const RUST_BLEND_MODES = new Map<string, number>([
	['normal', 0], ['multiply', 1], ['screen', 2], ['overlay', 3],
	['darken', 4], ['lighten', 5], ['difference', 6], ['exclusion', 7],
	['add', 8], ['subtract', 9], ['raw-difference', 10], ['raw-multiply', 11],
	['divide', 12], ['min', 13], ['max', 14], ['average', 15], ['mask', 16],
]);
const RUST_ARITHMETIC_MODES = new Set(['add', 'subtract', 'raw-difference', 'raw-multiply', 'divide', 'min', 'max', 'average']);

function rustOutputChannels(layers: Layer[]): 1 | 3 | 4 {
	const visible = layers.filter(layer => layer.visible !== false && (layer.opacity ?? 1) > 0);
	if (visible.some(layer => RUST_ARITHMETIC_MODES.has(layer.blendMode || 'normal'))) {
		return visible.some(layer => layer.channels >= 3) ? 3 : 1;
	}
	if (visible.some(layer => layer.channels === 2 || layer.channels === 4)) { return 4; }
	return visible.some(layer => layer.channels >= 3) ? 3 : 1;
}

function adjustmentCurve(value: number, channel: AdjustmentChannel | undefined, typeMax: number): number {
	if (!channel) { return value; }
	if (Array.isArray(channel)) {
		return evaluateCurvePoints(channel, value * 255 / typeMax) * typeMax / 255;
	}
	const input = value * 255 / typeMax;
	const low = channel.shadowInput ?? 0, high = channel.highlightInput ?? 255;
	const gamma = Math.max(0.01, channel.midtoneInput ?? 1);
	const normalized = Math.max(0, Math.min(1, (input - low) / Math.max(1e-6, high - low)));
	const outputLow = channel.shadowOutput ?? 0, outputHigh = channel.highlightOutput ?? 255;
	return (outputLow + Math.pow(normalized, 1 / gamma) * (outputHigh - outputLow)) * typeMax / 255;
}

function rustAdjustmentLut(adjustment: Extract<LayerAdjustment, { type: 'levels' | 'curves' }>, typeMax: number): Float32Array {
	const tables = new Float32Array(256 * 3);
	for (let channel = 0; channel < 3; channel++) {
		const name = ['red', 'green', 'blue'][channel] as 'red' | 'green' | 'blue';
		for (let input = 0; input < 256; input++) {
			const value = input * typeMax / 255;
			tables[channel * 256 + input] = adjustmentCurve(
				adjustmentCurve(value, adjustment.rgb, typeMax),
				adjustment[name],
				typeMax,
			);
		}
	}
	return tables;
}

function rustGradientLut(adjustment: Extract<LayerAdjustment, { type: 'gradient map' }>): Float32Array {
	const defaults = [{ position: 0, color: { r: 0, g: 0, b: 0 } }, { position: 1, color: { r: 255, g: 255, b: 255 } }];
	const stops = (adjustment.stops?.length ? adjustment.stops : defaults)
		.map(stop => ({ ...stop, position: Math.max(0, Math.min(1, stop.position)) }))
		.sort((a, b) => a.position - b.position);
	const output = new Float32Array(256 * 3);
	for (let input = 0; input < 256; input++) {
		const position = adjustment.reverse ? 1 - input / 255 : input / 255;
		let low = stops[0], high = stops[0], amount = 0;
		if (position >= stops[stops.length - 1].position) {
			low = high = stops[stops.length - 1];
		} else if (position > stops[0].position) {
			for (let index = 1; index < stops.length; index++) {
				if (position <= stops[index].position) {
					low = stops[index - 1];
					high = stops[index];
					amount = (position - low.position) / Math.max(1e-6, high.position - low.position);
					break;
				}
			}
		}
		for (let channel = 0; channel < 3; channel++) {
			const name = ['r', 'g', 'b'][channel] as 'r' | 'g' | 'b';
			output[channel * 256 + input] = (low.color[name] + (high.color[name] - low.color[name]) * amount) / 255;
		}
	}
	return output;
}

function rustDirectAdjustment(adjustment: Exclude<LayerAdjustment, { type: 'levels' | 'curves' | 'hue/saturation' }>): { operation: number; parameters: Float32Array } {
	const mixer = (channel: any, fallback: Record<string, number>) => {
		const value = channel || fallback;
		return [value.red ?? 0, value.green ?? 0, value.blue ?? 0, value.constant ?? 0];
	};
	const balance = (value: any) => [value?.cyanRed || 0, value?.magentaGreen || 0, value?.yellowBlue || 0];
	switch (adjustment.type) {
		case 'brightness/contrast':
			return { operation: 2, parameters: new Float32Array([adjustment.brightness || 0, adjustment.contrast || 0]) };
		case 'exposure':
			return { operation: 3, parameters: new Float32Array([adjustment.exposure || 0, adjustment.offset || 0, adjustment.gamma ?? 1]) };
		case 'invert':
			return { operation: 4, parameters: new Float32Array() };
		case 'channel mixer':
			return {
				operation: 5,
				parameters: new Float32Array([
					adjustment.monochrome ? 1 : 0,
					...mixer(adjustment.red, { red: 100 }),
					...mixer(adjustment.green, { green: 100 }),
					...mixer(adjustment.blue, { blue: 100 }),
					...mixer(adjustment.gray, { red: 40, green: 40, blue: 20 }),
				]),
			};
		case 'color balance':
			return {
				operation: 6,
				parameters: new Float32Array([
					...balance(adjustment.shadows), ...balance(adjustment.midtones), ...balance(adjustment.highlights),
					adjustment.preserveLuminosity ? 1 : 0,
				]),
			};
		case 'black & white':
			return { operation: 7, parameters: new Float32Array([
				adjustment.reds ?? 40, adjustment.yellows ?? 60, adjustment.greens ?? 40,
				adjustment.cyans ?? 60, adjustment.blues ?? 20, adjustment.magentas ?? 80,
			]) };
		case 'threshold':
			return { operation: 8, parameters: new Float32Array([adjustment.level ?? 128]) };
		case 'posterize':
			return { operation: 9, parameters: new Float32Array([adjustment.levels ?? 4]) };
		case 'gradient map':
			return { operation: 10, parameters: rustGradientLut(adjustment) };
	}
}

function rustSelectiveHue(adjustment: Extract<LayerAdjustment, { type: 'hue/saturation' }>): Float32Array {
	const values: number[] = [];
	const appendSettings = (settings: Record<string, number> | undefined) => {
		values.push(settings?.hue || 0, settings?.saturation || 0, settings?.lightness || 0);
	};
	appendSettings(adjustment.master);
	for (const name of ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const) {
		const settings = adjustment[name];
		const hasBoundaries = !!settings && ['a', 'b', 'c', 'd'].every(key => Number.isFinite(settings[key]));
		values.push(
			hasBoundaries ? settings!.a : Number.NaN,
			hasBoundaries ? settings!.b : Number.NaN,
			hasBoundaries ? settings!.c : Number.NaN,
			hasBoundaries ? settings!.d : Number.NaN,
			settings?.hue || 0,
			settings?.saturation || 0,
			settings?.lightness || 0,
		);
	}
	return new Float32Array(values);
}

function rustSupportsAdjustment(adjustment: LayerAdjustment | undefined): boolean {
	return !!adjustment;
}

function rustUnsupportedReason(layers: Layer[]): string | null {
	if (!rustCompositorReady) { return 'Rust/Wasm compositor is not initialized'; }
	for (const layer of layers.filter(layer => layer.visible !== false && (layer.opacity ?? 1) > 0)) {
		const label = layer.name || String(layer.id || 'unnamed layer');
		if (layer.rasterMask && !ArrayBuffer.isView(layer.rasterMask.data)) {
			return `"${label}" uses unsupported ${layer.rasterMask.data.constructor?.name || 'mask'} storage`;
		}
		if (layer.kind === 'group') {
			if (!layer.id) { return `"${label}" is a group without an id`; }
			if (!RUST_BLEND_MODES.has(layer.blendMode || 'normal')) { return `"${label}" uses unsupported blend mode "${layer.blendMode}"`; }
			continue;
		}
		if (layer.kind === 'adjustment') {
			if (!rustSupportsAdjustment(layer.adjustment)) {
				return `"${label}" uses an adjustment not yet implemented in Rust/Wasm`;
			}
			continue;
		}
		if (layer.kind && layer.kind !== 'raster') {
			return `"${label}" is a ${layer.kind} layer`;
		}
		if (layer.channels < 1 || layer.channels > 4) { return `"${label}" has unsupported ${layer.channels}-channel pixels`; }
		if (!layer.data) { return `"${label}" has no raster pixels`; }
		if (!RUST_BLEND_MODES.has(layer.blendMode || 'normal')) { return `"${label}" uses unsupported blend mode "${layer.blendMode}"`; }
		if (!(layer.data instanceof Uint8Array || layer.data instanceof Uint8ClampedArray ||
			layer.data instanceof Uint16Array || layer.data instanceof Uint32Array ||
			layer.data instanceof Int8Array || layer.data instanceof Int16Array || layer.data instanceof Int32Array ||
			layer.data instanceof Float32Array || layer.data instanceof Float64Array)) {
			return `"${label}" uses unsupported ${layer.data.constructor?.name || 'pixel'} storage`;
		}
	}
	return null;
}

function rustBeginIsolated(compositor: any, layer: Layer, width: number, height: number, typeMax: number): void {
	const x = Math.round(layer.offsetX || 0), y = Math.round(layer.offsetY || 0);
	if (layer.channels === 4) {
		if (layer.data instanceof Uint8Array || layer.data instanceof Uint8ClampedArray) {
			const data = layer.data instanceof Uint8Array
				? layer.data : new Uint8Array(layer.data.buffer, layer.data.byteOffset, layer.data.byteLength);
			if ((layer.typeMax || 255) === 255) {
				compositor.begin_isolated_u8(data, layer.width, layer.height, x, y);
				return;
			}
		} else if (layer.data instanceof Uint16Array) {
			compositor.begin_isolated_u16(layer.data, layer.width, layer.height, layer.typeMax || 65535, x, y);
			return;
		} else if (layer.data instanceof Float32Array) {
			compositor.begin_isolated_f32(layer.data, layer.width, layer.height, layer.typeMax || 1, x, y);
			return;
		}
	}
	const surface = new RgbaLayerCompositor(width, height, typeMax);
	try {
		rustAddLayer(surface, layer, 1, 0);
		const data = surface.take_data();
		compositor.begin_isolated_f32(data, width, height, typeMax, 0, 0);
	} finally {
		surface.free();
	}
}

function rustApplyAdjustment(compositor: any, adjustment: LayerAdjustment, amount: number, typeMax: number): void {
	if (adjustment.type === 'levels' || adjustment.type === 'curves') {
		compositor.isolated_apply_lut(rustAdjustmentLut(adjustment, typeMax), amount);
	} else if (adjustment.type === 'hue/saturation') {
		const colorize = !!adjustment.colorize && adjustment.colorizeEnabled !== false;
		if (colorize) {
			const settings = adjustment.colorize!;
			compositor.isolated_apply_hue(
				settings.hue || 0,
				(settings.saturation || 0) / 100,
				(settings.lightness || 0) / 100,
				true,
				amount,
			);
		} else {
			compositor.isolated_apply_selective_hue(rustSelectiveHue(adjustment), amount);
		}
	} else {
		const direct = rustDirectAdjustment(adjustment);
		compositor.isolated_apply_direct(direct.operation, direct.parameters, amount);
	}
}

function rustMaskCall(compositor: any, layer: Layer, finishAdjustment: boolean): void {
	const mask = layer.rasterMask;
	if (!mask) { return; }
	const channels = Math.max(1, mask.channels ?? 1), maximum = mask.typeMax || 255;
	const x = Math.round(mask.offsetX ?? layer.offsetX ?? 0), y = Math.round(mask.offsetY ?? layer.offsetY ?? 0);
	const suffix = mask.data instanceof Uint16Array ? 'u16'
		: mask.data instanceof Uint8Array || mask.data instanceof Uint8ClampedArray ? 'u8' : 'f32';
	let data: ArrayLike<number>;
	if (mask.data instanceof Uint8ClampedArray) {
		data = new Uint8Array(mask.data.buffer, mask.data.byteOffset, mask.data.byteLength);
	} else if (suffix === 'f32' && !(mask.data instanceof Float32Array)) {
		const key = mask.data as object;
		let converted = rustMaskFloatCache.get(key);
		if (!converted) { converted = Float32Array.from(mask.data); rustMaskFloatCache.set(key, converted); }
		data = converted;
	} else {
		data = mask.data;
	}
	const method = finishAdjustment
		? `isolated_finish_masked_adjustment_${suffix}`
		: `isolated_apply_alpha_mask_${suffix}`;
	compositor[method](data, mask.width, mask.height, channels, maximum, x, y, !!mask.invert);
}

function rustApplyLayerAdjustment(compositor: any, layer: Layer, typeMax: number): void {
	if (!layer.adjustment) { return; }
	if (layer.rasterMask) { compositor.isolated_begin_masked_adjustment(); }
	rustApplyAdjustment(
		compositor, layer.adjustment,
		Math.max(0, Math.min(1, layer.opacity ?? 1)), typeMax,
	);
	if (layer.rasterMask) { rustMaskCall(compositor, layer, true); }
}

function rustAddLayer(compositor: any, layer: Layer, opacity: number, mode: number): void {
	const x = Math.round(layer.offsetX || 0), y = Math.round(layer.offsetY || 0);
	const channels = layer.channels, maximum = layer.typeMax || 1, data = layer.data as TypedPixels;
	if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
		const view = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		compositor.add_channels_u8(view, layer.width, layer.height, channels, maximum, x, y, opacity, mode);
	} else if (data instanceof Uint16Array) {
		compositor.add_channels_u16(data, layer.width, layer.height, channels, maximum, x, y, opacity, mode);
	} else if (data instanceof Uint32Array) {
		compositor.add_channels_u32(data, layer.width, layer.height, channels, maximum, x, y, opacity, mode);
	} else if (data instanceof Int8Array) {
		compositor.add_channels_i8(data, layer.width, layer.height, channels, maximum, x, y, opacity, mode);
	} else if (data instanceof Int16Array) {
		compositor.add_channels_i16(data, layer.width, layer.height, channels, maximum, x, y, opacity, mode);
	} else if (data instanceof Int32Array) {
		compositor.add_channels_i32(data, layer.width, layer.height, channels, maximum, x, y, opacity, mode);
	} else if (data instanceof Float64Array) {
		compositor.add_channels_f64(data, layer.width, layer.height, channels, maximum, x, y, opacity, mode);
	} else {
		compositor.add_channels_f32(data as Float32Array, layer.width, layer.height, channels, maximum, x, y, opacity, mode);
	}
}

function rustLayerSurface(layer: Layer, width: number, height: number, typeMax: number): Float32Array {
	const compositor = new RgbaLayerCompositor(width, height, typeMax);
	try {
		rustBeginIsolated(compositor, { ...layer, opacity: 1, blendMode: 'normal' }, width, height, typeMax);
		if (layer.rasterMask) { rustMaskCall(compositor, layer, false); }
		compositor.finish_isolated(1, 0);
		return compositor.take_data();
	} finally {
		compositor.free();
	}
}

function rustAdjustedLayerSurface(base: Layer, effects: Layer[], width: number, height: number, typeMax: number): Float32Array {
	const compositor = new RgbaLayerCompositor(width, height, typeMax);
	try {
		rustBeginIsolated(compositor, { ...base, opacity: 1, blendMode: 'normal' }, width, height, typeMax);
		if (base.rasterMask) { rustMaskCall(compositor, base, false); }
		for (const effect of effects) {
			if (effect.visible === false || (effect.opacity ?? 1) <= 0) { continue; }
			if (effect.kind === 'adjustment' && effect.adjustment) {
				rustApplyLayerAdjustment(compositor, effect, typeMax);
			} else if (effect.data) {
				const arithmetic = RUST_ARITHMETIC_MODES.has(effect.blendMode || 'normal');
				const sourceMaximum = arithmetic ? effect.typeMax || typeMax : typeMax;
				const surface = rustLayerSurface(effect, width, height, sourceMaximum);
				const effectMode = RUST_BLEND_MODES.get(effect.blendMode || 'normal') || 0;
				const method = arithmetic
					? 'isolated_add_arithmetic_f32_surface' : 'isolated_add_f32_surface';
				compositor[method](
					surface, sourceMaximum, Math.max(0, Math.min(1, effect.opacity ?? 1)), effectMode,
				);
			}
		}
		return compositor.take_isolated_surface();
	} finally {
		compositor.free();
	}
}

function rustCompositeStack(
	layers: Layer[], width: number, height: number, typeMax: number,
	parentId: string | undefined, ancestors: Set<string>, forceRgba = false,
): CompositeResult {
	let compositor: any = new RgbaLayerCompositor(width, height, typeMax);
	try {
		// Preserve hidden/zero-opacity siblings while resolving clipped chains.
		// Filters remain enabled in the UI when their owning raster is hidden;
		// removing that raster here would incorrectly reattach its filters to the
		// preceding visible image layer.
		const siblings = layers.filter(layer => (layer.parentId || undefined) === parentId);
		for (let index = 0; index < siblings.length;) {
			const node = siblings[index];
			let end = index + 1;
			while (end < siblings.length && siblings[end].clipped) { end++; }
			const effects = siblings.slice(index + 1, end);
			if (node.visible === false || (node.opacity ?? 1) <= 0) {
				index = end;
				continue;
			}
			if (node.kind === 'adjustment' && node.adjustment) {
				const current = compositor.take_data();
				compositor.free();
				compositor = new RgbaLayerCompositor(width, height, typeMax);
				compositor.begin_isolated_f32(current, width, height, typeMax, 0, 0);
				rustApplyLayerAdjustment(compositor, node, typeMax);
				compositor.finish_isolated(1, 0);
				index = end;
				continue;
			}
			let base: Layer = node;
			if (node.kind === 'group') {
				const id = node.id || '';
				if (!id || ancestors.has(id)) { index = end; continue; }
				const nextAncestors = new Set(ancestors); nextAncestors.add(id);
				const child = rustCompositeStack(layers, width, height, typeMax, id, nextAncestors, true);
				base = {
					...node, kind: 'raster', parentId: undefined,
					data: child.data, width, height, channels: 4, typeMax,
				};
			}
			if (!base.data) { index = end; continue; }
			const opacity = Math.max(0, Math.min(1, base.opacity ?? 1));
			const mode = RUST_BLEND_MODES.get(base.blendMode || 'normal') || 0;
			if ((base.blendMode || 'normal') === 'mask') {
				const surface = rustLayerSurface(base, width, height, typeMax);
				const condition = ['gt', 'ge', 'lt', 'le', 'eq', 'isfinite', 'isnan'].indexOf(base.maskCondition?.op || '') + 1;
				const threshold = (base.maskCondition?.threshold || 0) * typeMax / (base.typeMax || typeMax);
				compositor.apply_brightness_mask_f32_surface(surface, typeMax, condition, threshold);
				index = end;
				continue;
			}
			if (RUST_ARITHMETIC_MODES.has(base.blendMode || 'normal') && (effects.length || base.rasterMask)) {
				const sourceMaximum = base.typeMax || typeMax;
				const surface = rustAdjustedLayerSurface(base, effects, width, height, sourceMaximum);
				compositor.add_arithmetic_f32_surface(surface, sourceMaximum, opacity, mode);
				index = end;
				continue;
			}
			if (effects.length || base.rasterMask) {
				rustBeginIsolated(compositor, { ...base, opacity: 1, blendMode: 'normal' }, width, height, typeMax);
				if (base.rasterMask) { rustMaskCall(compositor, base, false); }
				for (const effect of effects) {
					if (effect.visible === false || (effect.opacity ?? 1) <= 0) { continue; }
					if (effect.kind === 'adjustment' && effect.adjustment) {
						rustApplyLayerAdjustment(compositor, effect, typeMax);
					} else if (effect.data) {
						const arithmetic = RUST_ARITHMETIC_MODES.has(effect.blendMode || 'normal');
						const sourceMaximum = arithmetic ? effect.typeMax || typeMax : typeMax;
						const surface = rustLayerSurface(effect, width, height, sourceMaximum);
						const effectMode = RUST_BLEND_MODES.get(effect.blendMode || 'normal') || 0;
						const method = arithmetic
							? 'isolated_add_arithmetic_f32_surface' : 'isolated_add_f32_surface';
						compositor[method](
							surface, sourceMaximum,
							Math.max(0, Math.min(1, effect.opacity ?? 1)),
							effectMode,
						);
					}
				}
				compositor.finish_isolated(opacity, mode);
			} else {
				rustAddLayer(compositor, base, opacity, mode);
			}
			index = end;
		}
		const coveredCount = compositor.covered_count;
		const min = compositor.min_value, max = compositor.max_value;
		const channels = forceRgba ? 4 : rustOutputChannels(layers);
		const data = compositor.take_data_as_channels(channels);
		return {
			data, width, height, channels,
			isFloat: layers.some(layer => !!layer.isFloat),
			typeMax, stats: { min, max }, coveredCount,
		};
	} finally {
		compositor?.free();
	}
}

function rustComposite(layers: Layer[], width: number, height: number, strict = false): CompositeResult | null {
	const unsupported = rustUnsupportedReason(layers);
	if (unsupported) {
		if (strict) { throw new Error(`Rust/Wasm compositor cannot render this document: ${unsupported}`); }
		return null;
	}
	const visible = layers.filter(layer => layer.visible !== false && (layer.opacity ?? 1) > 0);
	const typeMax = visible.find(layer => !!layer.data)?.typeMax || 1;
	try {
		return rustCompositeStack(layers, width, height, typeMax, undefined, new Set());
	} catch (error) {
		console.warn('[LayerCompositorWorker] Rust composition failed; retaining TypeScript fallback:', error);
		if (strict) { throw error; }
		return null;
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
		const requestedBackend = message.requestedBackend === 'wasm'
			? 'wasm'
			: message.requestedBackend === 'javascript' ? 'javascript' : 'auto';
		const requestedRegion = requestedBackend === 'javascript' && message.region && scale === 1 ? message.region : undefined;
		const rustResult = requestedBackend === 'wasm'
			? rustComposite(layers, width, height, true)
			: requestedBackend === 'auto' && !requestedRegion ? rustComposite(layers, width, height) : null;
		const result: CompositeResult = requestedRegion
			? compositeRegion(layers, width, height, requestedRegion)
			: requestedBackend === 'wasm'
				? rustResult as CompositeResult
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
