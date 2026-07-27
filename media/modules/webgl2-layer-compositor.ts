"use strict";

import type { ImageSettings } from './settings-manager.js';
import { compositeRegion, evaluateCurvePoints, type Layer, type LayerAdjustment, type AdjustmentChannel } from './layer-compositor.js';
import { getColormapLut } from './colormaps.js';

type SupportedPixels =
	| Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array
	| Int8Array | Int16Array | Int32Array | Float32Array | Float64Array;

type TextureEntry = {
	texture: WebGLTexture;
	width: number;
	height: number;
	channels: number;
	encoding: 0 | 1 | 2;
	nativeMaximum: number;
};
type SurfaceSet = { textures: WebGLTexture[]; framebuffers: WebGLFramebuffer[] };
type IsolatedStackCacheEntry = {
	signature: string;
	texture: WebGLTexture;
	framebuffer: WebGLFramebuffer;
	width: number;
	height: number;
	usesFloat: boolean;
};

const GPU_BLEND_MODES = new Map<string, number>([
	['normal', 0],
	['multiply', 1],
	['screen', 2],
	['overlay', 3],
	['darken', 4],
	['lighten', 5],
	['difference', 6],
	['exclusion', 7],
	['add', 8],
	['subtract', 9],
	['raw-difference', 10],
	['raw-multiply', 11],
	['divide', 12],
	['min', 13],
	['max', 14],
	['average', 15],
	['mask', 16],
]);

/**
 * GPU display compositor for the common flat-raster path.
 *
 * It produces a display canvas only: source arrays remain authoritative for
 * exact pixel inspection and the CPU compositor remains authoritative for
 * export. Unsupported document semantics return null and use the worker.
 */
export class WebGL2LayerCompositor {
	private canvas: HTMLCanvasElement | null = null;
	private gl: WebGL2RenderingContext | null = null;
	private blendProgram: WebGLProgram | null = null;
	private adjustmentProgram: WebGLProgram | null = null;
	private displayProgram: WebGLProgram | null = null;
	private reductionProgram: WebGLProgram | null = null;
	private vao: WebGLVertexArrayObject | null = null;
	private outputTextures: WebGLTexture[] | null = null;
	private framebuffers: WebGLFramebuffer[] | null = null;
	private surfaceCache = new Map<string, SurfaceSet>();
	private isolatedStackCache = new WeakMap<object, Map<string, IsolatedStackCacheEntry>>();
	private cachedFramebuffers = new Set<WebGLFramebuffer>();
	private objectIds = new WeakMap<object, number>();
	private nextObjectId = 1;
	private outputWidth = 0;
	private outputHeight = 0;
	private outputUsesFloat = false;
	private compositionTypeMax = 1;
	private textureCache = new Map<object, TextureEntry>();
	private adjustmentLutCache = new Map<object, WebGLTexture>();
	private ownedTextures = new Set<WebGLTexture>();
	private dummyFloat: WebGLTexture | null = null;
	private dummyUint: WebGLTexture | null = null;
	private dummyInt: WebGLTexture | null = null;
	private colormapTexture: WebGLTexture | null = null;
	private colormapName = 'none';
	private reductionTextures: WebGLTexture[] = [];
	private reductionFramebuffers: WebGLFramebuffer[] = [];
	private reductionSize = '';
	private failed = false;
	private logger: (message: string) => void = message => console.warn(message);

	canRender(layers: Layer[], settings: ImageSettings, width: number, height: number): boolean {
		return this.unsupportedReason(layers, settings, width, height) === null;
	}

	setLogger(logger: (message: string) => void): void {
		this.logger = logger;
	}

	retry(): void {
		this.failed = false;
	}

	unsupportedReason(layers: Layer[], settings: ImageSettings, width: number, height: number): string | null {
		if (settings.gpuAcceleration === false) { return 'GPU acceleration is disabled in the image settings'; }
		if (width <= 0 || height <= 0) { return `the document size ${width}×${height} is invalid`; }
		if (typeof WebGL2RenderingContext === 'undefined') { return 'WebGL2 is unavailable in this webview'; }
		for (const layer of layers) {
			const label = layer.name || String(layer.id || 'unnamed layer');
			if (layer.rasterMask && !this.isSupportedPixels(layer.rasterMask.data)) {
				return `"${label}" has an unsupported ${layer.rasterMask.data.constructor?.name || 'mask'} storage`;
			}
			if (layer.kind === 'group') {
				if (!layer.id) { return `"${label}" is a group without an id`; }
				if (!GPU_BLEND_MODES.has(layer.blendMode || 'normal')) { return `"${label}" uses unsupported blend mode "${layer.blendMode}"`; }
				continue;
			}
			if (layer.kind === 'adjustment') {
				if (!layer.adjustment) { return `"${label}" has no adjustment parameters`; }
				if (!this.isSupportedAdjustment(layer.adjustment)) {
					return `"${label}" uses unsupported ${layer.adjustment.type} parameters`;
				}
				continue;
			}
			if (layer.visible === false || (layer.opacity ?? 1) <= 0) { continue; }
			if (!layer.data) { return `"${label}" has no raster pixels`; }
			if (!GPU_BLEND_MODES.has(layer.blendMode || 'normal')) { return `"${label}" uses unsupported blend mode "${layer.blendMode}"`; }
			if (layer.channels < 1 || layer.channels > 4) { return `"${label}" has unsupported ${layer.channels}-channel pixels`; }
			if (!this.isSupportedPixels(layer.data)) { return `"${label}" uses unsupported ${layer.data.constructor?.name || 'pixel'} storage`; }
		}
		return null;
	}

	render(
		layers: Layer[],
		documentWidth: number,
		documentHeight: number,
		scale: number,
		settings: ImageSettings,
		nanColor: { r: number; g: number; b: number },
		strict = false,
	): HTMLCanvasElement | null {
		const unsupported = this.unsupportedReason(layers, settings, documentWidth, documentHeight);
		if (unsupported) {
			const error = new Error(`WebGL2 compositor cannot render this document: ${unsupported}`);
			if (strict) { throw error; }
			return null;
		}
		try {
			const width = Math.max(1, Math.round(documentWidth * scale));
			const height = Math.max(1, Math.round(documentHeight * scale));
			if (!this.ensureContext(width, height)) { throw new Error('WebGL2 or EXT_color_buffer_float is unavailable'); }
			const gl = this.gl as WebGL2RenderingContext;
			// Consumers may inspect the returned canvas with the shared WebGL
			// context. Do not attribute a stale external GL error to the next
			// compositor render.
			while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
			const maximumTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
			if (width > maximumTextureSize || height > maximumTextureSize) {
				throw new Error(`document surface ${width}×${height} exceeds MAX_TEXTURE_SIZE ${maximumTextureSize}`);
			}
			const renderLayers = this.foldGroupOffsets(layers);
			this.pruneTextureCache(new Set(
				renderLayers.flatMap(layer => [
					...(layer.data && this.isSupportedPixels(layer.data) ? [layer.data as object] : []),
					...(layer.rasterMask?.data && this.isSupportedPixels(layer.rasterMask.data) ? [layer.rasterMask.data as object] : []),
				]),
			));
			this.pruneAdjustmentLutCache(new Set(
				renderLayers.flatMap(layer => layer.adjustment ? [layer.adjustment as object] : []),
			));
			for (const layer of renderLayers) {
				if (layer.visible === false || (layer.opacity ?? 1) <= 0 || !layer.data) { continue; }
				if (layer.width > maximumTextureSize || layer.height > maximumTextureSize) {
					throw new Error(`layer "${layer.name || layer.id}" exceeds MAX_TEXTURE_SIZE ${maximumTextureSize}`);
				}
				this.textureFor(layer.data as SupportedPixels, layer.width, layer.height, layer.channels);
				if (layer.rasterMask && this.isSupportedPixels(layer.rasterMask.data)) {
					this.textureFor(
						layer.rasterMask.data, layer.rasterMask.width, layer.rasterMask.height,
						Math.max(1, layer.rasterMask.channels ?? 1),
					);
				}
			}
			const usesFloat =
				renderLayers.some(layer => ['add', 'subtract', 'raw-difference', 'raw-multiply', 'divide', 'min', 'max', 'average'].includes(layer.blendMode || '')) ||
				renderLayers.some(layer => layer.data && (
				!(layer.data instanceof Uint8Array || layer.data instanceof Uint8ClampedArray) ||
				(layer.typeMax || 255) !== 255
			));
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
			const surfaceCount = (maximumDepth + 1) * 2 + 3;
			this.ensureOutputSurfaces(width, height, usesFloat, surfaceCount);
			this.compositionTypeMax = renderLayers.find(layer => layer.visible !== false && (layer.opacity ?? 1) > 0 && layer.data)?.typeMax || 1;
			this.clearOutputSurfaces();

			const previous = this.drawStack(renderLayers, undefined, scale, 0, new Set<string>());
			this.drawDisplay(previous, settings, layers, nanColor);
			// The WebGL canvas is copied immediately into a separate 2D canvas.
			// Finish the command stream first: a flush only submits work and can
			// expose an incomplete multi-pass stack to cross-context drawImage on
			// large documents. This also makes the reported render duration real.
			gl.finish();
			const error = gl.getError();
			if (error !== gl.NO_ERROR || gl.isContextLost()) {
				throw new Error(`GPU composition did not complete (${error})`);
			}
			if (scale === 1) { this.validateNativeSamples(layers, documentWidth, documentHeight, previous); }
			return this.canvas;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.logger(`[LayerCompositor] WebGL2 failed: ${detail}`);
			this.dispose();
			// A context loss or transient allocation failure must not poison the
			// selected backend permanently. The next requested render creates a
			// fresh context and either succeeds or reports its own exact failure.
			this.failed = false;
			if (strict) { throw error; }
			return null;
		}
	}

	private foldGroupOffsets(layers: Layer[]): Layer[] {
		const groups = new Map(layers.filter(layer => layer.kind === 'group' && layer.id)
			.map(layer => [layer.id as string, layer]));
		const translation = (layer: Layer): { x: number; y: number } => {
			let parentId = layer.parentId, x = 0, y = 0;
			const visited = new Set<string>();
			while (parentId && !visited.has(parentId)) {
				visited.add(parentId);
				const parent = groups.get(parentId);
				if (!parent) { break; }
				x += parent.offsetX || 0; y += parent.offsetY || 0;
				parentId = parent.parentId;
			}
			return { x, y };
		};
		return layers.map(layer => {
			const inherited = translation(layer);
			if (layer.kind === 'group') {
				return {
					...layer, offsetX: 0, offsetY: 0,
					rasterMask: layer.rasterMask ? {
						...layer.rasterMask,
						offsetX: (layer.rasterMask.offsetX ?? layer.offsetX ?? 0) + inherited.x,
						offsetY: (layer.rasterMask.offsetY ?? layer.offsetY ?? 0) + inherited.y,
					} : undefined,
				};
			}
			if (!inherited.x && !inherited.y) { return layer; }
			return {
				...layer,
				offsetX: (layer.offsetX || 0) + inherited.x,
				offsetY: (layer.offsetY || 0) + inherited.y,
				rasterMask: layer.rasterMask ? {
					...layer.rasterMask,
					offsetX: (layer.rasterMask.offsetX ?? layer.offsetX ?? 0) + inherited.x,
					offsetY: (layer.rasterMask.offsetY ?? layer.offsetY ?? 0) + inherited.y,
				} : undefined,
			};
		});
	}

	private drawStack(layers: Layer[], parentId: string | undefined, scale: number, depth: number, ancestors: Set<string>): number {
		const first = depth * 2, second = first + 1;
		this.clearSurface(first); this.clearSurface(second);
		let previous = first;
		const siblings = layers.filter(layer => (layer.parentId || undefined) === parentId);
		for (let index = 0; index < siblings.length;) {
			const layer = siblings[index];
			let end = index + 1;
			while (end < siblings.length && siblings[end].clipped) { end++; }
			const effects = siblings.slice(index + 1, end);
			if (layer.visible === false || (layer.opacity ?? 1) <= 0) { index = end; continue; }
			if (layer.kind === 'group') {
				const id = layer.id || '';
				if (!id || ancestors.has(id)) { index = end; continue; }
				const nextAncestors = new Set(ancestors); nextAncestors.add(id);
				const childSurface = this.drawStack(layers, id, scale, depth + 1, nextAncestors);
				previous = this.drawIsolatedSurfaceStack(layer, effects, childSurface, scale, previous);
			} else if (layer.data) {
				if (effects.length) {
					previous = this.drawIsolatedStack(layer, effects, scale, previous);
				} else {
					const destination = previous === first ? second : first;
					this.drawLayer(layer, scale, previous, destination);
					previous = destination;
				}
			} else if (layer.kind === 'adjustment' && layer.adjustment) {
				const destination = previous === first ? second : first;
				this.drawAdjustment(layer, previous, destination, scale);
				previous = destination;
			}
			index = end;
		}
		return previous;
	}

	private drawIsolatedSurfaceStack(base: Layer, effects: Layer[], source: number, scale: number, main: number): number {
		const scratchFirst = (this.outputTextures as WebGLTexture[]).length - 3;
		const scratchSecond = scratchFirst + 1;
		const scratchBase = scratchSecond + 1;
		let scratchPrevious = scratchFirst;
		let scratchDestination = scratchPrevious + 1;
		this.clearSurface(scratchPrevious); this.clearSurface(scratchDestination);
		this.drawSurfaceLayer((this.outputTextures as WebGLTexture[])[source], scratchPrevious, scratchDestination, 1, 'normal');
		scratchPrevious = scratchDestination;
		this.drawSurfaceLayer(
			(this.outputTextures as WebGLTexture[])[scratchPrevious],
			scratchFirst, scratchBase, 1, 'normal',
		);
		for (const effect of effects) {
			if (effect.visible === false || (effect.opacity ?? 1) <= 0) { continue; }
			scratchDestination = scratchPrevious === scratchFirst ? scratchSecond : scratchFirst;
			if (effect.kind === 'adjustment' && effect.adjustment) {
				this.drawAdjustment(effect, scratchPrevious, scratchDestination, scale);
			} else if (effect.data) {
				this.drawLayer(
					effect, scale, scratchPrevious, scratchDestination, {},
					(this.outputTextures as WebGLTexture[])[scratchBase],
				);
			} else { continue; }
			scratchPrevious = scratchDestination;
		}
		const groupOpacity = Math.max(0, Math.min(1, base.opacity ?? 1));
		if (groupOpacity < 1 || base.rasterMask) {
			scratchDestination = scratchPrevious === scratchFirst ? scratchSecond : scratchFirst;
			this.clearSurface(scratchDestination);
			this.clearSurface(scratchBase);
			this.drawSurfaceLayer(
				(this.outputTextures as WebGLTexture[])[scratchPrevious],
				scratchBase, scratchDestination, groupOpacity, 'normal', 0, 0, base, scale,
			);
			scratchPrevious = scratchDestination;
		}
		const destination = main % 2 === 0 ? main + 1 : main - 1;
		this.drawSurfaceLayer(
			(this.outputTextures as WebGLTexture[])[scratchPrevious],
			main, destination, 1, base.blendMode || 'normal',
			Math.round((base.offsetX || 0) * scale), Math.round((base.offsetY || 0) * scale),
		);
		return destination;
	}

	dispose(): void {
		const gl = this.gl;
		if (gl) {
			for (const texture of this.ownedTextures) { gl.deleteTexture(texture); }
			for (const surfaces of this.surfaceCache.values()) {
				for (const framebuffer of surfaces.framebuffers) { gl.deleteFramebuffer(framebuffer); }
			}
			for (const framebuffer of this.cachedFramebuffers) { gl.deleteFramebuffer(framebuffer); }
			if (this.blendProgram) { gl.deleteProgram(this.blendProgram); }
			if (this.adjustmentProgram) { gl.deleteProgram(this.adjustmentProgram); }
			if (this.displayProgram) { gl.deleteProgram(this.displayProgram); }
			if (this.reductionProgram) { gl.deleteProgram(this.reductionProgram); }
			if (this.vao) { gl.deleteVertexArray(this.vao); }
		}
		this.canvas = null;
		this.gl = null;
		this.blendProgram = null;
		this.adjustmentProgram = null;
		this.displayProgram = null;
		this.reductionProgram = null;
		this.vao = null;
		this.outputTextures = null;
		this.framebuffers = null;
		this.surfaceCache.clear();
		this.isolatedStackCache = new WeakMap();
		this.cachedFramebuffers.clear();
		this.objectIds = new WeakMap();
		this.nextObjectId = 1;
		this.outputWidth = 0;
		this.outputHeight = 0;
		this.outputUsesFloat = false;
		this.compositionTypeMax = 1;
		this.textureCache.clear();
		this.adjustmentLutCache.clear();
		this.ownedTextures.clear();
		this.dummyFloat = null;
		this.dummyUint = null;
		this.dummyInt = null;
		this.colormapTexture = null;
		this.colormapName = 'none';
		this.reductionTextures = [];
		this.reductionFramebuffers = [];
		this.reductionSize = '';
	}

	private isSupportedPixels(data: ArrayLike<number>): data is SupportedPixels {
		return data instanceof Uint8Array || data instanceof Uint8ClampedArray ||
			data instanceof Uint16Array || data instanceof Uint32Array ||
			data instanceof Int8Array || data instanceof Int16Array ||
			data instanceof Int32Array || data instanceof Float32Array || data instanceof Float64Array;
	}

	private isSupportedAdjustment(adjustment: LayerAdjustment): boolean {
		return !!adjustment;
	}

	private ensureContext(width: number, height: number): boolean {
		if (this.gl && this.canvas && this.blendProgram && this.adjustmentProgram && this.displayProgram && this.reductionProgram && this.vao) {
			if (this.canvas.width !== width) { this.canvas.width = width; }
			if (this.canvas.height !== height) { this.canvas.height = height; }
			return true;
		}
		const canvas = document.createElement('canvas');
		canvas.width = width; canvas.height = height;
		const gl = canvas.getContext('webgl2', {
			alpha: true,
			antialias: false,
			depth: false,
			stencil: false,
			preserveDrawingBuffer: true,
			premultipliedAlpha: false,
		});
		if (!gl || !gl.getExtension('EXT_color_buffer_float')) {
			this.failed = true;
			return false;
		}
		const blendProgram = this.createProgram(gl, BLEND_FRAGMENT_SHADER);
		const adjustmentProgram = this.createProgram(gl, ADJUSTMENT_FRAGMENT_SHADER);
		const displayProgram = this.createProgram(gl, DISPLAY_FRAGMENT_SHADER);
		const reductionProgram = this.createProgram(gl, REDUCTION_FRAGMENT_SHADER);
		const vao = gl.createVertexArray();
		const vertexBuffer = gl.createBuffer();
		if (!blendProgram || !adjustmentProgram || !displayProgram || !reductionProgram || !vao || !vertexBuffer) {
			this.failed = true;
			return false;
		}
		gl.bindVertexArray(vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
		const location = gl.getAttribLocation(blendProgram, 'a_position');
		gl.enableVertexAttribArray(location);
		gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
		const displayLocation = gl.getAttribLocation(displayProgram, 'a_position');
		gl.enableVertexAttribArray(displayLocation);
		gl.vertexAttribPointer(displayLocation, 2, gl.FLOAT, false, 0, 0);
		this.canvas = canvas;
		this.gl = gl;
		this.blendProgram = blendProgram;
		this.adjustmentProgram = adjustmentProgram;
		this.displayProgram = displayProgram;
		this.reductionProgram = reductionProgram;
		this.vao = vao;
		this.dummyFloat = this.createDummyTexture(gl, gl.R8, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
		this.dummyUint = this.createDummyTexture(gl, gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array([0]));
		this.dummyInt = this.createDummyTexture(gl, gl.R8I, gl.RED_INTEGER, gl.BYTE, new Int8Array([0]));
		return !!this.dummyFloat && !!this.dummyUint && !!this.dummyInt;
	}

	private createDummyTexture(gl: WebGL2RenderingContext, internal: number, format: number, type: number, data: ArrayBufferView): WebGLTexture | null {
		const texture = gl.createTexture();
		if (!texture) { return null; }
		this.ownedTextures.add(texture);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		this.configureTexture();
		gl.texImage2D(gl.TEXTURE_2D, 0, internal, 1, 1, 0, format, type, data);
		return texture;
	}

	private ensureOutputSurfaces(width: number, height: number, usesFloat: boolean, surfaceCount: number): void {
		if (this.outputTextures && this.framebuffers && this.outputWidth === width && this.outputHeight === height
			&& this.outputUsesFloat === usesFloat && this.outputTextures.length === surfaceCount) { return; }
		const gl = this.gl as WebGL2RenderingContext;
		const key = `${width}x${height}:${usesFloat ? 'float' : 'byte'}:${surfaceCount}`;
		const cached = this.surfaceCache.get(key);
		if (cached) {
			this.outputTextures = cached.textures;
			this.framebuffers = cached.framebuffers;
			this.outputWidth = width;
			this.outputHeight = height;
			this.outputUsesFloat = usesFloat;
			return;
		}
		const textures: WebGLTexture[] = [], framebuffers: WebGLFramebuffer[] = [];
		for (let index = 0; index < surfaceCount; index++) {
			const texture = gl.createTexture(), framebuffer = gl.createFramebuffer();
			if (!texture || !framebuffer) { throw new Error('Could not allocate GPU composite surface'); }
			this.ownedTextures.add(texture);
			gl.bindTexture(gl.TEXTURE_2D, texture);
			this.configureTexture();
			gl.texImage2D(
				gl.TEXTURE_2D,
				0,
				usesFloat ? gl.RGBA16F : gl.RGBA8,
				width,
				height,
				0,
				gl.RGBA,
				usesFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
				null,
			);
			gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
			gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
			if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
				throw new Error('Float composite framebuffer is incomplete');
			}
			textures.push(texture); framebuffers.push(framebuffer);
		}
		this.outputTextures = textures;
		this.framebuffers = framebuffers;
		this.surfaceCache.set(key, { textures, framebuffers });
		this.outputWidth = width; this.outputHeight = height;
		this.outputUsesFloat = usesFloat;
	}

	private clearOutputSurfaces(): void {
		const gl = this.gl as WebGL2RenderingContext;
		gl.clearColor(0, 0, 0, 0);
		for (const framebuffer of this.framebuffers as WebGLFramebuffer[]) {
			gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
			gl.clear(gl.COLOR_BUFFER_BIT);
		}
	}

	private textureFor(data: SupportedPixels, width: number, height: number, channels: number): TextureEntry {
		const cached = this.textureCache.get(data as object);
		if (cached && cached.width === width && cached.height === height && cached.channels === channels) { return cached; }
		const gl = this.gl as WebGL2RenderingContext;
		if (cached) {
			gl.deleteTexture(cached.texture);
			this.ownedTextures.delete(cached.texture);
		}
		const texture = gl.createTexture();
		if (!texture) { throw new Error('Could not allocate layer texture'); }
		this.ownedTextures.add(texture);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		this.configureTexture();
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		const formats: number[] = [gl.RED, gl.RG, gl.RGB, gl.RGBA];
		let internal: number, format: number = formats[channels - 1], type: number;
		let encoding: 0 | 1 | 2, nativeMaximum: number;
		if (data instanceof Float32Array || data instanceof Float64Array) {
			internal = [gl.R32F, gl.RG32F, gl.RGB32F, gl.RGBA32F][channels - 1];
			type = gl.FLOAT; encoding = 0; nativeMaximum = 1;
		} else if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
			internal = [gl.R8, gl.RG8, gl.RGB8, gl.RGBA8][channels - 1];
			type = gl.UNSIGNED_BYTE; encoding = 0; nativeMaximum = 255;
		} else if (data instanceof Uint16Array || data instanceof Uint32Array) {
			internal = data instanceof Uint16Array
				? [gl.R16UI, gl.RG16UI, gl.RGB16UI, gl.RGBA16UI][channels - 1]
				: [gl.R32UI, gl.RG32UI, gl.RGB32UI, gl.RGBA32UI][channels - 1];
			format = [gl.RED_INTEGER, gl.RG_INTEGER, gl.RGB_INTEGER, gl.RGBA_INTEGER][channels - 1];
			type = data instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
			encoding = 1; nativeMaximum = data instanceof Uint16Array ? 65535 : 4294967295;
		} else {
			const sixteen = data instanceof Int16Array, thirtyTwo = data instanceof Int32Array;
			internal = sixteen
				? [gl.R16I, gl.RG16I, gl.RGB16I, gl.RGBA16I][channels - 1]
				: thirtyTwo
					? [gl.R32I, gl.RG32I, gl.RGB32I, gl.RGBA32I][channels - 1]
					: [gl.R8I, gl.RG8I, gl.RGB8I, gl.RGBA8I][channels - 1];
			format = [gl.RED_INTEGER, gl.RG_INTEGER, gl.RGB_INTEGER, gl.RGBA_INTEGER][channels - 1];
			type = sixteen ? gl.SHORT : thirtyTwo ? gl.INT : gl.BYTE;
			encoding = 2; nativeMaximum = 1;
		}
		const upload = data instanceof Float64Array ? Float32Array.from(data) : data;
		gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, upload as any);
		const error = gl.getError();
		if (error !== gl.NO_ERROR) { throw new Error(`Layer texture upload failed (${error})`); }
		const entry = { texture, width, height, channels, encoding, nativeMaximum };
		this.textureCache.set(data as object, entry);
		return entry;
	}

	private pruneTextureCache(retained: Set<object>): void {
		const gl = this.gl as WebGL2RenderingContext;
		for (const [data, entry] of this.textureCache) {
			if (retained.has(data)) { continue; }
			gl.deleteTexture(entry.texture);
			this.ownedTextures.delete(entry.texture);
			this.textureCache.delete(data);
		}
	}

	private configureTexture(): void {
		const gl = this.gl as WebGL2RenderingContext;
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	}

	private clearSurface(index: number): void {
		const gl = this.gl as WebGL2RenderingContext;
		gl.bindFramebuffer(gl.FRAMEBUFFER, (this.framebuffers as WebGLFramebuffer[])[index]);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
	}

	private drawIsolatedStack(base: Layer, effects: Layer[], scale: number, main: number): number {
		const signature = this.isolatedStackSignature(base, effects, scale);
		const cacheKey = `${this.outputWidth}x${this.outputHeight}:${this.outputUsesFloat ? 'float' : 'byte'}`;
		const cached = this.isolatedStackCache.get(base as object)?.get(cacheKey);
		if (cached?.signature === signature) {
			const destination = main % 2 === 0 ? main + 1 : main - 1;
			this.drawSurfaceLayer(cached.texture, main, destination, base.opacity ?? 1, base.blendMode || 'normal');
			return destination;
		}
		const scratchFirst = (this.outputTextures as WebGLTexture[]).length - 3;
		const scratchSecond = scratchFirst + 1;
		const scratchBase = scratchSecond + 1;
		let scratchPrevious = scratchFirst;
		let scratchDestination = scratchPrevious + 1;
		this.clearSurface(scratchPrevious);
		this.clearSurface(scratchDestination);
		this.clearSurface(scratchBase);
		this.drawLayer(base, scale, scratchPrevious, scratchDestination, { opacity: 1, blendMode: 'normal' });
		scratchPrevious = scratchDestination;
		this.drawSurfaceLayer(
			(this.outputTextures as WebGLTexture[])[scratchPrevious],
			scratchFirst, scratchBase, 1, 'normal',
		);
		for (const effect of effects) {
			if (effect.visible === false || (effect.opacity ?? 1) <= 0) { continue; }
			scratchDestination = scratchPrevious === scratchFirst ? scratchSecond : scratchFirst;
			if (effect.kind === 'adjustment' && effect.adjustment) {
				this.drawAdjustment(effect, scratchPrevious, scratchDestination, scale);
			} else if (effect.data) {
				this.drawLayer(
					effect, scale, scratchPrevious, scratchDestination, {},
					(this.outputTextures as WebGLTexture[])[scratchBase],
				);
			} else { continue; }
			scratchPrevious = scratchDestination;
		}
		const retained = this.retainIsolatedStack(base, cacheKey, signature, scratchPrevious);
		const destination = main % 2 === 0 ? main + 1 : main - 1;
		this.drawSurfaceLayer(
			retained,
			main,
			destination,
			base.opacity ?? 1,
			base.blendMode || 'normal',
		);
		return destination;
	}

	private objectId(value: object | undefined): number {
		if (!value) { return 0; }
		let id = this.objectIds.get(value);
		if (!id) { id = this.nextObjectId++; this.objectIds.set(value, id); }
		return id;
	}

	private isolatedStackSignature(base: Layer, effects: Layer[], scale: number): string {
		const describe = (layer: Layer, includePlacement: boolean) => ({
			kind: layer.kind, data: this.objectId(layer.data as object | undefined),
			adjustment: layer.adjustment || null,
			width: layer.width, height: layer.height, channels: layer.channels, typeMax: layer.typeMax,
			offsetX: includePlacement ? Math.round((layer.offsetX || 0) * scale) : 0,
			offsetY: includePlacement ? Math.round((layer.offsetY || 0) * scale) : 0,
			opacity: layer.opacity ?? 1, blendMode: layer.blendMode || 'normal',
			visible: layer.visible !== false, clipped: !!layer.clipped,
			mask: layer.rasterMask ? {
				data: this.objectId(layer.rasterMask.data as object),
				width: layer.rasterMask.width, height: layer.rasterMask.height,
				channels: layer.rasterMask.channels, typeMax: layer.rasterMask.typeMax,
				offsetX: layer.rasterMask.offsetX, offsetY: layer.rasterMask.offsetY,
				invert: layer.rasterMask.invert,
			} : null,
		});
		const baseDescription = describe(base, true);
		// Base opacity/blend are applied only when the retained surface is placed
		// into its parent stack, so those UI edits can reuse the cached filters.
		baseDescription.opacity = 1;
		baseDescription.blendMode = 'normal';
		return JSON.stringify([baseDescription, ...effects.map(effect => describe(effect, true))]);
	}

	private retainIsolatedStack(base: Layer, key: string, signature: string, sourceSurface: number): WebGLTexture {
		const gl = this.gl as WebGL2RenderingContext;
		let bySize = this.isolatedStackCache.get(base as object);
		if (!bySize) { bySize = new Map(); this.isolatedStackCache.set(base as object, bySize); }
		let entry = bySize.get(key);
		if (!entry) {
			const texture = gl.createTexture(), framebuffer = gl.createFramebuffer();
			if (!texture || !framebuffer) { throw new Error('Could not allocate retained GPU layer surface'); }
			this.ownedTextures.add(texture); this.cachedFramebuffers.add(framebuffer);
			gl.bindTexture(gl.TEXTURE_2D, texture); this.configureTexture();
			gl.texImage2D(
				gl.TEXTURE_2D, 0, this.outputUsesFloat ? gl.RGBA16F : gl.RGBA8,
				this.outputWidth, this.outputHeight, 0, gl.RGBA,
				this.outputUsesFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null,
			);
			gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
			gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
			if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
				throw new Error('Retained GPU layer framebuffer is incomplete');
			}
			entry = {
				signature: '', texture, framebuffer,
				width: this.outputWidth, height: this.outputHeight, usesFloat: this.outputUsesFloat,
			};
			bySize.set(key, entry);
		}
		gl.bindFramebuffer(gl.FRAMEBUFFER, (this.framebuffers as WebGLFramebuffer[])[sourceSurface]);
		gl.bindTexture(gl.TEXTURE_2D, entry.texture);
		gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, this.outputWidth, this.outputHeight);
		const error = gl.getError();
		if (error !== gl.NO_ERROR) { throw new Error(`Could not retain GPU layer surface (${error})`); }
		entry.signature = signature;
		return entry.texture;
	}

	private drawLayer(
		layer: Layer,
		scale: number,
		previous: number,
		destination: number,
		overrides: { opacity?: number; blendMode?: string } = {},
		clipTexture?: WebGLTexture,
	): void {
		const gl = this.gl as WebGL2RenderingContext;
		const program = this.blendProgram as WebGLProgram;
		const source = this.textureFor(layer.data as SupportedPixels, layer.width, layer.height, layer.channels);
		const mask = layer.rasterMask && this.isSupportedPixels(layer.rasterMask.data)
			? this.textureFor(layer.rasterMask.data, layer.rasterMask.width, layer.rasterMask.height, Math.max(1, layer.rasterMask.channels ?? 1))
			: null;
		gl.bindFramebuffer(gl.FRAMEBUFFER, (this.framebuffers as WebGLFramebuffer[])[destination]);
		gl.viewport(0, 0, this.outputWidth, this.outputHeight);
		gl.useProgram(program);
		gl.bindVertexArray(this.vao);
		this.bindTexture(program, 'u_previous', 0, (this.outputTextures as WebGLTexture[])[previous]);
		this.bindTexture(program, 'u_sourceFloat', 1, source.encoding === 0 ? source.texture : this.dummyFloat as WebGLTexture);
		this.bindTexture(program, 'u_sourceUint', 2, source.encoding === 1 ? source.texture : this.dummyUint as WebGLTexture);
		this.bindTexture(program, 'u_sourceInt', 3, source.encoding === 2 ? source.texture : this.dummyInt as WebGLTexture);
		this.bindTexture(program, 'u_maskFloat', 4, mask?.encoding === 0 ? mask.texture : this.dummyFloat as WebGLTexture);
		this.bindTexture(program, 'u_maskUint', 5, mask?.encoding === 1 ? mask.texture : this.dummyUint as WebGLTexture);
		this.bindTexture(program, 'u_maskInt', 6, mask?.encoding === 2 ? mask.texture : this.dummyInt as WebGLTexture);
		this.bindTexture(program, 'u_clipSurface', 7, clipTexture || this.dummyFloat as WebGLTexture);
		gl.uniform2i(gl.getUniformLocation(program, 'u_outputSize'), this.outputWidth, this.outputHeight);
		gl.uniform2i(gl.getUniformLocation(program, 'u_sourceSize'), layer.width, layer.height);
		gl.uniform2i(gl.getUniformLocation(program, 'u_layerOffset'), Math.round((layer.offsetX || 0) * scale), Math.round((layer.offsetY || 0) * scale));
		gl.uniform2i(gl.getUniformLocation(program, 'u_layerSize'), Math.max(1, Math.round(layer.width * scale)), Math.max(1, Math.round(layer.height * scale)));
		gl.uniform1i(gl.getUniformLocation(program, 'u_channels'), layer.channels);
		gl.uniform1i(gl.getUniformLocation(program, 'u_encoding'), source.encoding);
		gl.uniform1i(gl.getUniformLocation(program, 'u_sourceIsSurface'), 0);
		gl.uniform1i(gl.getUniformLocation(program, 'u_hasMask'), mask ? 1 : 0);
		gl.uniform1i(gl.getUniformLocation(program, 'u_maskEncoding'), mask?.encoding ?? 0);
		gl.uniform1i(gl.getUniformLocation(program, 'u_maskChannels'), Math.max(1, layer.rasterMask?.channels ?? 1));
		gl.uniform1i(gl.getUniformLocation(program, 'u_maskInvert'), layer.rasterMask?.invert ? 1 : 0);
		gl.uniform2i(gl.getUniformLocation(program, 'u_maskSourceSize'), layer.rasterMask?.width ?? 1, layer.rasterMask?.height ?? 1);
		gl.uniform2i(
			gl.getUniformLocation(program, 'u_maskOffset'),
			Math.round((layer.rasterMask?.offsetX ?? layer.offsetX ?? 0) * scale),
			Math.round((layer.rasterMask?.offsetY ?? layer.offsetY ?? 0) * scale),
		);
		gl.uniform2i(
			gl.getUniformLocation(program, 'u_maskLayerSize'),
			Math.max(1, Math.round((layer.rasterMask?.width ?? 1) * scale)),
			Math.max(1, Math.round((layer.rasterMask?.height ?? 1) * scale)),
		);
		const maskValueScale = mask
			? mask.encoding === 0 && mask.nativeMaximum > 1
				? mask.nativeMaximum / (layer.rasterMask?.typeMax || mask.nativeMaximum)
				: 1 / (layer.rasterMask?.typeMax || 1)
			: 1;
		gl.uniform1f(gl.getUniformLocation(program, 'u_maskValueScale'), maskValueScale);
		gl.uniform1i(gl.getUniformLocation(program, 'u_hasClip'), clipTexture ? 1 : 0);
		const arithmetic = ['add', 'subtract', 'raw-difference', 'raw-multiply', 'divide', 'min', 'max', 'average'].includes(overrides.blendMode ?? layer.blendMode ?? '');
		const valueMaximum = arithmetic ? this.compositionTypeMax : (layer.typeMax || 1);
		const valueScale = source.encoding === 0 && source.nativeMaximum > 1
			? source.nativeMaximum / valueMaximum
			: 1 / valueMaximum;
		gl.uniform1f(gl.getUniformLocation(program, 'u_valueScale'), valueScale);
		gl.uniform1f(gl.getUniformLocation(program, 'u_outputMaximum'), this.compositionTypeMax);
		gl.uniform1f(gl.getUniformLocation(program, 'u_opacity'), Math.max(0, Math.min(1, overrides.opacity ?? layer.opacity ?? 1)));
		gl.uniform1i(gl.getUniformLocation(program, 'u_blendMode'), GPU_BLEND_MODES.get(overrides.blendMode ?? layer.blendMode ?? 'normal') || 0);
		const maskCondition = layer.maskCondition;
		gl.uniform1i(gl.getUniformLocation(program, 'u_maskCondition'), ['gt', 'ge', 'lt', 'le', 'eq', 'isfinite', 'isnan'].indexOf(maskCondition?.op || '') + 1);
		gl.uniform1f(gl.getUniformLocation(program, 'u_maskThreshold'), (maskCondition?.threshold || 0) / (layer.typeMax || this.compositionTypeMax));
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	private drawSurfaceLayer(
		source: WebGLTexture, previous: number, destination: number, opacity: number, blendMode: string,
		offsetX = 0, offsetY = 0,
		maskOwner?: Layer,
		scale = 1,
	): void {
		const gl = this.gl as WebGL2RenderingContext;
		const program = this.blendProgram as WebGLProgram;
		const mask = maskOwner?.rasterMask && this.isSupportedPixels(maskOwner.rasterMask.data)
			? this.textureFor(
				maskOwner.rasterMask.data, maskOwner.rasterMask.width, maskOwner.rasterMask.height,
				Math.max(1, maskOwner.rasterMask.channels ?? 1),
			)
			: null;
		gl.bindFramebuffer(gl.FRAMEBUFFER, (this.framebuffers as WebGLFramebuffer[])[destination]);
		gl.viewport(0, 0, this.outputWidth, this.outputHeight);
		gl.useProgram(program);
		gl.bindVertexArray(this.vao);
		this.bindTexture(program, 'u_previous', 0, (this.outputTextures as WebGLTexture[])[previous]);
		this.bindTexture(program, 'u_sourceFloat', 1, source);
		this.bindTexture(program, 'u_sourceUint', 2, this.dummyUint as WebGLTexture);
		this.bindTexture(program, 'u_sourceInt', 3, this.dummyInt as WebGLTexture);
		this.bindTexture(program, 'u_maskFloat', 4, mask?.encoding === 0 ? mask.texture : this.dummyFloat as WebGLTexture);
		this.bindTexture(program, 'u_maskUint', 5, mask?.encoding === 1 ? mask.texture : this.dummyUint as WebGLTexture);
		this.bindTexture(program, 'u_maskInt', 6, mask?.encoding === 2 ? mask.texture : this.dummyInt as WebGLTexture);
		this.bindTexture(program, 'u_clipSurface', 7, this.dummyFloat as WebGLTexture);
		gl.uniform2i(gl.getUniformLocation(program, 'u_outputSize'), this.outputWidth, this.outputHeight);
		gl.uniform2i(gl.getUniformLocation(program, 'u_sourceSize'), this.outputWidth, this.outputHeight);
		gl.uniform2i(gl.getUniformLocation(program, 'u_layerOffset'), offsetX, offsetY);
		gl.uniform2i(gl.getUniformLocation(program, 'u_layerSize'), this.outputWidth, this.outputHeight);
		gl.uniform1i(gl.getUniformLocation(program, 'u_channels'), 4);
		gl.uniform1i(gl.getUniformLocation(program, 'u_encoding'), 0);
		gl.uniform1i(gl.getUniformLocation(program, 'u_sourceIsSurface'), 1);
		gl.uniform1i(gl.getUniformLocation(program, 'u_hasMask'), mask ? 1 : 0);
		gl.uniform1i(gl.getUniformLocation(program, 'u_maskEncoding'), mask?.encoding ?? 0);
		gl.uniform1i(gl.getUniformLocation(program, 'u_maskChannels'), Math.max(1, maskOwner?.rasterMask?.channels ?? 1));
		gl.uniform1i(gl.getUniformLocation(program, 'u_maskInvert'), maskOwner?.rasterMask?.invert ? 1 : 0);
		gl.uniform2i(gl.getUniformLocation(program, 'u_maskSourceSize'), maskOwner?.rasterMask?.width ?? 1, maskOwner?.rasterMask?.height ?? 1);
		gl.uniform2i(
			gl.getUniformLocation(program, 'u_maskOffset'),
			Math.round((maskOwner?.rasterMask?.offsetX ?? maskOwner?.offsetX ?? 0) * scale),
			Math.round((maskOwner?.rasterMask?.offsetY ?? maskOwner?.offsetY ?? 0) * scale),
		);
		gl.uniform2i(
			gl.getUniformLocation(program, 'u_maskLayerSize'),
			Math.max(1, Math.round((maskOwner?.rasterMask?.width ?? 1) * scale)),
			Math.max(1, Math.round((maskOwner?.rasterMask?.height ?? 1) * scale)),
		);
		const maskValueScale = mask
			? mask.encoding === 0 && mask.nativeMaximum > 1
				? mask.nativeMaximum / (maskOwner?.rasterMask?.typeMax || mask.nativeMaximum)
				: 1 / (maskOwner?.rasterMask?.typeMax || 1)
			: 1;
		gl.uniform1f(gl.getUniformLocation(program, 'u_maskValueScale'), maskValueScale);
		gl.uniform1i(gl.getUniformLocation(program, 'u_hasClip'), 0);
		gl.uniform1f(gl.getUniformLocation(program, 'u_valueScale'), 1);
		gl.uniform1f(gl.getUniformLocation(program, 'u_outputMaximum'), this.compositionTypeMax);
		gl.uniform1f(gl.getUniformLocation(program, 'u_opacity'), Math.max(0, Math.min(1, opacity)));
		gl.uniform1i(gl.getUniformLocation(program, 'u_blendMode'), GPU_BLEND_MODES.get(blendMode) || 0);
		gl.uniform1i(gl.getUniformLocation(program, 'u_maskCondition'), 0);
		gl.uniform1f(gl.getUniformLocation(program, 'u_maskThreshold'), 0);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	private drawAdjustment(layer: Layer, source: number, destination: number, scale: number): void {
		const adjustment = layer.adjustment as LayerAdjustment;
		const gl = this.gl as WebGL2RenderingContext;
		const program = this.adjustmentProgram as WebGLProgram;
		const mask = layer.rasterMask && this.isSupportedPixels(layer.rasterMask.data)
			? this.textureFor(layer.rasterMask.data, layer.rasterMask.width, layer.rasterMask.height, Math.max(1, layer.rasterMask.channels ?? 1))
			: null;
		gl.bindFramebuffer(gl.FRAMEBUFFER, (this.framebuffers as WebGLFramebuffer[])[destination]);
		gl.viewport(0, 0, this.outputWidth, this.outputHeight);
		gl.useProgram(program);
		gl.bindVertexArray(this.vao);
		this.bindTexture(program, 'u_source', 0, (this.outputTextures as WebGLTexture[])[source]);
		gl.uniform1f(gl.getUniformLocation(program, 'u_amount'), Math.max(0, Math.min(1, layer.opacity ?? 1)));
		this.bindTexture(program, 'u_adjustmentMaskFloat', 2, mask?.encoding === 0 ? mask.texture : this.dummyFloat as WebGLTexture);
		this.bindTexture(program, 'u_adjustmentMaskUint', 3, mask?.encoding === 1 ? mask.texture : this.dummyUint as WebGLTexture);
		this.bindTexture(program, 'u_adjustmentMaskInt', 4, mask?.encoding === 2 ? mask.texture : this.dummyInt as WebGLTexture);
		gl.uniform1i(gl.getUniformLocation(program, 'u_hasAdjustmentMask'), mask ? 1 : 0);
		gl.uniform1i(gl.getUniformLocation(program, 'u_adjustmentMaskEncoding'), mask?.encoding ?? 0);
		gl.uniform1i(gl.getUniformLocation(program, 'u_adjustmentMaskInvert'), layer.rasterMask?.invert ? 1 : 0);
		gl.uniform2i(gl.getUniformLocation(program, 'u_adjustmentOutputSize'), this.outputWidth, this.outputHeight);
		gl.uniform2i(gl.getUniformLocation(program, 'u_adjustmentMaskSourceSize'), layer.rasterMask?.width ?? 1, layer.rasterMask?.height ?? 1);
		gl.uniform2i(
			gl.getUniformLocation(program, 'u_adjustmentMaskOffset'),
			Math.round((layer.rasterMask?.offsetX ?? layer.offsetX ?? 0) * scale),
			Math.round((layer.rasterMask?.offsetY ?? layer.offsetY ?? 0) * scale),
		);
		gl.uniform2i(
			gl.getUniformLocation(program, 'u_adjustmentMaskLayerSize'),
			Math.max(1, Math.round((layer.rasterMask?.width ?? 1) * scale)),
			Math.max(1, Math.round((layer.rasterMask?.height ?? 1) * scale)),
		);
		const maskValueScale = mask
			? mask.encoding === 0 && mask.nativeMaximum > 1
				? mask.nativeMaximum / (layer.rasterMask?.typeMax || mask.nativeMaximum)
				: 1 / (layer.rasterMask?.typeMax || 1)
			: 1;
		gl.uniform1f(gl.getUniformLocation(program, 'u_adjustmentMaskValueScale'), maskValueScale);
		const parameters = new Float32Array(45);
		gl.uniform1iv(gl.getUniformLocation(program, 'u_flags'), new Int32Array(8));
		if (adjustment.type === 'levels' || adjustment.type === 'curves') {
			const lut = this.createAdjustmentLut(adjustment);
			// LUT creation binds its new texture on the currently active unit.
			// Restore every typed sampler binding before issuing the draw;
			// WebGL rejects a program if an integer sampler is left pointing at
			// the normalized LUT texture, even when the mask branch is disabled.
			this.bindTexture(program, 'u_source', 0, (this.outputTextures as WebGLTexture[])[source]);
			this.bindTexture(program, 'u_lut', 1, lut);
			this.bindTexture(program, 'u_adjustmentMaskFloat', 2, mask?.encoding === 0 ? mask.texture : this.dummyFloat as WebGLTexture);
			this.bindTexture(program, 'u_adjustmentMaskUint', 3, mask?.encoding === 1 ? mask.texture : this.dummyUint as WebGLTexture);
			this.bindTexture(program, 'u_adjustmentMaskInt', 4, mask?.encoding === 2 ? mask.texture : this.dummyInt as WebGLTexture);
			gl.uniform1i(gl.getUniformLocation(program, 'u_type'), 0);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
			return;
		}
		let type = 1;
		const flags = new Int32Array(8);
		if (adjustment.type === 'hue/saturation') {
			const colorize = !!adjustment.colorize && adjustment.colorizeEnabled !== false;
			flags[0] = colorize ? 1 : 0;
			if (colorize) {
				parameters.set([
					adjustment.colorize!.hue || 0,
					(adjustment.colorize!.saturation || 0) / 100,
					(adjustment.colorize!.lightness || 0) / 100,
				]);
			} else {
				const master = adjustment.master || {};
				parameters.set([master.hue || 0, master.saturation || 0, master.lightness || 0]);
				for (let range = 0; range < 6; range++) {
					const settings = adjustment[(['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const)[range]];
					const base = 3 + range * 7;
					const configured = !!settings && ['a', 'b', 'c', 'd'].every(key => Number.isFinite(settings[key]));
					flags[range + 1] = configured ? 1 : 0;
					parameters.set([
						settings?.a || 0, settings?.b || 0, settings?.c || 0, settings?.d || 0,
						settings?.hue || 0, settings?.saturation || 0, settings?.lightness || 0,
					], base);
				}
			}
		} else if (adjustment.type === 'brightness/contrast') {
			type = 2; parameters.set([adjustment.brightness || 0, adjustment.contrast || 0]);
		} else if (adjustment.type === 'exposure') {
			type = 3; parameters.set([adjustment.exposure || 0, adjustment.offset || 0, adjustment.gamma ?? 1]);
		} else if (adjustment.type === 'invert') {
			type = 4;
		} else if (adjustment.type === 'channel mixer') {
			type = 5; flags[0] = adjustment.monochrome ? 1 : 0;
			const values = (channel: any, fallback: Record<string, number>) => {
				const value = channel || fallback;
				return [value.red ?? 0, value.green ?? 0, value.blue ?? 0, value.constant ?? 0];
			};
			parameters.set([
				...values(adjustment.red, { red: 100 }), ...values(adjustment.green, { green: 100 }),
				...values(adjustment.blue, { blue: 100 }), ...values(adjustment.gray, { red: 40, green: 40, blue: 20 }),
			]);
		} else if (adjustment.type === 'color balance') {
			type = 6; flags[0] = adjustment.preserveLuminosity ? 1 : 0;
			const values = (range: any) => [range?.cyanRed || 0, range?.magentaGreen || 0, range?.yellowBlue || 0];
			parameters.set([...values(adjustment.shadows), ...values(adjustment.midtones), ...values(adjustment.highlights)]);
		} else if (adjustment.type === 'black & white') {
			type = 7; parameters.set([
				adjustment.reds ?? 40, adjustment.yellows ?? 60, adjustment.greens ?? 40,
				adjustment.cyans ?? 60, adjustment.blues ?? 20, adjustment.magentas ?? 80,
			]);
		} else if (adjustment.type === 'threshold') {
			type = 8; parameters[0] = adjustment.level ?? 128;
		} else if (adjustment.type === 'posterize') {
			type = 9; parameters[0] = adjustment.levels ?? 4;
		} else if (adjustment.type === 'gradient map') {
			type = 10;
			const lut = this.createAdjustmentLut(adjustment);
			this.bindTexture(program, 'u_source', 0, (this.outputTextures as WebGLTexture[])[source]);
			this.bindTexture(program, 'u_lut', 1, lut);
			this.bindTexture(program, 'u_adjustmentMaskFloat', 2, mask?.encoding === 0 ? mask.texture : this.dummyFloat as WebGLTexture);
			this.bindTexture(program, 'u_adjustmentMaskUint', 3, mask?.encoding === 1 ? mask.texture : this.dummyUint as WebGLTexture);
			this.bindTexture(program, 'u_adjustmentMaskInt', 4, mask?.encoding === 2 ? mask.texture : this.dummyInt as WebGLTexture);
		}
		gl.uniform1i(gl.getUniformLocation(program, 'u_type'), type);
		gl.uniform1fv(gl.getUniformLocation(program, 'u_parameters'), parameters);
		gl.uniform1iv(gl.getUniformLocation(program, 'u_flags'), flags);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	private createAdjustmentLut(adjustment: Extract<LayerAdjustment, { type: 'levels' | 'curves' | 'gradient map' }>): WebGLTexture {
		const gl = this.gl as WebGL2RenderingContext;
		const cached = this.adjustmentLutCache.get(adjustment as object);
		if (cached) { return cached; }
		const data = new Uint8Array(256 * 4);
		for (let input = 0; input < 256; input++) {
			if (adjustment.type === 'gradient map') {
				const defaults = [{ position: 0, color: { r: 0, g: 0, b: 0 } }, { position: 1, color: { r: 255, g: 255, b: 255 } }];
				const stops = (adjustment.stops?.length ? adjustment.stops : defaults)
					.map(stop => ({ ...stop, position: Math.max(0, Math.min(1, stop.position)) }))
					.sort((a, b) => a.position - b.position);
				const position = adjustment.reverse ? 1 - input / 255 : input / 255;
				let low = stops[0], high = stops[0], amount = 0;
				if (position >= stops[stops.length - 1].position) { low = high = stops[stops.length - 1]; }
				else if (position > stops[0].position) for (let index = 1; index < stops.length; index++) if (position <= stops[index].position) {
					low = stops[index - 1]; high = stops[index];
					amount = (position - low.position) / Math.max(1e-6, high.position - low.position);
					break;
				}
				for (let channel = 0; channel < 3; channel++) {
					const name = ['r', 'g', 'b'][channel] as 'r' | 'g' | 'b';
					data[input * 4 + channel] = Math.max(0, Math.min(255, Math.round(low.color[name] + (high.color[name] - low.color[name]) * amount)));
				}
			} else {
				for (let channel = 0; channel < 3; channel++) {
					const name = ['red', 'green', 'blue'][channel] as 'red' | 'green' | 'blue';
					data[input * 4 + channel] = Math.max(0, Math.min(255, Math.round(this.adjustmentCurve(
						this.adjustmentCurve(input, adjustment.rgb),
						adjustment[name],
					))));
				}
			}
			data[input * 4 + 3] = 255;
		}
		const texture = gl.createTexture();
		if (!texture) { throw new Error('Could not create adjustment LUT'); }
		this.ownedTextures.add(texture);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		this.configureTexture();
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
		this.adjustmentLutCache.set(adjustment as object, texture);
		return texture;
	}

	private pruneAdjustmentLutCache(retained: Set<object>): void {
		const gl = this.gl as WebGL2RenderingContext;
		for (const [adjustment, texture] of this.adjustmentLutCache) {
			if (retained.has(adjustment)) { continue; }
			gl.deleteTexture(texture);
			this.ownedTextures.delete(texture);
			this.adjustmentLutCache.delete(adjustment);
		}
	}

	private adjustmentCurve(value: number, channel: AdjustmentChannel | undefined): number {
		if (!channel) { return value; }
		if (Array.isArray(channel)) { return evaluateCurvePoints(channel, value); }
		const low = channel.shadowInput ?? 0, high = channel.highlightInput ?? 255;
		const gamma = Math.max(0.01, channel.midtoneInput ?? 1);
		const normalized = Math.max(0, Math.min(1, (value - low) / Math.max(1e-6, high - low)));
		const outputLow = channel.shadowOutput ?? 0, outputHigh = channel.highlightOutput ?? 255;
		return outputLow + Math.pow(normalized, 1 / gamma) * (outputHigh - outputLow);
	}

	private validateNativeSamples(layers: Layer[], width: number, height: number, surface: number): void {
		const gl = this.gl as WebGL2RenderingContext;
		const coordinates = [
			[0, 0], [Math.floor(width / 2), 0], [width - 1, 0],
			[0, Math.floor(height / 2)], [Math.floor(width / 2), Math.floor(height / 2)], [width - 1, Math.floor(height / 2)],
			[0, height - 1], [Math.floor(width / 2), height - 1], [width - 1, height - 1],
		];
		gl.bindFramebuffer(gl.FRAMEBUFFER, (this.framebuffers as WebGLFramebuffer[])[surface]);
		for (const [x, y] of coordinates) {
			const gpu = this.outputUsesFloat ? new Float32Array(4) : new Uint8Array(4);
			gl.readPixels(x, height - 1 - y, 1, 1, gl.RGBA, this.outputUsesFloat ? gl.FLOAT : gl.UNSIGNED_BYTE, gpu);
			const error = gl.getError();
			if (error !== gl.NO_ERROR) { throw new Error(`GPU validation read failed (${error})`); }
			const exact = compositeRegion(layers, width, height, { x, y, width: 1, height: 1 });
			const maximum = exact.typeMax || 1;
			const expected = exact.coveredCount <= 0
				? [0, 0, 0, 0]
				: exact.channels === 1
					? [exact.data[0] / maximum, exact.data[0] / maximum, exact.data[0] / maximum, 1]
					: exact.channels === 3
						? [exact.data[0] / maximum, exact.data[1] / maximum, exact.data[2] / maximum, 1]
						: [exact.data[0] / maximum, exact.data[1] / maximum, exact.data[2] / maximum, exact.data[3] / maximum];
			for (let channel = 0; channel < 4; channel++) {
				const actual = Number(gpu[channel]) / (this.outputUsesFloat ? 1 : 255);
				const wanted = expected[channel];
				const bothInvalid = !Number.isFinite(actual) && !Number.isFinite(wanted);
				if (!bothInvalid && (!Number.isFinite(actual) || !Number.isFinite(wanted) || Math.abs(actual - wanted) > (this.outputUsesFloat ? 0.004 : 3 / 255))) {
					throw new Error(`GPU parity mismatch at ${x},${y} channel ${channel}: ${actual} != ${wanted}`);
				}
			}
		}
	}

	private uploadColormap(name: string): void {
		if (!name || name === 'none') { this.colormapName = 'none'; return; }
		if (this.colormapName === name && this.colormapTexture) { return; }
		const lut = getColormapLut(name);
		if (!lut) { this.colormapName = 'none'; return; }
		const gl = this.gl as WebGL2RenderingContext;
		if (!this.colormapTexture) {
			this.colormapTexture = gl.createTexture();
			if (!this.colormapTexture) { throw new Error('Could not allocate display colormap texture'); }
			this.ownedTextures.add(this.colormapTexture);
		}
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.colormapTexture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 256, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, lut);
		this.colormapName = name;
	}

	private ensureReductionSurfaces(width: number, height: number): void {
		const key = `${width}x${height}`;
		if (this.reductionSize === key) { return; }
		const gl = this.gl as WebGL2RenderingContext;
		for (const texture of this.reductionTextures) {
			gl.deleteTexture(texture); this.ownedTextures.delete(texture);
		}
		for (const framebuffer of this.reductionFramebuffers) {
			gl.deleteFramebuffer(framebuffer); this.cachedFramebuffers.delete(framebuffer);
		}
		this.reductionTextures = []; this.reductionFramebuffers = [];
		let currentWidth = width, currentHeight = height;
		while (currentWidth > 1 || currentHeight > 1) {
			currentWidth = Math.max(1, Math.ceil(currentWidth / 2));
			currentHeight = Math.max(1, Math.ceil(currentHeight / 2));
			const texture = gl.createTexture(), framebuffer = gl.createFramebuffer();
			if (!texture || !framebuffer) { throw new Error('Could not allocate auto-normalization reduction surface'); }
			this.ownedTextures.add(texture); this.cachedFramebuffers.add(framebuffer);
			gl.bindTexture(gl.TEXTURE_2D, texture); this.configureTexture();
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, currentWidth, currentHeight, 0, gl.RG, gl.FLOAT, null);
			gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
			gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
			if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
				throw new Error('Auto-normalization reduction framebuffer is incomplete');
			}
			this.reductionTextures.push(texture); this.reductionFramebuffers.push(framebuffer);
		}
		this.reductionSize = key;
	}

	private autoNormalizationRange(surface: number): [number, number] {
		this.ensureReductionSurfaces(this.outputWidth, this.outputHeight);
		if (!this.reductionTextures.length) {
			const gl = this.gl as WebGL2RenderingContext;
			gl.bindFramebuffer(gl.FRAMEBUFFER, (this.framebuffers as WebGLFramebuffer[])[surface]);
			const value = this.outputUsesFloat ? new Float32Array(4) : new Uint8Array(4);
			gl.readPixels(0, 0, 1, 1, gl.RGBA, this.outputUsesFloat ? gl.FLOAT : gl.UNSIGNED_BYTE, value);
			const divisor = this.outputUsesFloat ? 1 : 255;
			const finite = Array.from(value.slice(0, 3), sample => sample / divisor).filter(Number.isFinite);
			return finite.length ? [Math.min(...finite), Math.max(...finite)] : [0, 1];
		}
		const gl = this.gl as WebGL2RenderingContext;
		const program = this.reductionProgram as WebGLProgram;
		let source = (this.outputTextures as WebGLTexture[])[surface];
		let sourceWidth = this.outputWidth, sourceHeight = this.outputHeight;
		for (let level = 0; level < this.reductionTextures.length; level++) {
			const width = Math.max(1, Math.ceil(sourceWidth / 2));
			const height = Math.max(1, Math.ceil(sourceHeight / 2));
			gl.bindFramebuffer(gl.FRAMEBUFFER, this.reductionFramebuffers[level]);
			gl.viewport(0, 0, width, height);
			gl.useProgram(program); gl.bindVertexArray(this.vao);
			this.bindTexture(program, 'u_reduceSource', 0, source);
			gl.uniform2i(gl.getUniformLocation(program, 'u_reduceSourceSize'), sourceWidth, sourceHeight);
			gl.uniform1i(gl.getUniformLocation(program, 'u_reduceFirstPass'), level === 0 ? 1 : 0);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
			source = this.reductionTextures[level];
			sourceWidth = width; sourceHeight = height;
		}
		const range = new Float32Array(2);
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.reductionFramebuffers[this.reductionFramebuffers.length - 1]);
		gl.readPixels(0, 0, 1, 1, gl.RG, gl.FLOAT, range);
		if (!Number.isFinite(range[0]) || !Number.isFinite(range[1]) || range[1] < range[0]) { return [0, 1]; }
		return [range[0], range[1]];
	}

	private drawDisplay(surface: number, settings: ImageSettings, layers: Layer[], nanColor: { r: number; g: number; b: number }): void {
		const gl = this.gl as WebGL2RenderingContext;
		const program = this.displayProgram as WebGLProgram;
		const outputTypeMax = layers.find(layer => layer.visible !== false && (layer.opacity ?? 1) > 0 && layer.data)?.typeMax || 1;
		let min = settings.normalization?.gammaMode ? 0 : (settings.normalization?.min ?? 0) / outputTypeMax;
		let max = settings.normalization?.gammaMode ? 1 : (settings.normalization?.max ?? outputTypeMax) / outputTypeMax;
		if (settings.normalization?.autoNormalize) { [min, max] = this.autoNormalizationRange(surface); }
		const colormapName = settings.displayColormap || 'none';
		this.uploadColormap(colormapName);
		const rgb24 = settings.rgbAs24BitGrayscale === true &&
			layers.some(layer => layer.visible !== false && (layer.opacity ?? 1) > 0 && !!layer.data && layer.channels >= 3);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, this.outputWidth, this.outputHeight);
		gl.useProgram(program);
		gl.bindVertexArray(this.vao);
		this.bindTexture(program, 'u_composite', 0, (this.outputTextures as WebGLTexture[])[surface]);
		this.bindTexture(program, 'u_displayColormap', 1, this.colormapTexture || this.dummyFloat as WebGLTexture);
		gl.uniform2i(gl.getUniformLocation(program, 'u_outputSize'), this.outputWidth, this.outputHeight);
		gl.uniform1f(gl.getUniformLocation(program, 'u_min'), min);
		gl.uniform1f(gl.getUniformLocation(program, 'u_inverseRange'), max > min ? 1 / (max - min) : 0);
		gl.uniform1f(gl.getUniformLocation(program, 'u_gammaIn'), settings.gamma?.in ?? 1);
		gl.uniform1f(gl.getUniformLocation(program, 'u_gammaOut'), settings.gamma?.out ?? 1);
		gl.uniform1f(gl.getUniformLocation(program, 'u_exposure'), settings.brightness?.offset ?? 0);
		gl.uniform3f(gl.getUniformLocation(program, 'u_nanColor'), nanColor.r / 255, nanColor.g / 255, nanColor.b / 255);
		gl.uniform1i(gl.getUniformLocation(program, 'u_useDisplayColormap'), this.colormapName !== 'none' && !!this.colormapTexture ? 1 : 0);
		gl.uniform1i(gl.getUniformLocation(program, 'u_rgb24'), rgb24 ? 1 : 0);
		gl.uniform1f(gl.getUniformLocation(program, 'u_rgb24Maximum'), outputTypeMax);
		gl.uniform1f(gl.getUniformLocation(program, 'u_rgb24Divisor'), outputTypeMax > 255 ? 257 : 1);
		gl.uniform1f(gl.getUniformLocation(program, 'u_rgb24Min'), settings.normalization?.min ?? 0);
		const rgb24Max = settings.normalization?.max ?? 16777215;
		gl.uniform1f(gl.getUniformLocation(program, 'u_rgb24InverseRange'), rgb24Max > (settings.normalization?.min ?? 0)
			? 1 / (rgb24Max - (settings.normalization?.min ?? 0)) : 0);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	private bindTexture(program: WebGLProgram, uniform: string, unit: number, texture: WebGLTexture): void {
		const gl = this.gl as WebGL2RenderingContext;
		gl.activeTexture(gl.TEXTURE0 + unit);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.uniform1i(gl.getUniformLocation(program, uniform), unit);
	}

	private createProgram(gl: WebGL2RenderingContext, fragmentSource: string): WebGLProgram | null {
		const vertex = this.compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
		const fragment = this.compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
		if (!vertex || !fragment) { return null; }
		const program = gl.createProgram();
		if (!program) { return null; }
		gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
		gl.deleteShader(vertex); gl.deleteShader(fragment);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			const message = gl.getProgramInfoLog(program); gl.deleteProgram(program);
			throw new Error(`Layer compositor program link failed: ${message}`);
		}
		return program;
	}

	private compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
		const shader = gl.createShader(type);
		if (!shader) { return null; }
		gl.shaderSource(shader, source); gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			const message = gl.getShaderInfoLog(shader); gl.deleteShader(shader);
			throw new Error(`Layer compositor shader failed: ${message}`);
		}
		return shader;
	}
}

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }`;

const BLEND_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
precision highp isampler2D;
uniform sampler2D u_previous;
uniform sampler2D u_sourceFloat;
uniform usampler2D u_sourceUint;
uniform isampler2D u_sourceInt;
uniform sampler2D u_maskFloat;
uniform usampler2D u_maskUint;
uniform isampler2D u_maskInt;
uniform sampler2D u_clipSurface;
uniform ivec2 u_outputSize;
uniform ivec2 u_sourceSize;
uniform ivec2 u_layerOffset;
uniform ivec2 u_layerSize;
uniform int u_channels;
uniform int u_encoding;
uniform int u_sourceIsSurface;
uniform int u_hasMask;
uniform int u_maskEncoding;
uniform int u_maskChannels;
uniform int u_maskInvert;
uniform int u_hasClip;
uniform ivec2 u_maskSourceSize;
uniform ivec2 u_maskOffset;
uniform ivec2 u_maskLayerSize;
uniform float u_maskValueScale;
uniform int u_blendMode;
uniform int u_maskCondition;
uniform float u_valueScale;
uniform float u_outputMaximum;
uniform float u_opacity;
uniform float u_maskThreshold;
out vec4 outColor;
bool invalid3(vec3 value) {
	return any(isnan(value)) || any(isinf(value));
}
float nanValue() {
	return uintBitsToFloat(0x7fc00000u);
}
vec4 sourceValue(ivec2 coordinate) {
	vec4 value = u_encoding == 0 ? texelFetch(u_sourceFloat, coordinate, 0)
		: u_encoding == 1 ? vec4(texelFetch(u_sourceUint, coordinate, 0))
		: vec4(texelFetch(u_sourceInt, coordinate, 0));
	if (u_channels == 1) { return vec4(value.rrr * u_valueScale, 1.0); }
	if (u_channels == 2) { return vec4(value.rrr * u_valueScale, value.g * u_valueScale); }
	if (u_channels == 3) { return vec4(value.rgb * u_valueScale, 1.0); }
	return value * u_valueScale;
}
float maskFactor(ivec2 outputPixel, int logicalY) {
	if (u_hasMask == 0) { return 1.0; }
	ivec2 local = ivec2(outputPixel.x - u_maskOffset.x, logicalY - u_maskOffset.y);
	if (local.x < 0 || local.y < 0 || local.x >= u_maskLayerSize.x || local.y >= u_maskLayerSize.y) {
		return u_maskInvert == 1 ? 1.0 : 0.0;
	}
	ivec2 coordinate = ivec2(
		min(u_maskSourceSize.x - 1, int((float(local.x) + 0.5) * float(u_maskSourceSize.x) / float(u_maskLayerSize.x))),
		min(u_maskSourceSize.y - 1, int((float(local.y) + 0.5) * float(u_maskSourceSize.y) / float(u_maskLayerSize.y)))
	);
	vec4 value = u_maskEncoding == 0 ? texelFetch(u_maskFloat, coordinate, 0)
		: u_maskEncoding == 1 ? vec4(texelFetch(u_maskUint, coordinate, 0))
		: vec4(texelFetch(u_maskInt, coordinate, 0));
	float factor = isinf(value.r) || isnan(value.r) ? 0.0 : clamp(value.r * u_maskValueScale, 0.0, 1.0);
	return u_maskInvert == 1 ? 1.0 - factor : factor;
}
vec3 blendValue(vec3 below, vec3 source) {
	if (u_blendMode == 1) { return below * source; }
	if (u_blendMode == 2) { return vec3(1.0) - (vec3(1.0) - below) * (vec3(1.0) - source); }
	if (u_blendMode == 3) {
		return mix(2.0 * below * source, vec3(1.0) - 2.0 * (vec3(1.0) - below) * (vec3(1.0) - source), step(vec3(0.5), below));
	}
	if (u_blendMode == 4) { return min(below, source); }
	if (u_blendMode == 5) { return max(below, source); }
	if (u_blendMode == 6) { return abs(below - source); }
	if (u_blendMode == 7) { return below + source - 2.0 * below * source; }
	if (u_blendMode == 8) { return below + source; }
	if (u_blendMode == 9) { return below - source; }
	if (u_blendMode == 10) { return abs(below - source); }
	if (u_blendMode == 11) { return below * source * u_outputMaximum; }
	if (u_blendMode == 12) {
		return vec3(
			source.r == 0.0 ? nanValue() : below.r / source.r,
			source.g == 0.0 ? nanValue() : below.g / source.g,
			source.b == 0.0 ? nanValue() : below.b / source.b
		) / u_outputMaximum;
	}
	if (u_blendMode == 13) { return min(below, source); }
	if (u_blendMode == 14) { return max(below, source); }
	if (u_blendMode == 15) { return (below + source) * 0.5; }
	return source;
}
bool keepMask(float value) {
	if (u_maskCondition == 1) { return value > u_maskThreshold; }
	if (u_maskCondition == 2) { return value >= u_maskThreshold; }
	if (u_maskCondition == 3) { return value < u_maskThreshold; }
	if (u_maskCondition == 4) { return value <= u_maskThreshold; }
	if (u_maskCondition == 5) { return abs(value - u_maskThreshold) <= 1e-6; }
	if (u_maskCondition == 6) { return !isnan(value) && !isinf(value); }
	if (u_maskCondition == 7) { return isnan(value) || isinf(value); }
	return true;
}
void main() {
	ivec2 outputPixel = ivec2(gl_FragCoord.xy);
	vec4 below = texelFetch(u_previous, outputPixel, 0);
	int logicalY = u_outputSize.y - 1 - outputPixel.y;
	ivec2 local = ivec2(outputPixel.x - u_layerOffset.x, logicalY - u_layerOffset.y);
	if (local.x < 0 || local.y < 0 || local.x >= u_layerSize.x || local.y >= u_layerSize.y) {
		outColor = below;
		return;
	}
	ivec2 sourcePixel = u_sourceIsSurface == 1
		? ivec2(local.x, u_sourceSize.y - 1 - local.y)
		: ivec2(
			min(u_sourceSize.x - 1, int((float(local.x) + 0.5) * float(u_sourceSize.x) / float(u_layerSize.x))),
			min(u_sourceSize.y - 1, int((float(local.y) + 0.5) * float(u_sourceSize.y) / float(u_layerSize.y)))
		);
	vec4 source = sourceValue(sourcePixel);
	if (u_blendMode == 16) {
		float value = u_channels >= 3 ? dot(source.rgb, vec3(0.2126, 0.7152, 0.0722)) : source.r;
		outColor = keepMask(value) ? below : vec4(0.0);
		return;
	}
	if (isnan(source.a) || isinf(source.a)) { outColor = vec4(vec3(nanValue()), 1.0); return; }
	float clipAlpha = u_hasClip == 1 ? texelFetch(u_clipSurface, outputPixel, 0).a : 1.0;
	float sourceAlpha = clamp(source.a * u_opacity * maskFactor(outputPixel, logicalY) * clipAlpha, 0.0, 1.0);
	if (sourceAlpha <= 0.0) { outColor = below; return; }
	float destinationAlpha = below.a;
	if (u_blendMode >= 8 && u_blendMode <= 15) {
		float amount = clamp(u_opacity * maskFactor(outputPixel, logicalY) * clipAlpha, 0.0, 1.0);
		if (destinationAlpha <= 0.0) { outColor = vec4(source.rgb, 1.0); return; }
		vec3 result = blendValue(below.rgb, source.rgb);
		outColor = vec4(mix(below.rgb, result, amount), below.a);
		return;
	}
	float outputAlpha = sourceAlpha + destinationAlpha * (1.0 - sourceAlpha);
	if (destinationAlpha <= 0.0 || (u_blendMode == 0 && sourceAlpha >= 1.0)) {
		outColor = vec4(source.rgb, outputAlpha);
		return;
	}
	if (invalid3(source.rgb) || invalid3(below.rgb)) {
		outColor = vec4(vec3(nanValue()), outputAlpha);
		return;
	}
	vec3 blended = blendValue(below.rgb, source.rgb);
	vec3 color = u_blendMode == 0
		? (source.rgb * sourceAlpha + below.rgb * destinationAlpha * (1.0 - sourceAlpha)) / outputAlpha
		: ((1.0 - sourceAlpha) * destinationAlpha * below.rgb
			+ (1.0 - destinationAlpha) * sourceAlpha * source.rgb
			+ destinationAlpha * sourceAlpha * blended) / outputAlpha;
outColor = vec4(color, outputAlpha);
}`;

const ADJUSTMENT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
precision highp isampler2D;
uniform sampler2D u_source;
uniform sampler2D u_lut;
uniform sampler2D u_adjustmentMaskFloat;
uniform usampler2D u_adjustmentMaskUint;
uniform isampler2D u_adjustmentMaskInt;
uniform int u_type;
uniform float u_amount;
uniform float u_parameters[45];
uniform int u_flags[8];
uniform int u_hasAdjustmentMask;
uniform int u_adjustmentMaskEncoding;
uniform int u_adjustmentMaskInvert;
uniform ivec2 u_adjustmentOutputSize;
uniform ivec2 u_adjustmentMaskSourceSize;
uniform ivec2 u_adjustmentMaskOffset;
uniform ivec2 u_adjustmentMaskLayerSize;
uniform float u_adjustmentMaskValueScale;
out vec4 outColor;
vec3 sampleLut(vec3 color) {
	vec3 position = clamp(color, 0.0, 1.0) * 255.0;
	ivec3 low = ivec3(floor(position));
	ivec3 high = min(low + ivec3(1), ivec3(255));
	vec3 fraction = position - vec3(low);
	vec3 lowValue = vec3(
		texelFetch(u_lut, ivec2(low.r, 0), 0).r,
		texelFetch(u_lut, ivec2(low.g, 0), 0).g,
		texelFetch(u_lut, ivec2(low.b, 0), 0).b
	);
	vec3 highValue = vec3(
		texelFetch(u_lut, ivec2(high.r, 0), 0).r,
		texelFetch(u_lut, ivec2(high.g, 0), 0).g,
		texelFetch(u_lut, ivec2(high.b, 0), 0).b
	);
	return mix(lowValue, highValue, fraction);
}
vec3 rgbToHsl(vec3 color) {
	float maximum = max(color.r, max(color.g, color.b));
	float minimum = min(color.r, min(color.g, color.b));
	float delta = maximum - minimum;
	float lightness = (maximum + minimum) * 0.5;
	float hue = 0.0;
	if (delta > 0.0) {
		if (maximum == color.r) { hue = mod((color.g - color.b) / delta, 6.0); }
		else if (maximum == color.g) { hue = (color.b - color.r) / delta + 2.0; }
		else { hue = (color.r - color.g) / delta + 4.0; }
		hue = mod(hue * 60.0 + 360.0, 360.0);
	}
	float saturation = delta > 0.0 ? delta / max(1e-6, 1.0 - abs(2.0 * lightness - 1.0)) : 0.0;
	return vec3(hue, saturation, lightness);
}
vec3 hslToRgb(vec3 hsl) {
	float c = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
	float section = hsl.x / 60.0;
	float x = c * (1.0 - abs(mod(section, 2.0) - 1.0));
	vec3 rgb = section < 1.0 ? vec3(c, x, 0.0)
		: section < 2.0 ? vec3(x, c, 0.0)
		: section < 3.0 ? vec3(0.0, c, x)
		: section < 4.0 ? vec3(0.0, x, c)
		: section < 5.0 ? vec3(x, 0.0, c)
		: vec3(c, 0.0, x);
	return rgb + vec3(hsl.z - c * 0.5);
}
float luminance(vec3 color) {
	return dot(color, vec3(0.2126, 0.7152, 0.0722));
}
float hueRangeWeight(float hue, float center) {
	float distance = abs(mod(hue - center + 540.0, 360.0) - 180.0);
	return distance <= 30.0 ? 1.0 : distance >= 60.0 ? 0.0 : (60.0 - distance) / 30.0;
}
float configuredHueRangeWeight(float hue, int range, float center) {
	if (u_flags[range + 1] == 0) { return hueRangeWeight(hue, center); }
	int base = 3 + range * 7;
	float a = u_parameters[base], b = u_parameters[base + 1];
	float c = u_parameters[base + 2], d = u_parameters[base + 3];
	while (b < a) { b += 360.0; }
	while (c < b) { c += 360.0; }
	while (d < c) { d += 360.0; }
	float weight = 0.0;
	for (int turn = -1; turn <= 2; turn++) {
		float candidate = hue + float(turn) * 360.0;
		if (candidate < a || candidate > d) { continue; }
		float value = candidate < b ? (candidate - a) / max(1e-6, b - a)
			: candidate <= c ? 1.0 : (d - candidate) / max(1e-6, d - c);
		weight = max(weight, value);
	}
	return clamp(weight, 0.0, 1.0);
}
float mixer(vec3 color, int base) {
	return dot(color, vec3(u_parameters[base], u_parameters[base + 1], u_parameters[base + 2])) / 100.0
		+ u_parameters[base + 3] / 100.0;
}
vec3 directAdjustment(vec3 color) {
	vec3 result = color;
	if (u_type == 2) {
		float brightness = u_parameters[0] / 100.0;
		float contrast = clamp(u_parameters[1] / 100.0, -0.99, 0.99);
		float factor = (1.0 + contrast) / (1.0 - contrast);
		result = (result - vec3(0.5)) * factor + vec3(0.5 + brightness);
	} else if (u_type == 3) {
		float multiplier = exp2(u_parameters[0]);
		result = pow(max(vec3(0.0), result * multiplier + vec3(u_parameters[1])), vec3(1.0 / max(0.01, u_parameters[2])));
	} else if (u_type == 4) {
		result = vec3(1.0) - result;
	} else if (u_type == 5) {
		if (u_flags[0] == 1) { result = vec3(mixer(result, 12)); }
		else { result = vec3(mixer(result, 0), mixer(result, 4), mixer(result, 8)); }
	} else if (u_type == 6) {
		float originalLightness = rgbToHsl(result).z;
		float light = luminance(result);
		vec3 weights = vec3(clamp((0.5 - light) * 2.0, 0.0, 1.0), 1.0 - abs(light - 0.5) * 2.0, clamp((light - 0.5) * 2.0, 0.0, 1.0));
		for (int range = 0; range < 3; range++) {
			int base = range * 3;
			result += vec3(u_parameters[base], u_parameters[base + 1], u_parameters[base + 2]) / 100.0 * weights[range];
		}
		if (u_flags[0] == 1) {
			vec3 hsl = rgbToHsl(clamp(result, 0.0, 1.0));
			result = hslToRgb(vec3(hsl.xy, originalLightness));
		}
	} else if (u_type == 7) {
		vec3 hsl = rgbToHsl(result);
		float weighted = 0.0, total = 0.0;
		for (int range = 0; range < 6; range++) {
			float weight = hueRangeWeight(hsl.x, float(range) * 60.0);
			weighted += u_parameters[range] * weight;
			total += weight;
		}
		float gray = luminance(result) + (((total > 0.0 ? weighted / total : 50.0) - 50.0) / 100.0) * hsl.y * 0.5;
		result = vec3(gray);
	} else if (u_type == 8) {
		result = vec3(luminance(result) * 255.0 >= u_parameters[0] ? 1.0 : 0.0);
	} else if (u_type == 9) {
		float levels = clamp(floor(u_parameters[0] + 0.5), 2.0, 255.0);
		result = floor(result * (levels - 1.0) + 0.5) / (levels - 1.0);
	} else if (u_type == 10) {
		float position = clamp(luminance(result), 0.0, 1.0) * 255.0;
		int low = int(floor(position)), high = min(255, low + 1);
		result = mix(texelFetch(u_lut, ivec2(low, 0), 0).rgb, texelFetch(u_lut, ivec2(high, 0), 0).rgb, position - float(low));
	}
	return clamp(result, 0.0, 1.0);
}
float adjustmentMaskFactor(ivec2 outputPixel) {
	if (u_hasAdjustmentMask == 0) { return 1.0; }
	int logicalY = u_adjustmentOutputSize.y - 1 - outputPixel.y;
	ivec2 local = ivec2(outputPixel.x - u_adjustmentMaskOffset.x, logicalY - u_adjustmentMaskOffset.y);
	if (local.x < 0 || local.y < 0 || local.x >= u_adjustmentMaskLayerSize.x || local.y >= u_adjustmentMaskLayerSize.y) {
		return u_adjustmentMaskInvert == 1 ? 1.0 : 0.0;
	}
	ivec2 coordinate = ivec2(
		min(u_adjustmentMaskSourceSize.x - 1, int((float(local.x) + 0.5) * float(u_adjustmentMaskSourceSize.x) / float(u_adjustmentMaskLayerSize.x))),
		min(u_adjustmentMaskSourceSize.y - 1, int((float(local.y) + 0.5) * float(u_adjustmentMaskSourceSize.y) / float(u_adjustmentMaskLayerSize.y)))
	);
	vec4 value = u_adjustmentMaskEncoding == 0 ? texelFetch(u_adjustmentMaskFloat, coordinate, 0)
		: u_adjustmentMaskEncoding == 1 ? vec4(texelFetch(u_adjustmentMaskUint, coordinate, 0))
		: vec4(texelFetch(u_adjustmentMaskInt, coordinate, 0));
	float factor = isnan(value.r) || isinf(value.r) ? 0.0 : clamp(value.r * u_adjustmentMaskValueScale, 0.0, 1.0);
	return u_adjustmentMaskInvert == 1 ? 1.0 - factor : factor;
}
void main() {
	ivec2 pixel = ivec2(gl_FragCoord.xy);
	vec4 source = texelFetch(u_source, pixel, 0);
	if (source.a <= 0.0 || any(isnan(source.rgb)) || any(isinf(source.rgb))) {
		outColor = source;
		return;
	}
	vec3 adjusted;
	if (u_type == 0) {
		adjusted = sampleLut(source.rgb);
	} else if (u_type == 1) {
		vec3 hsl = rgbToHsl(clamp(source.rgb, 0.0, 1.0));
		if (u_flags[0] == 1) {
			hsl.x = mod(u_parameters[0] + 360.0, 360.0);
			hsl.y = clamp(u_parameters[1], 0.0, 1.0);
			float delta = clamp(u_parameters[2], -1.0, 1.0);
			hsl.z = delta < 0.0 ? hsl.z * (1.0 + delta) : hsl.z + (1.0 - hsl.z) * delta;
		} else {
			float sourceHue = hsl.x;
			hsl.x = mod(hsl.x + u_parameters[0] + 360.0, 360.0);
			hsl.y = clamp(hsl.y + u_parameters[1] / 100.0, 0.0, 1.0);
			hsl.z = clamp(hsl.z + u_parameters[2] / 100.0, 0.0, 1.0);
			for (int range = 0; range < 6; range++) {
				int base = 3 + range * 7;
				float weight = configuredHueRangeWeight(sourceHue, range, float(range) * 60.0);
				hsl.x = mod(hsl.x + u_parameters[base + 4] * weight + 360.0, 360.0);
				hsl.y = clamp(hsl.y + u_parameters[base + 5] / 100.0 * weight, 0.0, 1.0);
				hsl.z = clamp(hsl.z + u_parameters[base + 6] / 100.0 * weight, 0.0, 1.0);
			}
		}
		adjusted = hslToRgb(hsl);
	} else {
		adjusted = directAdjustment(source.rgb);
	}
	float amount = u_amount * adjustmentMaskFactor(pixel);
	outColor = vec4(mix(source.rgb, adjusted, amount), source.a);
}`;

const DISPLAY_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_composite;
uniform sampler2D u_displayColormap;
uniform ivec2 u_outputSize;
uniform float u_min;
uniform float u_inverseRange;
uniform float u_gammaIn;
uniform float u_gammaOut;
uniform float u_exposure;
uniform vec3 u_nanColor;
uniform int u_useDisplayColormap;
uniform int u_rgb24;
uniform float u_rgb24Maximum;
uniform float u_rgb24Divisor;
uniform float u_rgb24Min;
uniform float u_rgb24InverseRange;
out vec4 outColor;
void main() {
	ivec2 outputPixel = ivec2(gl_FragCoord.xy);
	ivec2 compositePixel = outputPixel;
	vec4 value = texelFetch(u_composite, compositePixel, 0);
	if (value.a <= 0.0) { outColor = vec4(0.0); return; }
	if (any(isnan(value.rgb)) || any(isinf(value.rgb))) { outColor = vec4(u_nanColor, 1.0); return; }
	if (u_rgb24 == 1) {
		vec3 raw = value.rgb * u_rgb24Maximum;
		vec3 bytes = floor(clamp(raw / u_rgb24Divisor, 0.0, 255.0) + 0.5);
		float packed = bytes.r * 65536.0 + bytes.g * 256.0 + bytes.b;
		float gray = clamp((packed - u_rgb24Min) * u_rgb24InverseRange, 0.0, 1.0);
		gray = pow(gray, max(0.0001, u_gammaIn));
		gray *= exp2(u_exposure);
		gray = pow(max(gray, 0.0), 1.0 / max(0.0001, u_gammaOut));
		outColor = vec4(vec3(clamp(gray, 0.0, 1.0)), value.a);
		return;
	}
	vec3 normalized = clamp((value.rgb - vec3(u_min)) * u_inverseRange, 0.0, 1.0);
	normalized = pow(max(normalized, vec3(0.0)), vec3(max(0.0001, u_gammaIn)));
	normalized *= exp2(u_exposure);
	normalized = pow(max(normalized, vec3(0.0)), vec3(1.0 / max(0.0001, u_gammaOut)));
	if (u_useDisplayColormap == 1) {
		outColor = vec4(texture(u_displayColormap, vec2(normalized.r, 0.5)).rgb, value.a);
		return;
	}
	outColor = vec4(clamp(normalized, 0.0, 1.0), value.a);
}`;

const REDUCTION_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_reduceSource;
uniform ivec2 u_reduceSourceSize;
uniform int u_reduceFirstPass;
out vec2 outRange;
void main() {
	ivec2 destination = ivec2(gl_FragCoord.xy);
	ivec2 origin = destination * 2;
	float minimum = 3.402823466e+38;
	float maximum = -3.402823466e+38;
	for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
		ivec2 coordinate = origin + ivec2(x, y);
		if (coordinate.x >= u_reduceSourceSize.x || coordinate.y >= u_reduceSourceSize.y) { continue; }
		vec4 value = texelFetch(u_reduceSource, coordinate, 0);
		if (u_reduceFirstPass == 1) {
			if (value.a <= 0.0) { continue; }
			for (int channel = 0; channel < 3; channel++) {
				float sampleValue = value[channel];
				if (isnan(sampleValue) || isinf(sampleValue)) { continue; }
				minimum = min(minimum, sampleValue);
				maximum = max(maximum, sampleValue);
			}
		} else {
			if (value.r <= value.g) {
				minimum = min(minimum, value.r);
				maximum = max(maximum, value.g);
			}
		}
	}
	outRange = vec2(minimum, maximum);
}`;
