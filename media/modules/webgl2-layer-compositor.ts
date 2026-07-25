"use strict";

import type { ImageSettings } from './settings-manager.js';
import type { Layer } from './layer-compositor.js';

type SupportedPixels =
	| Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array
	| Int8Array | Int16Array | Int32Array | Float32Array;

type TextureEntry = {
	texture: WebGLTexture;
	width: number;
	height: number;
	channels: number;
	encoding: 0 | 1 | 2;
	nativeMaximum: number;
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
	private displayProgram: WebGLProgram | null = null;
	private vao: WebGLVertexArrayObject | null = null;
	private outputTextures: [WebGLTexture, WebGLTexture] | null = null;
	private framebuffers: [WebGLFramebuffer, WebGLFramebuffer] | null = null;
	private outputWidth = 0;
	private outputHeight = 0;
	private textureCache = new Map<object, TextureEntry>();
	private ownedTextures = new Set<WebGLTexture>();
	private dummyFloat: WebGLTexture | null = null;
	private dummyUint: WebGLTexture | null = null;
	private dummyInt: WebGLTexture | null = null;
	private failed = false;

	canRender(layers: Layer[], settings: ImageSettings, width: number, height: number): boolean {
		if (settings.gpuAcceleration === false || this.failed || width <= 0 || height <= 0) { return false; }
		if (typeof WebGL2RenderingContext === 'undefined') { return false; }
		if (settings.displayColormap && settings.displayColormap !== 'none') { return false; }
		if (settings.rgbAs24BitGrayscale || settings.normalization?.autoNormalize) { return false; }
		const visible = layers.filter(layer => layer.visible !== false && (layer.opacity ?? 1) > 0);
		if (!visible.length) { return false; }
		for (const layer of visible) {
			if (layer.kind === 'group' || layer.kind === 'adjustment' || layer.parentId || layer.clipped || layer.rasterMask || layer.maskCondition) {
				return false;
			}
			if (!layer.data || !GPU_BLEND_MODES.has(layer.blendMode || 'normal')) { return false; }
			if (layer.channels < 1 || layer.channels > 4 || !this.isSupportedPixels(layer.data)) { return false; }
		}
		return true;
	}

	render(
		layers: Layer[],
		documentWidth: number,
		documentHeight: number,
		scale: number,
		settings: ImageSettings,
		nanColor: { r: number; g: number; b: number },
	): HTMLCanvasElement | null {
		if (!this.canRender(layers, settings, documentWidth, documentHeight)) { return null; }
		try {
			const width = Math.max(1, Math.round(documentWidth * scale));
			const height = Math.max(1, Math.round(documentHeight * scale));
			if (!this.ensureContext(width, height)) { return null; }
			const gl = this.gl as WebGL2RenderingContext;
			const maximumTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
			if (width > maximumTextureSize || height > maximumTextureSize) { return null; }
			this.pruneTextureCache(new Set(
				layers.flatMap(layer => layer.data && this.isSupportedPixels(layer.data) ? [layer.data as object] : []),
			));
			for (const layer of layers) {
				if (layer.visible === false || (layer.opacity ?? 1) <= 0 || !layer.data) { continue; }
				if (layer.width > maximumTextureSize || layer.height > maximumTextureSize) { return null; }
				this.textureFor(layer.data as SupportedPixels, layer.width, layer.height, layer.channels);
			}
			this.ensureOutputSurfaces(width, height);
			this.clearOutputSurfaces();

			let previous = 0;
			for (const layer of layers) {
				if (layer.visible === false || (layer.opacity ?? 1) <= 0 || !layer.data) { continue; }
				const destination = previous === 0 ? 1 : 0;
				this.drawLayer(layer, scale, previous, destination);
				previous = destination;
			}
			this.drawDisplay(previous, settings, layers, nanColor);
			gl.flush();
			return this.canvas;
		} catch (error) {
			console.warn('[WebGL2LayerCompositor] Falling back to worker:', error);
			this.failed = true;
			this.dispose();
			return null;
		}
	}

	dispose(): void {
		const gl = this.gl;
		if (gl) {
			for (const texture of this.ownedTextures) { gl.deleteTexture(texture); }
			for (const framebuffer of this.framebuffers || []) { gl.deleteFramebuffer(framebuffer); }
			if (this.blendProgram) { gl.deleteProgram(this.blendProgram); }
			if (this.displayProgram) { gl.deleteProgram(this.displayProgram); }
			if (this.vao) { gl.deleteVertexArray(this.vao); }
		}
		this.canvas = null;
		this.gl = null;
		this.blendProgram = null;
		this.displayProgram = null;
		this.vao = null;
		this.outputTextures = null;
		this.framebuffers = null;
		this.outputWidth = 0;
		this.outputHeight = 0;
		this.textureCache.clear();
		this.ownedTextures.clear();
		this.dummyFloat = null;
		this.dummyUint = null;
		this.dummyInt = null;
	}

	private isSupportedPixels(data: ArrayLike<number>): data is SupportedPixels {
		return data instanceof Uint8Array || data instanceof Uint8ClampedArray ||
			data instanceof Uint16Array || data instanceof Uint32Array ||
			data instanceof Int8Array || data instanceof Int16Array ||
			data instanceof Int32Array || data instanceof Float32Array;
	}

	private ensureContext(width: number, height: number): boolean {
		if (this.gl && this.canvas && this.blendProgram && this.displayProgram && this.vao) {
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
		const displayProgram = this.createProgram(gl, DISPLAY_FRAGMENT_SHADER);
		const vao = gl.createVertexArray();
		const vertexBuffer = gl.createBuffer();
		if (!blendProgram || !displayProgram || !vao || !vertexBuffer) {
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
		this.displayProgram = displayProgram;
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

	private ensureOutputSurfaces(width: number, height: number): void {
		if (this.outputTextures && this.framebuffers && this.outputWidth === width && this.outputHeight === height) { return; }
		const gl = this.gl as WebGL2RenderingContext;
		for (const texture of this.outputTextures || []) {
			gl.deleteTexture(texture); this.ownedTextures.delete(texture);
		}
		for (const framebuffer of this.framebuffers || []) { gl.deleteFramebuffer(framebuffer); }
		const textures: WebGLTexture[] = [], framebuffers: WebGLFramebuffer[] = [];
		for (let index = 0; index < 2; index++) {
			const texture = gl.createTexture(), framebuffer = gl.createFramebuffer();
			if (!texture || !framebuffer) { throw new Error('Could not allocate GPU composite surface'); }
			this.ownedTextures.add(texture);
			gl.bindTexture(gl.TEXTURE_2D, texture);
			this.configureTexture();
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
			gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
			gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
			if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
				throw new Error('Float composite framebuffer is incomplete');
			}
			textures.push(texture); framebuffers.push(framebuffer);
		}
		this.outputTextures = textures as [WebGLTexture, WebGLTexture];
		this.framebuffers = framebuffers as [WebGLFramebuffer, WebGLFramebuffer];
		this.outputWidth = width; this.outputHeight = height;
	}

	private clearOutputSurfaces(): void {
		const gl = this.gl as WebGL2RenderingContext;
		gl.clearColor(0, 0, 0, 0);
		for (const framebuffer of this.framebuffers as [WebGLFramebuffer, WebGLFramebuffer]) {
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
		if (data instanceof Float32Array) {
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
		gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data as any);
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

	private drawLayer(layer: Layer, scale: number, previous: number, destination: number): void {
		const gl = this.gl as WebGL2RenderingContext;
		const program = this.blendProgram as WebGLProgram;
		const source = this.textureFor(layer.data as SupportedPixels, layer.width, layer.height, layer.channels);
		gl.bindFramebuffer(gl.FRAMEBUFFER, (this.framebuffers as [WebGLFramebuffer, WebGLFramebuffer])[destination]);
		gl.viewport(0, 0, this.outputWidth, this.outputHeight);
		gl.useProgram(program);
		gl.bindVertexArray(this.vao);
		this.bindTexture(program, 'u_previous', 0, (this.outputTextures as [WebGLTexture, WebGLTexture])[previous]);
		this.bindTexture(program, 'u_sourceFloat', 1, source.encoding === 0 ? source.texture : this.dummyFloat as WebGLTexture);
		this.bindTexture(program, 'u_sourceUint', 2, source.encoding === 1 ? source.texture : this.dummyUint as WebGLTexture);
		this.bindTexture(program, 'u_sourceInt', 3, source.encoding === 2 ? source.texture : this.dummyInt as WebGLTexture);
		gl.uniform2i(gl.getUniformLocation(program, 'u_outputSize'), this.outputWidth, this.outputHeight);
		gl.uniform2i(gl.getUniformLocation(program, 'u_sourceSize'), layer.width, layer.height);
		gl.uniform2i(gl.getUniformLocation(program, 'u_layerOffset'), Math.round((layer.offsetX || 0) * scale), Math.round((layer.offsetY || 0) * scale));
		gl.uniform2i(gl.getUniformLocation(program, 'u_layerSize'), Math.max(1, Math.round(layer.width * scale)), Math.max(1, Math.round(layer.height * scale)));
		gl.uniform1i(gl.getUniformLocation(program, 'u_channels'), layer.channels);
		gl.uniform1i(gl.getUniformLocation(program, 'u_encoding'), source.encoding);
		const valueScale = source.encoding === 0 && source.nativeMaximum > 1
			? source.nativeMaximum / (layer.typeMax || source.nativeMaximum)
			: 1 / (layer.typeMax || 1);
		gl.uniform1f(gl.getUniformLocation(program, 'u_valueScale'), valueScale);
		gl.uniform1f(gl.getUniformLocation(program, 'u_opacity'), Math.max(0, Math.min(1, layer.opacity ?? 1)));
		gl.uniform1i(gl.getUniformLocation(program, 'u_blendMode'), GPU_BLEND_MODES.get(layer.blendMode || 'normal') || 0);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	private drawDisplay(surface: number, settings: ImageSettings, layers: Layer[], nanColor: { r: number; g: number; b: number }): void {
		const gl = this.gl as WebGL2RenderingContext;
		const program = this.displayProgram as WebGLProgram;
		const outputTypeMax = layers.find(layer => layer.visible !== false && (layer.opacity ?? 1) > 0 && layer.data)?.typeMax || 1;
		const min = settings.normalization?.gammaMode ? 0 : (settings.normalization?.min ?? 0) / outputTypeMax;
		const max = settings.normalization?.gammaMode ? 1 : (settings.normalization?.max ?? outputTypeMax) / outputTypeMax;
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, this.outputWidth, this.outputHeight);
		gl.useProgram(program);
		gl.bindVertexArray(this.vao);
		this.bindTexture(program, 'u_composite', 0, (this.outputTextures as [WebGLTexture, WebGLTexture])[surface]);
		gl.uniform2i(gl.getUniformLocation(program, 'u_outputSize'), this.outputWidth, this.outputHeight);
		gl.uniform1f(gl.getUniformLocation(program, 'u_min'), min);
		gl.uniform1f(gl.getUniformLocation(program, 'u_inverseRange'), max > min ? 1 / (max - min) : 0);
		gl.uniform1f(gl.getUniformLocation(program, 'u_gammaIn'), settings.gamma?.in ?? 1);
		gl.uniform1f(gl.getUniformLocation(program, 'u_gammaOut'), settings.gamma?.out ?? 1);
		gl.uniform1f(gl.getUniformLocation(program, 'u_exposure'), settings.brightness?.offset ?? 0);
		gl.uniform3f(gl.getUniformLocation(program, 'u_nanColor'), nanColor.r / 255, nanColor.g / 255, nanColor.b / 255);
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
uniform ivec2 u_outputSize;
uniform ivec2 u_sourceSize;
uniform ivec2 u_layerOffset;
uniform ivec2 u_layerSize;
uniform int u_channels;
uniform int u_encoding;
uniform int u_blendMode;
uniform float u_valueScale;
uniform float u_opacity;
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
	return source;
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
	ivec2 sourcePixel = ivec2(
		min(u_sourceSize.x - 1, int((float(local.x) + 0.5) * float(u_sourceSize.x) / float(u_layerSize.x))),
		min(u_sourceSize.y - 1, int((float(local.y) + 0.5) * float(u_sourceSize.y) / float(u_layerSize.y)))
	);
	vec4 source = sourceValue(sourcePixel);
	if (isnan(source.a) || isinf(source.a)) { outColor = vec4(vec3(nanValue()), 1.0); return; }
	float sourceAlpha = clamp(source.a * u_opacity, 0.0, 1.0);
	if (sourceAlpha <= 0.0) { outColor = below; return; }
	float destinationAlpha = below.a;
	float outputAlpha = sourceAlpha + destinationAlpha * (1.0 - sourceAlpha);
	if (destinationAlpha <= 0.0 || sourceAlpha >= 1.0) {
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

const DISPLAY_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_composite;
uniform ivec2 u_outputSize;
uniform float u_min;
uniform float u_inverseRange;
uniform float u_gammaIn;
uniform float u_gammaOut;
uniform float u_exposure;
uniform vec3 u_nanColor;
out vec4 outColor;
void main() {
	ivec2 outputPixel = ivec2(gl_FragCoord.xy);
	ivec2 compositePixel = outputPixel;
	vec4 value = texelFetch(u_composite, compositePixel, 0);
	if (value.a <= 0.0) { outColor = vec4(0.0); return; }
	if (any(isnan(value.rgb)) || any(isinf(value.rgb))) { outColor = vec4(u_nanColor, 1.0); return; }
	vec3 normalized = clamp((value.rgb - vec3(u_min)) * u_inverseRange, 0.0, 1.0);
	normalized = pow(max(normalized, vec3(0.0)), vec3(max(0.0001, u_gammaIn)));
	normalized *= exp2(u_exposure);
	normalized = pow(max(normalized, vec3(0.0)), vec3(1.0 / max(0.0001, u_gammaOut)));
	outColor = vec4(clamp(normalized, 0.0, 1.0), value.a);
}`;
