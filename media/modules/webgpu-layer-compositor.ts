"use strict";

import type { ImageSettings } from './settings-manager.js';
import {
	compositeRegion, evaluateCurvePoints,
	type AdjustmentChannel, type Layer, type LayerAdjustment,
} from './layer-compositor.js';
import { getColormapLut } from './colormaps.js';

type Pixels =
	| Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array
	| Int8Array | Int16Array | Int32Array | Float32Array | Float64Array;
type TextureEntry = {
	key: object; texture: any; width: number; height: number; channels: number; typeMax: number;
};
type SurfaceEntry = {
	textures: any[];
	usesFloat: boolean;
	compositionSignature?: string;
	finalSurface?: number;
};

export type WebGPURenderTiming = {
	requestedAt: number;
	startedAt: number;
	queueMs: number;
	initializationMs: number;
	prepareMs: number;
	encodeMs: number;
	gpuMs: number;
	validationMs: number;
	renderMs: number;
	uploadCount: number;
	uploadBytes: number;
	uploadCpuMs: number;
	surfaceAllocationBytes: number;
	surfaceCacheHit: boolean;
	compositionCacheHit: boolean;
};

export type WebGPURenderResult = {
	canvas: HTMLCanvasElement | null;
	timing: WebGPURenderTiming;
};

const TEXTURE_USAGE = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
const BUFFER_USAGE = { MAP_READ: 1, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
const MAP_MODE_READ = 1;
const BLEND_MODES = new Map([
	['normal', 0], ['multiply', 1], ['screen', 2], ['overlay', 3],
	['darken', 4], ['lighten', 5], ['difference', 6], ['exclusion', 7],
	['add', 8], ['subtract', 9], ['raw-difference', 10], ['raw-multiply', 11],
	['divide', 12], ['min', 13], ['max', 14], ['average', 15], ['mask', 16],
]);
const ADJUSTMENTS = new Set([
	'levels', 'curves', 'hue/saturation', 'brightness/contrast', 'exposure',
	'invert', 'channel mixer', 'color balance', 'black & white', 'threshold',
	'posterize', 'gradient map',
]);

/**
 * Strict WebGPU compositor. It intentionally owns its complete raster/filter
 * path: selecting WebGPU never invokes the WebGL, Wasm, or JavaScript renderer.
 *
 * It implements the editor's complete retained layer model: raster and
 * adjustment layers, clipping stacks, masks, nested groups, scientific blend
 * modes, normalization, and display transforms.
 */
export class WebGPULayerCompositor {
	private canvas: HTMLCanvasElement | null = null;
	private context: any = null;
	private adapter: any = null;
	private device: any = null;
	private canvasFormat = 'bgra8unorm';
	private initPromise: Promise<void> | null = null;
	private blendPipeline: any = null;
	private blendFloatPipeline: any = null;
	private blendBytePipeline: any = null;
	private adjustmentPipeline: any = null;
	private adjustmentFloatPipeline: any = null;
	private adjustmentBytePipeline: any = null;
	private displayPipeline: any = null;
	private reductionPipeline: any = null;
	private textureCache = new WeakMap<object, TextureEntry>();
	private textureEntries = new Set<TextureEntry>();
	private ownedTextures = new Set<any>();
	private surfaces: any[] = [];
	private surfaceKey = '';
	private surfaceCache = new Map<string, SurfaceEntry>();
	private currentSurfaceEntry: SurfaceEntry | null = null;
	private outputUsesFloat = true;
	private dummyTexture: any = null;
	private colormapTexture: any = null;
	private colormapName = 'none';
	private renderQueue: Promise<void> = Promise.resolve();
	private activeTiming: WebGPURenderTiming | null = null;
	private objectIds = new WeakMap<object, number>();
	private nextObjectId = 1;
	private logger: (message: string) => void = message => console.warn(message);

	setLogger(logger: (message: string) => void): void { this.logger = logger; }

	retry(): void {
		if (!this.device) { this.initPromise = null; }
	}

	async isAvailable(): Promise<boolean> {
		try {
			await this.ensureDevice();
			return true;
		} catch {
			return false;
		}
	}

	pendingUpload(layers: Layer[]): { count: number; bytes: number } {
		const pending = new Set<object>();
		let bytes = 0;
		const inspect = (
			data: ArrayLike<number> | undefined, width: number, height: number,
			channels: number, typeMax: number,
		): void => {
			if (!data || !this.isPixels(data) || pending.has(data as object)) { return; }
			const cached = this.textureCache.get(data as object);
			if (cached && cached.width === width && cached.height === height
				&& cached.channels === channels && cached.typeMax === typeMax) { return; }
			pending.add(data as object);
			const isByte = data instanceof Uint8Array || data instanceof Uint8ClampedArray;
			bytes += width * height * (isByte ? 4 : 16);
		};
		for (const layer of layers) {
			inspect(layer.data, layer.width, layer.height, layer.channels, layer.typeMax || 1);
			if (layer.rasterMask) {
				inspect(
					layer.rasterMask.data, layer.rasterMask.width, layer.rasterMask.height,
					Math.max(1, layer.rasterMask.channels || 1), layer.rasterMask.typeMax || 1,
				);
			}
		}
		return { count: pending.size, bytes };
	}

	unsupportedReason(layers: Layer[], settings: ImageSettings, width: number, height: number): string | null {
		if (settings.gpuAcceleration === false) { return 'GPU acceleration is disabled in the image settings'; }
		if (width <= 0 || height <= 0) { return `the document size ${width}×${height} is invalid`; }
		if (!(navigator as any).gpu) { return 'WebGPU is unavailable in this webview'; }
		for (const layer of layers) {
			const label = layer.name || layer.id || 'unnamed layer';
			if (layer.rasterMask && !this.isPixels(layer.rasterMask.data)) {
				return `"${label}" uses unsupported mask storage`;
			}
			if (layer.kind === 'group') {
				if (!layer.id) { return `"${label}" is a group without an id`; }
				if (!BLEND_MODES.has(layer.blendMode || 'normal')) { return `"${label}" uses an unsupported blend mode`; }
				continue;
			}
			if (layer.kind === 'adjustment') {
				if (!layer.adjustment || !ADJUSTMENTS.has(layer.adjustment.type)) {
					return `"${label}" uses an unsupported adjustment`;
				}
				continue;
			}
			if (layer.kind && layer.kind !== 'raster') { return `"${label}" is an unsupported ${layer.kind} node`; }
			if (layer.channels < 1 || layer.channels > 4) { return `"${label}" has ${layer.channels} channels`; }
			if (layer.data && !this.isPixels(layer.data)) { return `"${label}" uses unsupported pixel storage`; }
			if (!BLEND_MODES.has(layer.blendMode || 'normal')) { return `"${label}" uses unsupported blend mode "${layer.blendMode}"`; }
		}
		return null;
	}

	render(
		layers: Layer[], documentWidth: number, documentHeight: number, scale: number,
		settings: ImageSettings, nanColor: { r: number; g: number; b: number }, strict = false,
	): Promise<HTMLCanvasElement | null> {
		return this.renderWithMetrics(
			layers, documentWidth, documentHeight, scale, settings, nanColor, strict,
		).then(result => result.canvas);
	}

	renderWithMetrics(
		layers: Layer[], documentWidth: number, documentHeight: number, scale: number,
		settings: ImageSettings, nanColor: { r: number; g: number; b: number }, strict = false,
	): Promise<WebGPURenderResult> {
		// WebGPU work is serialized and asynchronous. UI edits may mutate the
		// manager's layer objects while an earlier request is queued or executing,
		// so retain immutable parameters for both GPU encoding and CPU parity
		// validation. Pixel arrays themselves are immutable document assets and
		// intentionally remain shared to avoid multi-hundred-megabyte copies.
		const requestedLayers = this.snapshotLayers(layers);
		const requestedSettings = this.snapshotSettings(settings);
		const requestedNanColor = { ...nanColor };
		const timing: WebGPURenderTiming = {
			requestedAt: performance.now(), startedAt: 0, queueMs: 0,
			initializationMs: 0, prepareMs: 0, encodeMs: 0, gpuMs: 0,
			validationMs: 0, renderMs: 0, uploadCount: 0, uploadBytes: 0,
			uploadCpuMs: 0, surfaceAllocationBytes: 0, surfaceCacheHit: false,
			compositionCacheHit: false,
		};
		const operation = this.renderQueue.then(async () => {
			timing.startedAt = performance.now();
			timing.queueMs = timing.startedAt - timing.requestedAt;
			this.activeTiming = timing;
			try {
				const canvas = await this.renderNow(
					requestedLayers, documentWidth, documentHeight, scale,
					requestedSettings, requestedNanColor, strict,
				);
				timing.renderMs = performance.now() - timing.startedAt;
				return { canvas, timing };
			} finally {
				this.activeTiming = null;
			}
		});
		this.renderQueue = operation.then((): void => { /* serialize */ }, (): void => { /* continue after failure */ });
		return operation;
	}

	private snapshotLayers(layers: Layer[]): Layer[] {
		return layers.map(layer => ({
			...layer,
			adjustment: layer.adjustment
				? JSON.parse(JSON.stringify(layer.adjustment)) as LayerAdjustment
				: undefined,
			maskCondition: layer.maskCondition ? { ...layer.maskCondition } : undefined,
			rasterMask: layer.rasterMask ? { ...layer.rasterMask } : undefined,
			groupPath: layer.groupPath ? [...layer.groupPath] : undefined,
			groupIds: layer.groupIds ? [...layer.groupIds] : undefined,
		}));
	}

	private snapshotSettings(settings: ImageSettings): ImageSettings {
		return {
			...settings,
			normalization: settings.normalization ? { ...settings.normalization } : undefined,
			gamma: settings.gamma ? { ...settings.gamma } : undefined,
			brightness: settings.brightness ? { ...settings.brightness } : undefined,
		};
	}

	private async renderNow(
		layers: Layer[], documentWidth: number, documentHeight: number, scale: number,
		settings: ImageSettings, nanColor: { r: number; g: number; b: number }, strict: boolean,
	): Promise<HTMLCanvasElement | null> {
		const unsupported = this.unsupportedReason(layers, settings, documentWidth, documentHeight);
		if (unsupported) {
			const error = new Error(`WebGPU compositor cannot render this document: ${unsupported}`);
			if (strict) { throw error; }
			return null;
		}
		try {
			const initializationStarted = performance.now();
			await this.ensureDevice();
			if (this.activeTiming) {
				this.activeTiming.initializationMs = performance.now() - initializationStarted;
			}
			const prepareStarted = performance.now();
			const width = Math.max(1, Math.round(documentWidth * scale));
			const height = Math.max(1, Math.round(documentHeight * scale));
			const maximum = Number(this.device.limits.maxTextureDimension2D || 0);
			if (width > maximum || height > maximum) {
				throw new Error(`document surface ${width}×${height} exceeds maxTextureDimension2D ${maximum}`);
			}
			for (const layer of layers) if (layer.data && (layer.width > maximum || layer.height > maximum)) {
				throw new Error(`layer "${layer.name || layer.id}" exceeds maxTextureDimension2D ${maximum}`);
			}
			const renderLayers = this.foldGroupOffsets(layers);
			this.pruneTextureCache(new Set(renderLayers.flatMap(layer => [
				...(layer.data && this.isPixels(layer.data) ? [layer.data as object] : []),
				...(layer.rasterMask?.data && this.isPixels(layer.rasterMask.data)
					? [layer.rasterMask.data as object] : []),
			])));
			const groups = new Map(renderLayers.filter(layer => layer.kind === 'group' && layer.id).map(layer => [layer.id as string, layer]));
			let maximumDepth = 0;
			for (const layer of renderLayers) {
				let depth = 0, parentId = layer.parentId;
				const visited = new Set<string>();
				while (parentId && !visited.has(parentId)) {
					visited.add(parentId);
					const parent = groups.get(parentId);
					if (!parent) { break; }
					depth++; parentId = parent.parentId;
				}
				maximumDepth = Math.max(maximumDepth, depth);
			}
			const usesFloat =
				renderLayers.some(layer => ['add', 'subtract', 'raw-difference', 'raw-multiply', 'divide', 'min', 'max', 'average'].includes(layer.blendMode || '')) ||
				renderLayers.some(layer => layer.data && (
					!(layer.data instanceof Uint8Array || layer.data instanceof Uint8ClampedArray) ||
					(layer.typeMax || 255) !== 255
				));
			const needsIsolatedScratch = renderLayers.some(layer =>
				layer.kind === 'group' || layer.clipped === true);
			this.ensureSurfaces(
				width, height, (maximumDepth + 1) * 2 + (needsIsolatedScratch ? 3 : 0), usesFloat,
			);
			this.blendPipeline = usesFloat ? this.blendFloatPipeline : this.blendBytePipeline;
			this.adjustmentPipeline = usesFloat ? this.adjustmentFloatPipeline : this.adjustmentBytePipeline;
			const compositionMaximum = renderLayers.find(layer =>
				layer.visible !== false && (layer.opacity ?? 1) > 0 && layer.data)?.typeMax || 1;
			const compositionSignature = this.compositionSignature(renderLayers);
			if (this.activeTiming) {
				this.activeTiming.prepareMs = performance.now() - prepareStarted;
			}
			let encodeStarted = performance.now();
			let encoder = this.device.createCommandEncoder({ label: 'Layer compositor' });
			const temporaryBuffers: any[] = [];
			let finalSurface: number;
			if (this.currentSurfaceEntry?.compositionSignature === compositionSignature
				&& this.currentSurfaceEntry.finalSurface !== undefined) {
				finalSurface = this.currentSurfaceEntry.finalSurface;
				if (this.activeTiming) { this.activeTiming.compositionCacheHit = true; }
			} else {
				for (let depth = 0; depth <= maximumDepth; depth++) {
					this.clearTexture(encoder, this.surfaces[depth * 2]);
				}
				finalSurface = this.drawStack(
					encoder, temporaryBuffers, renderLayers, width, height, scale, compositionMaximum,
					undefined, 0, new Set<string>(),
				);
				if (this.currentSurfaceEntry) {
					this.currentSurfaceEntry.compositionSignature = compositionSignature;
					this.currentSurfaceEntry.finalSurface = finalSurface;
				}
			}
			let automaticRange: [number, number] | undefined;
			if (settings.normalization?.autoNormalize) {
				const reduction = this.encodeAutoRange(encoder, finalSurface, width, height, temporaryBuffers);
				if (this.activeTiming) {
					this.activeTiming.encodeMs += performance.now() - encodeStarted;
				}
				const gpuStarted = performance.now();
				this.device.queue.submit([encoder.finish()]);
				automaticRange = await this.readAutoRange(reduction);
				if (this.activeTiming) {
					this.activeTiming.gpuMs += performance.now() - gpuStarted;
				}
				encoder = this.device.createCommandEncoder({ label: 'Layer display' });
				encodeStarted = performance.now();
			}
			const displayTarget = this.drawDisplay(
				encoder, temporaryBuffers, finalSurface, width, height,
				settings, nanColor, compositionMaximum, layers, automaticRange,
			);
			const displayValidation = strict && scale === 1
				? this.encodeDisplaySamples(encoder, displayTarget, width, height)
				: null;
			const validation = strict && scale === 1
				? this.encodeValidation(encoder, finalSurface, documentWidth, documentHeight)
				: null;
			if (this.activeTiming) {
				this.activeTiming.encodeMs += performance.now() - encodeStarted;
			}
			const gpuStarted = performance.now();
			this.device.queue.submit([encoder.finish()]);
			await this.device.queue.onSubmittedWorkDone();
			if (this.activeTiming) {
				this.activeTiming.gpuMs += performance.now() - gpuStarted;
			}
			const validationStarted = performance.now();
			if (validation) { await this.validateSamples(validation, layers, documentWidth, documentHeight); }
			if (displayValidation) {
				await this.validateDisplaySamples(
					displayValidation, layers, documentWidth, documentHeight,
					settings, nanColor, compositionMaximum, automaticRange,
				);
			}
			if (this.activeTiming) {
				this.activeTiming.validationMs = performance.now() - validationStarted;
			}
			for (const buffer of temporaryBuffers) { buffer.destroy(); }
			return this.canvas;
		} catch (error) {
			this.logger(`[LayerCompositor] WebGPU failed: ${error instanceof Error ? error.message : String(error)}`);
			if (strict) { throw error; }
			return null;
		}
	}

	dispose(): void {
		for (const texture of this.ownedTextures) { try { texture.destroy(); } catch { /* already lost */ } }
		this.ownedTextures.clear();
		this.textureCache = new WeakMap();
		this.textureEntries.clear();
		this.surfaces = [];
		this.surfaceKey = '';
		this.surfaceCache.clear();
		this.currentSurfaceEntry = null;
		this.dummyTexture = null;
		this.colormapTexture = null;
		this.colormapName = 'none';
		try { this.device?.destroy(); } catch { /* optional */ }
		this.device = null;
		this.adapter = null;
		this.context = null;
		this.canvas = null;
		this.initPromise = null;
		this.blendPipeline = null;
		this.blendFloatPipeline = null;
		this.blendBytePipeline = null;
		this.adjustmentPipeline = null;
		this.adjustmentFloatPipeline = null;
		this.adjustmentBytePipeline = null;
		this.displayPipeline = null;
		this.reductionPipeline = null;
		this.objectIds = new WeakMap();
		this.nextObjectId = 1;
	}

	private async ensureDevice(): Promise<void> {
		if (this.device) { return; }
		if (this.initPromise) { return this.initPromise; }
		this.initPromise = (async () => {
			const gpu = (navigator as any).gpu;
			if (!gpu) { throw new Error('navigator.gpu is unavailable'); }
			const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
			if (!adapter) { throw new Error('No WebGPU adapter is available'); }
			// Source textures are fetched with textureLoad, so rgba32float input
			// does not require the optional float32-filterable feature.
			const device = await adapter.requestDevice();
			const canvas = document.createElement('canvas');
			const context = canvas.getContext('webgpu') as any;
			if (!context) { throw new Error('Could not create a WebGPU canvas context'); }
			const format = gpu.getPreferredCanvasFormat();
			context.configure({
				device, format, alphaMode: 'premultiplied',
				usage: TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.COPY_SRC,
			});
			device.lost.then((info: any) => {
				this.logger(`[LayerCompositor] WebGPU device lost: ${info?.message || info?.reason || 'unknown reason'}`);
				this.dispose();
			});
			device.addEventListener?.('uncapturederror', (event: any) =>
				this.logger(`[LayerCompositor] WebGPU validation error: ${event.error?.message || event.error}`));
			this.adapter = adapter;
			this.device = device;
			this.canvas = canvas;
			this.context = context;
			this.canvasFormat = format;
			const [blendPipelines, adjustmentPipelines, displayPipeline, reductionPipeline] = await Promise.all([
				this.createPipelines(BLEND_SHADER, 'blend', ['rgba16float', 'rgba8unorm']),
				this.createPipelines(ADJUSTMENT_SHADER, 'adjustment', ['rgba16float', 'rgba8unorm']),
				this.createPipeline(DISPLAY_SHADER, 'display', format),
				this.createReductionPipeline(),
			]);
			[this.blendFloatPipeline, this.blendBytePipeline] = blendPipelines;
			[this.adjustmentFloatPipeline, this.adjustmentBytePipeline] = adjustmentPipelines;
			this.blendPipeline = this.blendFloatPipeline;
			this.adjustmentPipeline = this.adjustmentFloatPipeline;
			this.displayPipeline = displayPipeline;
			this.reductionPipeline = reductionPipeline;
			this.dummyTexture = this.createTexture(1, 1, 'rgba8unorm', TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST);
			device.queue.writeTexture(
				{ texture: this.dummyTexture }, new Uint8Array([0, 0, 0, 0]),
				{ bytesPerRow: 4, rowsPerImage: 1 }, { width: 1, height: 1 },
			);
		})();
		try { await this.initPromise; }
		catch (error) { this.initPromise = null; throw error; }
	}

	private async createPipeline(code: string, entryPoint: string, format: string): Promise<any> {
		return (await this.createPipelines(code, entryPoint, [format]))[0];
	}

	private async createPipelines(code: string, entryPoint: string, formats: string[]): Promise<any[]> {
		const module = this.device.createShaderModule({ code, label: `Layer ${entryPoint} shader` });
		const compilation = await module.getCompilationInfo();
		const errors = compilation.messages.filter((message: any) => message.type === 'error');
		if (errors.length) {
			throw new Error(`${entryPoint} WGSL failed: ${errors.map((message: any) => `${message.lineNum}:${message.linePos} ${message.message}`).join('; ')}`);
		}
		return Promise.all(formats.map(format => this.device.createRenderPipelineAsync({
				label: `Layer ${entryPoint} ${format} pipeline`,
				layout: 'auto',
				vertex: { module, entryPoint: 'vertexMain' },
				fragment: { module, entryPoint, targets: [{ format }] },
				primitive: { topology: 'triangle-list' },
			})));
	}

	private async createReductionPipeline(): Promise<any> {
		const module = this.device.createShaderModule({ code: REDUCTION_SHADER, label: 'Layer reduction shader' });
		const compilation = await module.getCompilationInfo();
		const errors = compilation.messages.filter((message: any) => message.type === 'error');
		if (errors.length) {
			throw new Error(`reduction WGSL failed: ${errors.map((message: any) => message.message).join('; ')}`);
		}
		return this.device.createComputePipelineAsync({
			label: 'Layer auto-normalization pipeline', layout: 'auto',
			compute: { module, entryPoint: 'reduce' },
		});
	}

	private createTexture(width: number, height: number, format: string, usage: number): any {
		const texture = this.device.createTexture({ size: { width, height }, format, usage });
		this.ownedTextures.add(texture);
		return texture;
	}

	private ensureSurfaces(width: number, height: number, count: number, usesFloat: boolean): void {
		const key = `${width}x${height}:${count}:${usesFloat ? 'float' : 'byte'}`;
		if (this.surfaceKey === key && this.surfaces.length === count) {
			if (this.activeTiming) { this.activeTiming.surfaceCacheHit = true; }
			return;
		}
		const cached = this.surfaceCache.get(key);
		if (cached) {
			this.surfaceCache.delete(key);
			this.surfaceCache.set(key, cached);
			this.surfaces = cached.textures;
			this.currentSurfaceEntry = cached;
			this.outputUsesFloat = cached.usesFloat;
			this.surfaceKey = key;
			if (this.activeTiming) { this.activeTiming.surfaceCacheHit = true; }
			if (this.canvas) { this.canvas.width = width; this.canvas.height = height; }
			return;
		}
		this.surfaces = Array.from({ length: count }, () => this.createTexture(
				width, height, usesFloat ? 'rgba16float' : 'rgba8unorm',
				TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.COPY_SRC | TEXTURE_USAGE.COPY_DST,
			));
		const entry = { textures: this.surfaces, usesFloat };
		this.surfaceCache.set(key, entry);
		this.currentSurfaceEntry = entry;
		if (this.activeTiming) {
			this.activeTiming.surfaceAllocationBytes =
				width * height * 4 * (usesFloat ? 2 : 1) * count;
		}
		while (this.surfaceCache.size > 2) {
			const oldestKey = this.surfaceCache.keys().next().value as string | undefined;
			if (!oldestKey || oldestKey === key) { break; }
			const oldest = this.surfaceCache.get(oldestKey);
			if (oldest) {
				for (const texture of oldest.textures) {
					texture.destroy();
					this.ownedTextures.delete(texture);
				}
			}
			this.surfaceCache.delete(oldestKey);
		}
		this.surfaceKey = key;
		this.outputUsesFloat = usesFloat;
		if (this.canvas) { this.canvas.width = width; this.canvas.height = height; }
	}

	private clearTexture(encoder: any, texture: any): void {
		const pass = encoder.beginRenderPass({
			colorAttachments: [{
				view: texture.createView(), loadOp: 'clear', storeOp: 'store',
				clearValue: { r: 0, g: 0, b: 0, a: 0 },
			}],
		});
		pass.end();
	}

	private drawStack(
		encoder: any, buffers: any[], layers: Layer[], width: number, height: number,
		scale: number, typeMax: number, parentId: string | undefined, depth: number, ancestors: Set<string>,
	): number {
		const first = depth * 2, second = first + 1;
		let previous = first;
		const siblings = layers.filter(layer => (layer.parentId || undefined) === parentId);
		for (let index = 0; index < siblings.length;) {
			const base = siblings[index];
			let end = index + 1;
			while (end < siblings.length && siblings[end].clipped) { end++; }
			const effects = siblings.slice(index + 1, end);
			if (base.visible === false || (base.opacity ?? 1) <= 0) { index = end; continue; }
			if (base.kind === 'adjustment' && base.adjustment) {
				const destination = previous === first ? second : first;
				this.drawAdjustment(encoder, buffers, base, previous, destination, width, height, scale);
				previous = destination; index = end; continue;
			}
			if (base.kind === 'group') {
				const id = base.id || '';
				if (!id || ancestors.has(id)) { index = end; continue; }
				const nextAncestors = new Set(ancestors); nextAncestors.add(id);
				const child = this.drawStack(
					encoder, buffers, layers, width, height, scale, typeMax, id, depth + 1, nextAncestors,
				);
				previous = this.drawIsolatedSurfaceStack(
					encoder, buffers, base, effects, child, previous, first, second, width, height, scale, typeMax,
				);
				index = end; continue;
			}
			if (!base.data) { index = end; continue; }
			if (effects.length) {
				const scratchFirst = this.surfaces.length - 3, scratchSecond = scratchFirst + 1, scratchBase = scratchFirst + 2;
				this.clearTexture(encoder, this.surfaces[scratchSecond]);
				this.drawLayer(encoder, buffers, base, scratchSecond, scratchFirst, width, height, scale, typeMax, {
					opacity: 1, blendMode: 'normal',
				});
				encoder.copyTextureToTexture(
					{ texture: this.surfaces[scratchFirst] }, { texture: this.surfaces[scratchBase] }, { width, height },
				);
				let isolated = scratchFirst;
				for (const effect of effects) {
					if (effect.visible === false || (effect.opacity ?? 1) <= 0) { continue; }
					const destination = isolated === scratchFirst ? scratchSecond : scratchFirst;
					if (effect.kind === 'adjustment' && effect.adjustment) {
						this.drawAdjustment(encoder, buffers, effect, isolated, destination, width, height, scale);
					} else if (effect.data) {
						this.drawLayer(encoder, buffers, effect, isolated, destination, width, height, scale, typeMax, {
							clipTexture: this.surfaces[scratchBase],
						});
					} else { continue; }
					isolated = destination;
				}
				const destination = previous === first ? second : first;
				this.drawSurface(
					encoder, buffers, this.surfaces[isolated], previous, destination,
					width, height, base.opacity ?? 1, base.blendMode || 'normal', typeMax,
				);
				previous = destination;
			} else {
				const destination = previous === first ? second : first;
				this.drawLayer(encoder, buffers, base, previous, destination, width, height, scale, typeMax);
				previous = destination;
			}
			index = end;
		}
		return previous;
	}

	private drawIsolatedSurfaceStack(
		encoder: any, buffers: any[], base: Layer, effects: Layer[], child: number,
		previous: number, first: number, second: number, width: number, height: number, scale: number, typeMax: number,
	): number {
		const scratchFirst = this.surfaces.length - 3, scratchSecond = scratchFirst + 1, scratchBase = scratchFirst + 2;
		this.clearTexture(encoder, this.surfaces[scratchSecond]);
		this.drawSurface(encoder, buffers, this.surfaces[child], scratchSecond, scratchFirst, width, height, 1, 'normal', typeMax);
		encoder.copyTextureToTexture(
			{ texture: this.surfaces[scratchFirst] }, { texture: this.surfaces[scratchBase] }, { width, height },
		);
		let isolated = scratchFirst;
		for (const effect of effects) {
			if (effect.visible === false || (effect.opacity ?? 1) <= 0) { continue; }
			const destination = isolated === scratchFirst ? scratchSecond : scratchFirst;
			if (effect.kind === 'adjustment' && effect.adjustment) {
				this.drawAdjustment(encoder, buffers, effect, isolated, destination, width, height, scale);
			} else if (effect.data) {
				this.drawLayer(encoder, buffers, effect, isolated, destination, width, height, scale, typeMax, {
					clipTexture: this.surfaces[scratchBase],
				});
			} else { continue; }
			isolated = destination;
		}
		const destination = previous === first ? second : first;
		this.drawSurface(
			encoder, buffers, this.surfaces[isolated], previous, destination, width, height,
			base.opacity ?? 1, base.blendMode || 'normal', typeMax, base, scale,
		);
		return destination;
	}

	private drawLayer(
		encoder: any, buffers: any[], layer: Layer, previous: number, destination: number,
		width: number, height: number, scale: number, typeMax: number,
		options: { opacity?: number; blendMode?: string; clipTexture?: any } = {},
	): void {
		const source = this.textureFor(layer.data as Pixels, layer.width, layer.height, layer.channels, layer.typeMax || 1);
		const mask = layer.rasterMask
			? this.textureFor(
				layer.rasterMask.data as Pixels, layer.rasterMask.width, layer.rasterMask.height,
				Math.max(1, layer.rasterMask.channels || 1), layer.rasterMask.typeMax || 1,
			) : null;
		const params = new Float32Array(32);
		params.set([
			width, height, source.width, source.height,
			Math.round((layer.offsetX || 0) * scale), Math.round((layer.offsetY || 0) * scale),
			Math.max(1, Math.round(layer.width * scale)), Math.max(1, Math.round(layer.height * scale)),
			mask ? 1 : 0,
			layer.rasterMask?.width || 1, layer.rasterMask?.height || 1,
			Math.round((layer.rasterMask?.offsetX ?? layer.offsetX ?? 0) * scale),
			Math.round((layer.rasterMask?.offsetY ?? layer.offsetY ?? 0) * scale),
			Math.max(1, Math.round((layer.rasterMask?.width || 1) * scale)),
			Math.max(1, Math.round((layer.rasterMask?.height || 1) * scale)),
			layer.rasterMask?.invert ? 1 : 0,
			options.clipTexture ? 1 : 0,
			BLEND_MODES.get(options.blendMode || layer.blendMode || 'normal') || 0,
			Math.max(0, Math.min(1, options.opacity ?? layer.opacity ?? 1)),
			['gt', 'ge', 'lt', 'le', 'eq', 'isfinite', 'isnan'].indexOf(layer.maskCondition?.op || '') + 1,
			(layer.maskCondition?.threshold || 0) / (layer.typeMax || typeMax),
			typeMax,
		]);
		this.runBlend(
			encoder, buffers, this.surfaces[previous], source.texture,
			mask?.texture || this.dummyTexture, options.clipTexture || this.dummyTexture,
			this.surfaces[destination], params,
		);
	}

	private drawSurface(
		encoder: any, buffers: any[], source: any, previous: number, destination: number,
		width: number, height: number, opacity: number, blendMode: string, typeMax: number,
		maskOwner?: Layer, scale = 1,
	): void {
		const mask = maskOwner?.rasterMask
			? this.textureFor(
				maskOwner.rasterMask.data as Pixels, maskOwner.rasterMask.width, maskOwner.rasterMask.height,
				Math.max(1, maskOwner.rasterMask.channels || 1), maskOwner.rasterMask.typeMax || 1,
			) : null;
		const params = new Float32Array(32);
		params.set([
			width, height, width, height, 0, 0, width, height,
			mask ? 1 : 0, maskOwner?.rasterMask?.width || 1, maskOwner?.rasterMask?.height || 1,
			Math.round((maskOwner?.rasterMask?.offsetX ?? 0) * scale), Math.round((maskOwner?.rasterMask?.offsetY ?? 0) * scale),
			Math.max(1, Math.round((maskOwner?.rasterMask?.width || 1) * scale)),
			Math.max(1, Math.round((maskOwner?.rasterMask?.height || 1) * scale)),
			maskOwner?.rasterMask?.invert ? 1 : 0, 0,
			BLEND_MODES.get(blendMode) || 0, Math.max(0, Math.min(1, opacity)), 0, 0, typeMax,
		]);
		this.runBlend(
			encoder, buffers, this.surfaces[previous], source,
			mask?.texture || this.dummyTexture, this.dummyTexture, this.surfaces[destination], params,
		);
	}

	private foldGroupOffsets(layers: Layer[]): Layer[] {
		const groups = new Map(layers.filter(layer => layer.kind === 'group' && layer.id).map(layer => [layer.id as string, layer]));
		const inherited = (layer: Layer): { x: number; y: number } => {
			let parentId = layer.parentId, x = 0, y = 0;
			const visited = new Set<string>();
			while (parentId && !visited.has(parentId)) {
				visited.add(parentId);
				const parent = groups.get(parentId);
				if (!parent) { break; }
				x += parent.offsetX || 0; y += parent.offsetY || 0; parentId = parent.parentId;
			}
			return { x, y };
		};
		return layers.map(layer => {
			const translation = inherited(layer);
			if (layer.kind === 'group') {
				return {
					...layer, offsetX: 0, offsetY: 0,
					rasterMask: layer.rasterMask ? {
						...layer.rasterMask,
						offsetX: (layer.rasterMask.offsetX ?? layer.offsetX ?? 0) + translation.x,
						offsetY: (layer.rasterMask.offsetY ?? layer.offsetY ?? 0) + translation.y,
					} : undefined,
				};
			}
			if (!translation.x && !translation.y) { return layer; }
			return {
				...layer, offsetX: (layer.offsetX || 0) + translation.x, offsetY: (layer.offsetY || 0) + translation.y,
				rasterMask: layer.rasterMask ? {
					...layer.rasterMask,
					offsetX: (layer.rasterMask.offsetX ?? layer.offsetX ?? 0) + translation.x,
					offsetY: (layer.rasterMask.offsetY ?? layer.offsetY ?? 0) + translation.y,
				} : undefined,
			};
		});
	}

	private runBlend(
		encoder: any, buffers: any[], previous: any, source: any, mask: any, clip: any,
		destination: any, params: Float32Array,
	): void {
		const parameterBuffer = this.parameterBuffer(params, buffers);
		const bindGroup = this.device.createBindGroup({
			layout: this.blendPipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: previous.createView() },
				{ binding: 1, resource: source.createView() },
				{ binding: 2, resource: mask.createView() },
				{ binding: 3, resource: clip.createView() },
				{ binding: 4, resource: { buffer: parameterBuffer } },
			],
		});
		this.renderPass(encoder, this.blendPipeline, bindGroup, destination);
	}

	private drawAdjustment(
		encoder: any, buffers: any[], layer: Layer, source: number, destination: number,
		width: number, height: number, scale: number,
	): void {
		const adjustment = layer.adjustment as LayerAdjustment;
		const mask = layer.rasterMask
			? this.textureFor(
				layer.rasterMask.data as Pixels, layer.rasterMask.width, layer.rasterMask.height,
				Math.max(1, layer.rasterMask.channels || 1), layer.rasterMask.typeMax || 1,
			) : null;
		const params = this.adjustmentParameters(adjustment);
		params[1] = Math.max(0, Math.min(1, layer.opacity ?? 1));
		params.set([
			mask ? 1 : 0,
			layer.rasterMask?.width || 1, layer.rasterMask?.height || 1,
			Math.round((layer.rasterMask?.offsetX ?? layer.offsetX ?? 0) * scale),
			Math.round((layer.rasterMask?.offsetY ?? layer.offsetY ?? 0) * scale),
			Math.max(1, Math.round((layer.rasterMask?.width || 1) * scale)),
			Math.max(1, Math.round((layer.rasterMask?.height || 1) * scale)),
			layer.rasterMask?.invert ? 1 : 0, width, height,
		], 2);
		const parameterBuffer = this.parameterBuffer(params, buffers);
		const bindGroup = this.device.createBindGroup({
			layout: this.adjustmentPipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: this.surfaces[source].createView() },
				{ binding: 1, resource: (mask?.texture || this.dummyTexture).createView() },
				{ binding: 2, resource: { buffer: parameterBuffer } },
			],
		});
		this.renderPass(encoder, this.adjustmentPipeline, bindGroup, this.surfaces[destination]);
	}

	private adjustmentParameters(adjustment: LayerAdjustment): Float32Array {
		const output = new Float32Array(896);
		const type = ['levels', 'curves'].includes(adjustment.type) ? 0
			: adjustment.type === 'hue/saturation' ? 1
				: ['brightness/contrast', 'exposure', 'invert', 'channel mixer', 'color balance',
					'black & white', 'threshold', 'posterize', 'gradient map'].indexOf(adjustment.type) + 2;
		output[0] = type;
		const values = output.subarray(32, 77);
		const flags = output.subarray(80, 88);
		if (adjustment.type === 'levels' || adjustment.type === 'curves') {
			this.fillAdjustmentLut(output.subarray(96, 864), adjustment);
		} else if (adjustment.type === 'hue/saturation') {
			const colorize = !!adjustment.colorize && adjustment.colorizeEnabled !== false;
			flags[0] = colorize ? 1 : 0;
			if (colorize) {
				values.set([
					adjustment.colorize!.hue || 0,
					(adjustment.colorize!.saturation || 0) / 100,
					(adjustment.colorize!.lightness || 0) / 100,
				]);
			} else {
				const master = adjustment.master || {};
				values.set([master.hue || 0, master.saturation || 0, master.lightness || 0]);
				for (let range = 0; range < 6; range++) {
					const settings = adjustment[(['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const)[range]];
					const base = 3 + range * 7;
					flags[range + 1] = settings && ['a', 'b', 'c', 'd'].every(key => Number.isFinite(settings[key])) ? 1 : 0;
					values.set([
						settings?.a || 0, settings?.b || 0, settings?.c || 0, settings?.d || 0,
						settings?.hue || 0, settings?.saturation || 0, settings?.lightness || 0,
					], base);
				}
			}
		} else { this.fillDirectParameters(output, adjustment, flags); }
		return output;
	}

	private fillDirectParameters(output: Float32Array, adjustment: LayerAdjustment, flags: Float32Array): void {
		const values = output.subarray(32, 77);
		const mixer = (channel: any, fallback: Record<string, number>) => {
			const value = channel || fallback;
			return [value.red ?? 0, value.green ?? 0, value.blue ?? 0, value.constant ?? 0];
		};
		if (adjustment.type === 'brightness/contrast') { values.set([adjustment.brightness || 0, adjustment.contrast || 0]); }
		else if (adjustment.type === 'exposure') { values.set([adjustment.exposure || 0, adjustment.offset || 0, adjustment.gamma ?? 1]); }
		else if (adjustment.type === 'channel mixer') {
			flags[0] = adjustment.monochrome ? 1 : 0;
			values.set([
				...mixer(adjustment.red, { red: 100 }), ...mixer(adjustment.green, { green: 100 }),
				...mixer(adjustment.blue, { blue: 100 }), ...mixer(adjustment.gray, { red: 40, green: 40, blue: 20 }),
			]);
		} else if (adjustment.type === 'color balance') {
			flags[0] = adjustment.preserveLuminosity ? 1 : 0;
			const balance = (range: any) => [range?.cyanRed || 0, range?.magentaGreen || 0, range?.yellowBlue || 0];
			values.set([...balance(adjustment.shadows), ...balance(adjustment.midtones), ...balance(adjustment.highlights)]);
		} else if (adjustment.type === 'black & white') {
			values.set([adjustment.reds ?? 40, adjustment.yellows ?? 60, adjustment.greens ?? 40,
				adjustment.cyans ?? 60, adjustment.blues ?? 20, adjustment.magentas ?? 80]);
		} else if (adjustment.type === 'threshold') { values[0] = adjustment.level ?? 128; }
		else if (adjustment.type === 'posterize') { values[0] = adjustment.levels ?? 4; }
		else if (adjustment.type === 'gradient map') { this.fillGradientLut(output.subarray(96, 864), adjustment); }
	}

	private fillAdjustmentLut(target: Float32Array, adjustment: Extract<LayerAdjustment, { type: 'levels' | 'curves' }>): void {
		for (let channel = 0; channel < 3; channel++) {
			const name = ['red', 'green', 'blue'][channel] as 'red' | 'green' | 'blue';
			for (let input = 0; input < 256; input++) {
				target[channel * 256 + input] = this.adjustmentCurve(
					this.adjustmentCurve(input, adjustment.rgb), adjustment[name],
				) / 255;
			}
		}
	}

	private adjustmentCurve(value: number, channel: AdjustmentChannel | undefined): number {
		if (!channel) { return value; }
		if (Array.isArray(channel)) { return evaluateCurvePoints(channel, value); }
		const low = channel.shadowInput ?? 0, high = channel.highlightInput ?? 255;
		const normalized = Math.max(0, Math.min(1, (value - low) / Math.max(1e-6, high - low)));
		return (channel.shadowOutput ?? 0) + Math.pow(normalized, 1 / Math.max(0.01, channel.midtoneInput ?? 1))
			* ((channel.highlightOutput ?? 255) - (channel.shadowOutput ?? 0));
	}

	private fillGradientLut(target: Float32Array, adjustment: Extract<LayerAdjustment, { type: 'gradient map' }>): void {
		const defaults = [{ position: 0, color: { r: 0, g: 0, b: 0 } }, { position: 1, color: { r: 255, g: 255, b: 255 } }];
		const stops = (adjustment.stops?.length ? adjustment.stops : defaults)
			.map(stop => ({ ...stop, position: Math.max(0, Math.min(1, stop.position)) })).sort((a, b) => a.position - b.position);
		for (let input = 0; input < 256; input++) {
			const position = adjustment.reverse ? 1 - input / 255 : input / 255;
			let low = stops[0], high = stops[0], amount = 0;
			if (position >= stops.at(-1)!.position) { low = high = stops.at(-1)!; }
			else for (let index = 1; index < stops.length; index++) if (position <= stops[index].position) {
				low = stops[index - 1]; high = stops[index];
				amount = (position - low.position) / Math.max(1e-6, high.position - low.position); break;
			}
			for (let channel = 0; channel < 3; channel++) {
				const name = ['r', 'g', 'b'][channel] as 'r' | 'g' | 'b';
				target[channel * 256 + input] = (low.color[name] + (high.color[name] - low.color[name]) * amount) / 255;
			}
		}
	}

	private renderPass(
		encoder: any, pipeline: any, bindGroup: any, destination: any,
		loadOp: 'load' | 'clear' = 'load',
	): void {
		const pass = encoder.beginRenderPass({
			colorAttachments: [{
				view: destination.createView(), loadOp, storeOp: 'store',
				...(loadOp === 'clear' ? { clearValue: { r: 0, g: 0, b: 0, a: 0 } } : {}),
			}],
		});
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, bindGroup);
		pass.draw(3);
		pass.end();
	}

	private parameterBuffer(values: Float32Array, buffers: any[]): any {
		const size = Math.max(128, Math.ceil(values.byteLength / 16) * 16);
		const buffer = this.device.createBuffer({ size, usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST });
		this.device.queue.writeBuffer(buffer, 0, values);
		buffers.push(buffer);
		return buffer;
	}

	private textureFor(data: Pixels, width: number, height: number, channels: number, typeMax: number): TextureEntry {
		const cached = this.textureCache.get(data as object);
		if (cached && cached.width === width && cached.height === height
			&& cached.channels === channels && cached.typeMax === typeMax) { return cached; }
		if (cached) {
			cached.texture.destroy();
			this.ownedTextures.delete(cached.texture);
			this.textureEntries.delete(cached);
		}
		const uploadStarted = performance.now();
		const isByte = data instanceof Uint8Array || data instanceof Uint8ClampedArray;
		const texture = this.createTexture(
			width, height, isByte ? 'rgba8unorm' : 'rgba32float',
			TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST,
		);
		if (isByte) {
			const rgba = channels === 4 && data instanceof Uint8Array
				? data : this.expandBytes(data, width, height, channels);
			this.device.queue.writeTexture(
				{ texture }, rgba, { bytesPerRow: width * 4, rowsPerImage: height }, { width, height },
			);
		} else {
			const rgba = this.expandFloats(data, width, height, channels, typeMax);
			this.device.queue.writeTexture(
				{ texture }, rgba, { bytesPerRow: width * 16, rowsPerImage: height }, { width, height },
			);
		}
		const entry = { key: data as object, texture, width, height, channels, typeMax };
		this.textureCache.set(data as object, entry);
		this.textureEntries.add(entry);
		if (this.activeTiming) {
			this.activeTiming.uploadCount++;
			this.activeTiming.uploadBytes += width * height * (isByte ? 4 : 16);
			this.activeTiming.uploadCpuMs += performance.now() - uploadStarted;
		}
		return entry;
	}

	private compositionSignature(layers: Layer[]): string {
		return JSON.stringify(layers.map(layer => ({
			id: layer.id,
			kind: layer.kind || 'raster',
			parentId: layer.parentId,
			adjustment: layer.adjustment,
			data: layer.data ? this.objectId(layer.data as object) : 0,
			width: layer.width,
			height: layer.height,
			channels: layer.channels,
			isFloat: !!layer.isFloat,
			typeMax: layer.typeMax,
			offsetX: layer.offsetX || 0,
			offsetY: layer.offsetY || 0,
			opacity: layer.opacity ?? 1,
			blendMode: layer.blendMode || 'normal',
			visible: layer.visible !== false,
			clipped: !!layer.clipped,
			maskCondition: layer.maskCondition,
			rasterMask: layer.rasterMask ? {
				data: this.objectId(layer.rasterMask.data as object),
				width: layer.rasterMask.width,
				height: layer.rasterMask.height,
				channels: layer.rasterMask.channels,
				typeMax: layer.rasterMask.typeMax,
				offsetX: layer.rasterMask.offsetX,
				offsetY: layer.rasterMask.offsetY,
				invert: !!layer.rasterMask.invert,
			} : null,
		})));
	}

	private objectId(value: object): number {
		let id = this.objectIds.get(value);
		if (!id) {
			id = this.nextObjectId++;
			this.objectIds.set(value, id);
		}
		return id;
	}

	private pruneTextureCache(active: Set<object>): void {
		for (const entry of this.textureEntries) {
			if (active.has(entry.key)) { continue; }
			entry.texture.destroy();
			this.ownedTextures.delete(entry.texture);
			this.textureEntries.delete(entry);
			this.textureCache.delete(entry.key);
		}
	}

	private expandBytes(data: ArrayLike<number>, width: number, height: number, channels: number): Uint8Array {
		const output = new Uint8Array(width * height * 4);
		for (let pixel = 0; pixel < width * height; pixel++) {
			const source = pixel * channels, target = pixel * 4;
			const gray = Number(data[source] || 0);
			output[target] = channels < 3 ? gray : Number(data[source]);
			output[target + 1] = channels < 3 ? gray : Number(data[source + 1]);
			output[target + 2] = channels < 3 ? gray : Number(data[source + 2]);
			output[target + 3] = channels === 2 ? Number(data[source + 1]) : channels === 4 ? Number(data[source + 3]) : 255;
		}
		return output;
	}

	private expandFloats(data: ArrayLike<number>, width: number, height: number, channels: number, typeMax: number): Float32Array {
		const output = new Float32Array(width * height * 4);
		const maximum = typeMax || 1;
		for (let pixel = 0; pixel < width * height; pixel++) {
			const source = pixel * channels, target = pixel * 4;
			const gray = Number(data[source]) / maximum;
			output[target] = channels < 3 ? gray : Number(data[source]) / maximum;
			output[target + 1] = channels < 3 ? gray : Number(data[source + 1]) / maximum;
			output[target + 2] = channels < 3 ? gray : Number(data[source + 2]) / maximum;
			output[target + 3] = channels === 2 ? Number(data[source + 1]) / maximum
				: channels === 4 ? Number(data[source + 3]) / maximum : 1;
		}
		return output;
	}

	private drawDisplay(
		encoder: any, buffers: any[], surface: number, width: number, height: number,
		settings: ImageSettings, nanColor: { r: number; g: number; b: number },
		typeMax: number, layers: Layer[], automaticRange?: [number, number],
	): any {
		const colormap = this.uploadColormap(settings.displayColormap || 'none');
		const params = new Float32Array(24);
		const min = automaticRange?.[0] ?? (settings.normalization?.gammaMode ? 0 : (settings.normalization?.min ?? 0) / typeMax);
		const max = automaticRange?.[1] ?? (settings.normalization?.gammaMode ? 1 : (settings.normalization?.max ?? typeMax) / typeMax);
		const rgb24 = settings.rgbAs24BitGrayscale === true && layers.some(layer => !!layer.data && layer.channels >= 3);
		params.set([
			width, height, min, max > min ? 1 / (max - min) : 0,
			settings.gamma?.in ?? 1, settings.gamma?.out ?? 1, settings.brightness?.offset ?? 0,
			nanColor.r / 255, nanColor.g / 255, nanColor.b / 255,
			colormap ? 1 : 0, rgb24 ? 1 : 0, typeMax,
			settings.normalization?.min ?? 0,
			(settings.normalization?.max ?? 16777215) > (settings.normalization?.min ?? 0)
				? 1 / ((settings.normalization?.max ?? 16777215) - (settings.normalization?.min ?? 0)) : 0,
		]);
		const parameterBuffer = this.parameterBuffer(params, buffers);
		// Reconfigure before acquiring the presentation texture. Chromium can
		// otherwise retain a consumed swap-chain texture when two renders happen
		// in the same animation frame (notably after auto-range's mapAsync split).
		this.context.configure({
			device: this.device, format: this.canvasFormat, alphaMode: 'premultiplied',
			usage: TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.COPY_SRC,
		});
		const target = this.context.getCurrentTexture();
		const bindGroup = this.device.createBindGroup({
			layout: this.displayPipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: this.surfaces[surface].createView() },
				{ binding: 1, resource: (colormap || this.dummyTexture).createView() },
				{ binding: 2, resource: { buffer: parameterBuffer } },
			],
		});
		this.renderPass(encoder, this.displayPipeline, bindGroup, target, 'clear');
		return target;
	}

	private encodeDisplaySamples(
		encoder: any, target: any, width: number, height: number,
	): { buffer: any; coordinates: number[][] } {
		const coordinates = [
			[0, 0], [Math.floor(width / 2), 0], [width - 1, 0],
			[0, Math.floor(height / 2)], [Math.floor(width / 2), Math.floor(height / 2)], [width - 1, Math.floor(height / 2)],
			[0, height - 1], [Math.floor(width / 2), height - 1], [width - 1, height - 1],
		];
		const buffer = this.device.createBuffer({
			size: coordinates.length * 256, usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST,
		});
		for (let index = 0; index < coordinates.length; index++) {
			encoder.copyTextureToBuffer(
				{ texture: target, origin: { x: coordinates[index][0], y: coordinates[index][1] } },
				{ buffer, offset: index * 256, bytesPerRow: 256, rowsPerImage: 1 },
				{ width: 1, height: 1 },
			);
		}
		return { buffer, coordinates };
	}

	private encodeAutoRange(
		encoder: any, surface: number, width: number, height: number, buffers: any[],
	): { buffer: any; textures: any[]; sourceUsesFloat: boolean } {
		const textures: any[] = [];
		let source = this.surfaces[surface], sourceWidth = width, sourceHeight = height, first = 1;
		while (sourceWidth > 1 || sourceHeight > 1) {
			const outputWidth = Math.max(1, Math.ceil(sourceWidth / 2));
			const outputHeight = Math.max(1, Math.ceil(sourceHeight / 2));
			const texture = this.createTexture(
				outputWidth, outputHeight, 'rg32float',
				TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.STORAGE_BINDING | TEXTURE_USAGE.COPY_SRC,
			);
			textures.push(texture);
			const params = this.parameterBuffer(new Float32Array([sourceWidth, sourceHeight, first]), buffers);
			const bindGroup = this.device.createBindGroup({
				layout: this.reductionPipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: source.createView() },
					{ binding: 1, resource: texture.createView() },
					{ binding: 2, resource: { buffer: params } },
				],
			});
			const pass = encoder.beginComputePass();
			pass.setPipeline(this.reductionPipeline);
			pass.setBindGroup(0, bindGroup);
			pass.dispatchWorkgroups(Math.ceil(outputWidth / 8), Math.ceil(outputHeight / 8));
			pass.end();
			source = texture; sourceWidth = outputWidth; sourceHeight = outputHeight; first = 0;
		}
		const buffer = this.device.createBuffer({ size: 256, usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST });
		if (textures.length) {
			encoder.copyTextureToBuffer(
				{ texture: textures[textures.length - 1] },
				{ buffer, bytesPerRow: 256, rowsPerImage: 1 }, { width: 1, height: 1 },
			);
		} else {
			// A 1×1 document needs no reduction; copy its RGBA value and read the
			// first two channels as a conservative range.
			encoder.copyTextureToBuffer(
				{ texture: source }, { buffer, bytesPerRow: 256, rowsPerImage: 1 }, { width: 1, height: 1 },
			);
		}
		return { buffer, textures, sourceUsesFloat: this.outputUsesFloat };
	}

	private async readAutoRange(
		reduction: { buffer: any; textures: any[]; sourceUsesFloat: boolean },
	): Promise<[number, number]> {
		await reduction.buffer.mapAsync(MAP_MODE_READ);
		const view = new DataView(reduction.buffer.getMappedRange());
		let min: number, max: number;
		if (reduction.textures.length) {
			min = view.getFloat32(0, true); max = view.getFloat32(4, true);
		} else {
			min = max = reduction.sourceUsesFloat
				? this.halfToFloat(view.getUint16(0, true))
				: view.getUint8(0) / 255;
		}
		reduction.buffer.unmap(); reduction.buffer.destroy();
		for (const texture of reduction.textures) { texture.destroy(); this.ownedTextures.delete(texture); }
		return Number.isFinite(min) && Number.isFinite(max) && max >= min ? [min, max] : [0, 1];
	}

	private uploadColormap(name: string): any {
		if (!name || name === 'none') { this.colormapName = 'none'; return null; }
		if (name === this.colormapName && this.colormapTexture) { return this.colormapTexture; }
		const lut = getColormapLut(name);
		if (!lut) { this.colormapName = 'none'; return null; }
		const rgba = new Uint8Array(256 * 4);
		for (let index = 0; index < 256; index++) {
			rgba[index * 4] = lut[index * 3]; rgba[index * 4 + 1] = lut[index * 3 + 1];
			rgba[index * 4 + 2] = lut[index * 3 + 2]; rgba[index * 4 + 3] = 255;
		}
		if (!this.colormapTexture) {
			this.colormapTexture = this.createTexture(256, 1, 'rgba8unorm', TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST);
		}
		this.device.queue.writeTexture(
			{ texture: this.colormapTexture }, rgba, { bytesPerRow: 1024, rowsPerImage: 1 }, { width: 256, height: 1 },
		);
		this.colormapName = name;
		return this.colormapTexture;
	}

	private encodeValidation(encoder: any, surface: number, width: number, height: number): { buffer: any; coordinates: number[][] } {
		const coordinates = [
			[0, 0], [Math.floor(width / 2), 0], [width - 1, 0],
			[0, Math.floor(height / 2)], [Math.floor(width / 2), Math.floor(height / 2)], [width - 1, Math.floor(height / 2)],
			[0, height - 1], [Math.floor(width / 2), height - 1], [width - 1, height - 1],
		];
		const buffer = this.device.createBuffer({
			size: coordinates.length * 256,
			usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST,
		});
		for (let index = 0; index < coordinates.length; index++) {
			encoder.copyTextureToBuffer(
				{ texture: this.surfaces[surface], origin: { x: coordinates[index][0], y: coordinates[index][1] } },
				{ buffer, offset: index * 256, bytesPerRow: 256, rowsPerImage: 1 },
				{ width: 1, height: 1 },
			);
		}
		return { buffer, coordinates };
	}

	private async validateSamples(
		validation: { buffer: any; coordinates: number[][] }, layers: Layer[], width: number, height: number,
	): Promise<void> {
		await validation.buffer.mapAsync(MAP_MODE_READ);
		const bytes = new Uint8Array(validation.buffer.getMappedRange());
		for (let index = 0; index < validation.coordinates.length; index++) {
			const [x, y] = validation.coordinates[index];
			const view = new DataView(bytes.buffer, bytes.byteOffset + index * 256, 8);
			const actual = this.outputUsesFloat
				? [0, 1, 2, 3].map(channel => this.halfToFloat(view.getUint16(channel * 2, true)))
				: [0, 1, 2, 3].map(channel => view.getUint8(channel) / 255);
			const exact = compositeRegion(layers, width, height, { x, y, width: 1, height: 1 });
			const maximum = exact.typeMax || 1;
			const expected = exact.coveredCount <= 0 ? [0, 0, 0, 0]
				: exact.channels === 1 ? [exact.data[0] / maximum, exact.data[0] / maximum, exact.data[0] / maximum, 1]
					: exact.channels === 3 ? [exact.data[0] / maximum, exact.data[1] / maximum, exact.data[2] / maximum, 1]
						: [exact.data[0] / maximum, exact.data[1] / maximum, exact.data[2] / maximum, exact.data[3] / maximum];
			for (let channel = 0; channel < 4; channel++) {
				const bothInvalid = !Number.isFinite(actual[channel]) && !Number.isFinite(expected[channel]);
				if (!bothInvalid && Math.abs(actual[channel] - expected[channel]) > 0.006) {
					validation.buffer.unmap(); validation.buffer.destroy();
					throw new Error(`WebGPU parity mismatch at ${x},${y} channel ${channel}: ${actual[channel]} != ${expected[channel]}`);
				}
			}
		}
		validation.buffer.unmap();
		validation.buffer.destroy();
	}

	private async validateDisplaySamples(
		validation: { buffer: any; coordinates: number[][] },
		layers: Layer[], width: number, height: number, settings: ImageSettings,
		nanColor: { r: number; g: number; b: number }, typeMax: number,
		automaticRange?: [number, number],
	): Promise<void> {
		await validation.buffer.mapAsync(MAP_MODE_READ);
		const bytes = new Uint8Array(validation.buffer.getMappedRange());
		const isBgra = this.canvasFormat.startsWith('bgra');
		for (let index = 0; index < validation.coordinates.length; index++) {
			const [x, y] = validation.coordinates[index];
			const offset = index * 256;
			const actual = isBgra
				? [bytes[offset + 2], bytes[offset + 1], bytes[offset], bytes[offset + 3]]
				: [bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]];
			const expected = this.expectedDisplayPixel(
				layers, width, height, x, y, settings, nanColor, typeMax, automaticRange,
			);
			for (let channel = 0; channel < 4; channel++) {
				if (Math.abs(actual[channel] - expected[channel]) > 4) {
					validation.buffer.unmap(); validation.buffer.destroy();
					throw new Error(
						`WebGPU display mismatch at ${x},${y} channel ${channel}: ` +
						`${actual[channel]} != ${expected[channel]}`,
					);
				}
			}
		}
		validation.buffer.unmap();
		validation.buffer.destroy();
	}

	private expectedDisplayPixel(
		layers: Layer[], width: number, height: number, x: number, y: number,
		settings: ImageSettings, nanColor: { r: number; g: number; b: number },
		typeMax: number, automaticRange?: [number, number],
	): number[] {
		const exact = compositeRegion(layers, width, height, { x, y, width: 1, height: 1 });
		if (exact.coveredCount <= 0) { return [0, 0, 0, 0]; }
		const maximum = exact.typeMax || typeMax || 1;
		const value = exact.channels === 1
			? [exact.data[0] / maximum, exact.data[0] / maximum, exact.data[0] / maximum, 1]
			: exact.channels === 2
				? [exact.data[0] / maximum, exact.data[0] / maximum, exact.data[0] / maximum, exact.data[1] / maximum]
				: exact.channels === 3
					? [exact.data[0] / maximum, exact.data[1] / maximum, exact.data[2] / maximum, 1]
					: [exact.data[0] / maximum, exact.data[1] / maximum, exact.data[2] / maximum, exact.data[3] / maximum];
		if (value[3] <= 0) { return [0, 0, 0, 0]; }
		if (!value.slice(0, 3).every(Number.isFinite)) {
			return [nanColor.r, nanColor.g, nanColor.b, 255];
		}
		const gammaIn = Math.max(0.0001, settings.gamma?.in ?? 1);
		const gammaOut = Math.max(0.0001, settings.gamma?.out ?? 1);
		const exposure = 2 ** (settings.brightness?.offset ?? 0);
		const transform = (sample: number): number => {
			const withInputGamma = Math.max(0, Math.min(1, sample)) ** gammaIn * exposure;
			return Math.max(0, Math.min(1, Math.max(0, withInputGamma) ** (1 / gammaOut)));
		};
		let normalized: number[];
		const rgb24 = settings.rgbAs24BitGrayscale === true &&
			layers.some(layer => !!layer.data && layer.channels >= 3);
		if (rgb24) {
			const bytes24 = value.slice(0, 3).map(sample =>
				Math.floor(Math.max(0, Math.min(255, sample * typeMax)) + 0.5));
			const packed = bytes24[0] * 65536 + bytes24[1] * 256 + bytes24[2];
			const low = settings.normalization?.min ?? 0;
			const high = settings.normalization?.max ?? 16777215;
			const gray = transform(high > low ? (packed - low) / (high - low) : 0);
			normalized = [gray, gray, gray];
		} else {
			const low = automaticRange?.[0] ??
				(settings.normalization?.gammaMode ? 0 : (settings.normalization?.min ?? 0) / typeMax);
			const high = automaticRange?.[1] ??
				(settings.normalization?.gammaMode ? 1 : (settings.normalization?.max ?? typeMax) / typeMax);
			normalized = value.slice(0, 3).map(sample =>
				transform(high > low ? (sample - low) / (high - low) : 0));
		}
		const lut = getColormapLut(settings.displayColormap || 'none');
		if (lut) {
			const lutIndex = Math.max(0, Math.min(255, Math.round(normalized[0] * 255)));
			normalized = [lut[lutIndex * 3], lut[lutIndex * 3 + 1], lut[lutIndex * 3 + 2]]
				.map(channel => channel / 255);
		}
		return [
			Math.round(normalized[0] * 255), Math.round(normalized[1] * 255),
			Math.round(normalized[2] * 255), Math.round(Math.max(0, Math.min(1, value[3])) * 255),
		];
	}

	private halfToFloat(value: number): number {
		const sign = (value & 0x8000) ? -1 : 1, exponent = (value >> 10) & 0x1f, fraction = value & 0x3ff;
		if (exponent === 0x1f) { return fraction ? Number.NaN : sign * Infinity; }
		if (exponent === 0) { return sign * 2 ** -14 * (fraction / 1024); }
		return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
	}

	private isPixels(data: ArrayLike<number>): data is Pixels {
		return data instanceof Uint8Array || data instanceof Uint8ClampedArray ||
			data instanceof Uint16Array || data instanceof Uint32Array ||
			data instanceof Int8Array || data instanceof Int16Array || data instanceof Int32Array ||
			data instanceof Float32Array || data instanceof Float64Array;
	}
}

const VERTEX = `
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
	var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
	return vec4f(positions[index], 0.0, 1.0);
}`;

const BLEND_SHADER = `${VERTEX}
@group(0) @binding(0) var previousTexture: texture_2d<f32>;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var maskTexture: texture_2d<f32>;
@group(0) @binding(3) var clipTexture: texture_2d<f32>;
@group(0) @binding(4) var<storage, read> p: array<f32>;
fn nanValue() -> f32 { return bitcast<f32>(bitcast<u32>(p[0]) | 0x7fc00000u); }
fn invalidF(value: f32) -> bool { return (bitcast<u32>(value) & 0x7f800000u) == 0x7f800000u; }
fn invalid3(value: vec3f) -> bool {
	let bits = bitcast<vec3u>(value) & vec3u(0x7f800000u);
	return any(bits == vec3u(0x7f800000u));
}
fn blendValue(below: vec3f, source: vec3f, mode: i32) -> vec3f {
	if (mode == 1) { return below * source; }
	if (mode == 2) { return vec3f(1.0) - (vec3f(1.0) - below) * (vec3f(1.0) - source); }
	if (mode == 3) { return select(2.0 * below * source, vec3f(1.0) - 2.0 * (vec3f(1.0) - below) * (vec3f(1.0) - source), below >= vec3f(0.5)); }
	if (mode == 4) { return min(below, source); }
	if (mode == 5) { return max(below, source); }
	if (mode == 6 || mode == 10) { return abs(below - source); }
	if (mode == 7) { return below + source - 2.0 * below * source; }
	if (mode == 8) { return below + source; }
	if (mode == 9) { return below - source; }
	if (mode == 11) { return below * source * p[21]; }
	if (mode == 12) {
		return vec3f(select(below.r / source.r / p[21], nanValue(), source.r == 0.0),
			select(below.g / source.g / p[21], nanValue(), source.g == 0.0),
			select(below.b / source.b / p[21], nanValue(), source.b == 0.0));
	}
	if (mode == 13) { return min(below, source); }
	if (mode == 14) { return max(below, source); }
	if (mode == 15) { return (below + source) * 0.5; }
	return source;
}
fn maskFactor(pixel: vec2i) -> f32 {
	if (i32(p[8]) == 0) { return 1.0; }
	let local = pixel - vec2i(i32(p[11]), i32(p[12]));
	let size = vec2i(i32(p[13]), i32(p[14]));
	if (any(local < vec2i(0)) || any(local >= size)) { return select(0.0, 1.0, i32(p[15]) == 1); }
	let sourceSize = vec2i(i32(p[9]), i32(p[10]));
	let coordinate = min(sourceSize - 1, vec2i((vec2f(local) + 0.5) * vec2f(sourceSize) / vec2f(size)));
	let value = textureLoad(maskTexture, coordinate, 0).r;
	let factor = select(clamp(value, 0.0, 1.0), 0.0, invalidF(value));
	return select(factor, 1.0 - factor, i32(p[15]) == 1);
}
fn keepMask(value: f32, condition: i32) -> bool {
	if (condition == 1) { return value > p[20]; }
	if (condition == 2) { return value >= p[20]; }
	if (condition == 3) { return value < p[20]; }
	if (condition == 4) { return value <= p[20]; }
	if (condition == 5) { return abs(value - p[20]) <= 1e-6; }
	if (condition == 6) { return !invalidF(value); }
	if (condition == 7) { return invalidF(value); }
	return true;
}
@fragment fn blend(@builtin(position) position: vec4f) -> @location(0) vec4f {
	let pixel = vec2i(position.xy);
	let below = textureLoad(previousTexture, pixel, 0);
	let local = pixel - vec2i(i32(p[4]), i32(p[5]));
	let layerSize = vec2i(i32(p[6]), i32(p[7]));
	if (any(local < vec2i(0)) || any(local >= layerSize)) { return below; }
	let sourceSize = vec2i(i32(p[2]), i32(p[3]));
	let coordinate = min(sourceSize - 1, vec2i((vec2f(local) + 0.5) * vec2f(sourceSize) / vec2f(layerSize)));
	let source = textureLoad(sourceTexture, coordinate, 0);
	let mode = i32(p[17]);
	if (mode == 16) {
		let value = dot(source.rgb, vec3f(0.2126, 0.7152, 0.0722));
		return select(vec4f(0.0), below, keepMask(value, i32(p[19])));
	}
	if (invalidF(source.a)) { return vec4f(vec3f(nanValue()), 1.0); }
	let clipAlpha = select(1.0, textureLoad(clipTexture, pixel, 0).a, i32(p[16]) == 1);
	let factor = maskFactor(pixel);
	let sourceAlpha = clamp(source.a * p[18] * factor * clipAlpha, 0.0, 1.0);
	if (sourceAlpha <= 0.0) { return below; }
	if (mode >= 8 && mode <= 15) {
		if (below.a <= 0.0) { return vec4f(source.rgb, 1.0); }
		return vec4f(mix(below.rgb, blendValue(below.rgb, source.rgb, mode), clamp(p[18] * factor * clipAlpha, 0.0, 1.0)), below.a);
	}
	let outputAlpha = sourceAlpha + below.a * (1.0 - sourceAlpha);
	if (below.a <= 0.0 || (mode == 0 && sourceAlpha >= 1.0)) { return vec4f(source.rgb, outputAlpha); }
	if (invalid3(source.rgb) || invalid3(below.rgb)) { return vec4f(vec3f(nanValue()), outputAlpha); }
	let blended = blendValue(below.rgb, source.rgb, mode);
	let color = select(
		((1.0 - sourceAlpha) * below.a * below.rgb + (1.0 - below.a) * sourceAlpha * source.rgb + below.a * sourceAlpha * blended) / outputAlpha,
		(source.rgb * sourceAlpha + below.rgb * below.a * (1.0 - sourceAlpha)) / outputAlpha,
		mode == 0,
	);
	return vec4f(color, outputAlpha);
}`;

const ADJUSTMENT_SHADER = `${VERTEX}
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var maskTexture: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> p: array<f32>;
fn invalidF(value: f32) -> bool { return (bitcast<u32>(value) & 0x7f800000u) == 0x7f800000u; }
fn invalid3(value: vec3f) -> bool {
	let bits = bitcast<vec3u>(value) & vec3u(0x7f800000u);
	return any(bits == vec3u(0x7f800000u));
}
fn rgbToHsl(color: vec3f) -> vec3f {
	let maximum = max(color.r, max(color.g, color.b)); let minimum = min(color.r, min(color.g, color.b));
	let delta = maximum - minimum; let lightness = (maximum + minimum) * 0.5; var hue = 0.0;
	if (delta > 0.0) {
		if (maximum == color.r) { hue = (color.g - color.b) / delta % 6.0; }
		else if (maximum == color.g) { hue = (color.b - color.r) / delta + 2.0; }
		else { hue = (color.r - color.g) / delta + 4.0; }
		hue = (hue * 60.0 + 360.0) % 360.0;
	}
	let saturation = select(0.0, delta / max(1e-6, 1.0 - abs(2.0 * lightness - 1.0)), delta > 0.0);
	return vec3f(hue, saturation, lightness);
}
fn hslToRgb(hsl: vec3f) -> vec3f {
	let c = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y; let section = hsl.x / 60.0;
	let x = c * (1.0 - abs(section % 2.0 - 1.0)); var rgb = vec3f(c, x, 0.0);
	if (section >= 5.0) { rgb = vec3f(c, 0.0, x); } else if (section >= 4.0) { rgb = vec3f(x, 0.0, c); }
	else if (section >= 3.0) { rgb = vec3f(0.0, x, c); } else if (section >= 2.0) { rgb = vec3f(0.0, c, x); }
	else if (section >= 1.0) { rgb = vec3f(x, c, 0.0); }
	return rgb + vec3f(hsl.z - c * 0.5);
}
fn luminance(color: vec3f) -> f32 { return dot(color, vec3f(0.2126, 0.7152, 0.0722)); }
fn hueWeight(hue: f32, center: f32) -> f32 {
	let distance = abs((hue - center + 540.0) % 360.0 - 180.0);
	return select(select((60.0 - distance) / 30.0, 0.0, distance >= 60.0), 1.0, distance <= 30.0);
}
fn configuredHueWeight(hue: f32, range: u32) -> f32 {
	if (i32(p[81u + range]) == 0) { return hueWeight(hue, f32(range) * 60.0); }
	let base = 35u + range * 7u;
	var a = p[base]; var b = p[base + 1u]; var c = p[base + 2u]; var d = p[base + 3u];
	if (b < a) { b += 360.0; } if (c < b) { c += 360.0; } if (d < c) { d += 360.0; }
	var weight = 0.0;
	for (var turn = -1; turn <= 2; turn++) {
		let candidate = hue + f32(turn) * 360.0;
		if (candidate >= a && candidate <= d) {
			let value = select(select((d - candidate) / max(1e-6, d - c), 1.0, candidate <= c),
				(candidate - a) / max(1e-6, b - a), candidate < b);
			weight = max(weight, value);
		}
	}
	return clamp(weight, 0.0, 1.0);
}
fn lut(color: vec3f) -> vec3f {
	let position = clamp(color, vec3f(0.0), vec3f(1.0)) * 255.0;
	let low = vec3u(floor(position)); let high = min(low + 1u, vec3u(255)); let fraction = position - vec3f(low);
	let a = vec3f(p[96u + low.r], p[352u + low.g], p[608u + low.b]);
	let b = vec3f(p[96u + high.r], p[352u + high.g], p[608u + high.b]);
	return mix(a, b, fraction);
}
fn mixer(color: vec3f, base: u32) -> f32 {
	return dot(color, vec3f(p[32u + base], p[33u + base], p[34u + base])) / 100.0 + p[35u + base] / 100.0;
}
fn direct(color: vec3f, kind: i32) -> vec3f {
	var result = color;
	if (kind == 2) {
		let contrast = clamp(p[33] / 100.0, -0.99, 0.99); let factor = (1.0 + contrast) / (1.0 - contrast);
		result = (result - 0.5) * factor + 0.5 + p[32] / 100.0;
	} else if (kind == 3) { result = pow(max(vec3f(0.0), result * exp2(p[32]) + p[33]), vec3f(1.0 / max(0.01, p[34]))); }
	else if (kind == 4) { result = vec3f(1.0) - result; }
	else if (kind == 5) { result = select(vec3f(mixer(result, 0u), mixer(result, 4u), mixer(result, 8u)), vec3f(mixer(result, 12u)), i32(p[80]) == 1); }
	else if (kind == 6) {
		let originalLightness = rgbToHsl(result).z; let light = luminance(result);
		let weights = vec3f(clamp((0.5-light)*2.0,0.0,1.0),1.0-abs(light-0.5)*2.0,clamp((light-0.5)*2.0,0.0,1.0));
		for (var range = 0u; range < 3u; range++) { let base=32u+range*3u; result += vec3f(p[base],p[base+1u],p[base+2u])/100.0*weights[range]; }
		if (i32(p[80]) == 1) { let hsl=rgbToHsl(clamp(result,vec3f(0.0),vec3f(1.0))); result=hslToRgb(vec3f(hsl.xy,originalLightness)); }
	} else if (kind == 7) {
		let hsl=rgbToHsl(result); var weighted=0.0; var total=0.0;
		for(var range=0u;range<6u;range++){let weight=hueWeight(hsl.x,f32(range)*60.0);weighted+=p[32u+range]*weight;total+=weight;}
		result=vec3f(luminance(result)+((select(50.0,weighted/total,total>0.0)-50.0)/100.0)*hsl.y*0.5);
	} else if (kind == 8) { result=vec3f(select(0.0,1.0,luminance(result)*255.0>=p[32])); }
	else if (kind == 9) { let levels=clamp(floor(p[32]+0.5),2.0,255.0);result=floor(result*(levels-1.0)+0.5)/(levels-1.0); }
	else if (kind == 10) { result=lut(vec3f(luminance(result))); }
	return clamp(result,vec3f(0.0),vec3f(1.0));
}
fn maskFactor(pixel: vec2i) -> f32 {
	if (i32(p[2]) == 0) { return 1.0; }
	let local=pixel-vec2i(i32(p[5]),i32(p[6]));let size=vec2i(i32(p[7]),i32(p[8]));
	if(any(local<vec2i(0))||any(local>=size)){return select(0.0,1.0,i32(p[9])==1);}
	let sourceSize=vec2i(i32(p[3]),i32(p[4]));let coordinate=min(sourceSize-1,vec2i((vec2f(local)+0.5)*vec2f(sourceSize)/vec2f(size)));
	let value=textureLoad(maskTexture,coordinate,0).r;let factor=select(clamp(value,0.0,1.0),0.0,invalidF(value));
	return select(factor,1.0-factor,i32(p[9])==1);
}
@fragment fn adjustment(@builtin(position) position: vec4f) -> @location(0) vec4f {
	let pixel=vec2i(position.xy);let source=textureLoad(sourceTexture,pixel,0);
	if(source.a<=0.0||invalid3(source.rgb)){return source;}
	let kind=i32(p[0]);var adjusted=source.rgb;
	if(kind==0){adjusted=lut(source.rgb);}
	else if(kind==1){
		var hsl=rgbToHsl(clamp(source.rgb,vec3f(0.0),vec3f(1.0)));
		if(i32(p[80])==1){hsl.x=(p[32]+360.0)%360.0;hsl.y=clamp(p[33],0.0,1.0);let d=clamp(p[34],-1.0,1.0);hsl.z=select(hsl.z+(1.0-hsl.z)*d,hsl.z*(1.0+d),d<0.0);}
		else{
			let sourceHue=hsl.x;hsl.x=(hsl.x+p[32]+360.0)%360.0;hsl.y=clamp(hsl.y+p[33]/100.0,0.0,1.0);hsl.z=clamp(hsl.z+p[34]/100.0,0.0,1.0);
			for(var range=0u;range<6u;range++){let base=35u+range*7u;let weight=configuredHueWeight(sourceHue,range);
				hsl.x=(hsl.x+p[base+4u]*weight+360.0)%360.0;hsl.y=clamp(hsl.y+p[base+5u]/100.0*weight,0.0,1.0);hsl.z=clamp(hsl.z+p[base+6u]/100.0*weight,0.0,1.0);}
		}
		adjusted=hslToRgb(hsl);
	}else{adjusted=direct(source.rgb,kind);}
	return vec4f(mix(source.rgb,adjusted,p[1]*maskFactor(pixel)),source.a);
}`;

const DISPLAY_SHADER = `${VERTEX}
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var colormapTexture: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> p: array<f32>;
fn invalid3(value: vec3f) -> bool {
	let bits = bitcast<vec3u>(value) & vec3u(0x7f800000u);
	return any(bits == vec3u(0x7f800000u));
}
@fragment fn display(@builtin(position) position: vec4f) -> @location(0) vec4f {
	let value=textureLoad(sourceTexture,vec2i(position.xy),0);
	if(value.a<=0.0){return vec4f(0.0);}
	if(invalid3(value.rgb)){return vec4f(vec3f(p[7],p[8],p[9]),1.0);}
	if(i32(p[11])==1){
		let bytes=floor(clamp(value.rgb*p[12],vec3f(0.0),vec3f(255.0))+0.5);
		let packed=bytes.r*65536.0+bytes.g*256.0+bytes.b;
		var gray=clamp((packed-p[13])*p[14],0.0,1.0);gray=pow(gray,max(0.0001,p[4]))*exp2(p[6]);gray=pow(max(gray,0.0),1.0/max(0.0001,p[5]));
		return vec4f(vec3f(clamp(gray,0.0,1.0)),value.a);
	}
	var normalized=clamp((value.rgb-p[2])*p[3],vec3f(0.0),vec3f(1.0));
	normalized=pow(max(normalized,vec3f(0.0)),vec3f(max(0.0001,p[4])))*exp2(p[6]);
	normalized=pow(max(normalized,vec3f(0.0)),vec3f(1.0/max(0.0001,p[5])));
	if(i32(p[10])==1){let index=i32(clamp(round(normalized.r*255.0),0.0,255.0));return vec4f(textureLoad(colormapTexture,vec2i(index,0),0).rgb,value.a);}
	return vec4f(clamp(normalized,vec3f(0.0),vec3f(1.0)),value.a);
}`;

const REDUCTION_SHADER = `
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var destinationTexture: texture_storage_2d<rg32float, write>;
@group(0) @binding(2) var<storage, read> p: array<f32>;
fn invalidF(value: f32) -> bool { return (bitcast<u32>(value) & 0x7f800000u) == 0x7f800000u; }
@compute @workgroup_size(8, 8)
fn reduce(@builtin(global_invocation_id) id: vec3u) {
	let sourceSize = vec2u(u32(p[0]), u32(p[1]));
	let outputSize = (sourceSize + vec2u(1)) / 2u;
	if (any(id.xy >= outputSize)) { return; }
	let origin = id.xy * 2u;
	var minimum = 3.402823466e+38; var maximum = -3.402823466e+38;
	for (var y = 0u; y < 2u; y++) { for (var x = 0u; x < 2u; x++) {
		let coordinate = origin + vec2u(x, y);
		if (any(coordinate >= sourceSize)) { continue; }
		let value = textureLoad(sourceTexture, vec2i(coordinate), 0);
		if (i32(p[2]) == 1) {
			if (value.a <= 0.0) { continue; }
			for (var channel = 0u; channel < 3u; channel++) {
				let sampleValue = value[channel];
				if (!invalidF(sampleValue)) { minimum = min(minimum, sampleValue); maximum = max(maximum, sampleValue); }
			}
		} else if (value.r <= value.g) {
			minimum = min(minimum, value.r); maximum = max(maximum, value.g);
		}
	} }
	textureStore(destinationTexture, vec2i(id.xy), vec4f(minimum, maximum, 0.0, 0.0));
}`;
