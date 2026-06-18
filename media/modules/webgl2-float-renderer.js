// @ts-check
"use strict";

import { NormalizationHelper } from './normalization-helper.js';
import { PerfTrace } from './perf-trace.js';
import { getColormapLut } from './colormaps.js';

/**
 * Small WebGL2 renderer for the hot scientific-image paths:
 * scalar/float RGB/uint16 data rendered directly to the visible canvas.
 *
 * It is intentionally narrow. Unsupported settings should fall back to the CPU
 * ImageRenderer path rather than growing hidden behavior differences.
 */
export class WebGL2FloatRenderer {
	constructor() {
		/** @type {HTMLCanvasElement|null} */
		this.canvas = null;
		/** @type {WebGL2RenderingContext|null} */
		this.gl = null;
		/** @type {WebGLProgram|null} */
		this.program = null;
		/** @type {WebGLTexture|null} */
		this.texture = null;
		/** @type {WebGLTexture|null} */
		this.dummyFloatTexture = null;
		/** @type {WebGLTexture|null} */
		this.dummyUintTexture = null;
		/** @type {WebGLTexture|null} */
		this.colormapTexture = null;
		/** @type {WebGLVertexArrayObject|null} */
		this.vao = null;
		/** @type {Float32Array|null} */
		this.textureData = null;
		this.textureFormat = '';
		this.colormapName = '';
		this.textureWidth = 0;
		this.textureHeight = 0;
		this.failed = false;
		this.rgb32fFailed = false;
		this.uintTextureFailed = false;
	}

	/**
	 * @param {{data: ArrayLike<number>, width: number, height: number, channels: number, isFloat: boolean, settings: any, collectHistogram?: boolean}} params
	 */
	canRender(params) {
		if (this.failed) { return false; }
		if (!ArrayBuffer.isView(params.data)) { return false; }
		const wantsRgb24 = params.settings?.rgbAs24BitGrayscale && params.channels === 3;
		const wantsScalar = params.channels === 1;
		const wantsColor = !wantsRgb24 && (params.channels === 3 || params.channels === 4);
		if (params.isFloat) {
			if (params.data.BYTES_PER_ELEMENT !== 4) { return false; }
			if (wantsRgb24 && this.rgb32fFailed) { return false; }
			if (!wantsScalar && !wantsRgb24 && !wantsColor) { return false; }
		} else {
			if (this.uintTextureFailed || !(params.data instanceof Uint16Array)) { return false; }
			if (!wantsScalar && !wantsRgb24 && !wantsColor) { return false; }
			if (params.settings?.displayColormap && params.settings.displayColormap !== 'none' && !wantsScalar) { return false; }
		}
		return typeof WebGL2RenderingContext !== 'undefined';
	}

	/**
	 * @param {HTMLCanvasElement} canvas
	 * @param {{data: Float32Array|Uint16Array, width: number, height: number, channels?: number, isFloat?: boolean, min: number, max: number, typeMax: number, settings: any, nanColor: {r:number,g:number,b:number}, flipY?: boolean}} params
	 * @returns {boolean} true when WebGL rendered the canvas
	 */
	render(canvas, params) {
		try {
			if (!this._ensureContext(canvas)) { return false; }
			const gl = /** @type {WebGL2RenderingContext} */ (this.gl);
			const maxTextureSize = /** @type {number} */ (gl.getParameter(gl.MAX_TEXTURE_SIZE));
			if (params.width > maxTextureSize || params.height > maxTextureSize) {
				console.warn(`[WebGL2FloatRenderer] Image ${params.width}x${params.height} exceeds max texture size ${maxTextureSize}; using CPU renderer`);
				return false;
			}
			if (canvas.width !== params.width || canvas.height !== params.height) {
				canvas.width = params.width;
				canvas.height = params.height;
			}

			const textureFormat = this._getTextureFormat(params);
			this._uploadTextureIfNeeded(params.data, params.width, params.height, textureFormat);
			this._uploadColormapIfNeeded(params.settings?.displayColormap || 'none');
			this._draw(params);
			PerfTrace.mark('render-webgl');
			return true;
		} catch (error) {
			const textureFormat = this._getTextureFormat(params);
			if (textureFormat.endsWith('ui')) {
				this.uintTextureFailed = true;
				console.warn('[WebGL2FloatRenderer] Disabled uint16 GPU path after render failure:', error);
				return false;
			}
			if (params.settings?.rgbAs24BitGrayscale && params.channels === 3) {
				this.rgb32fFailed = true;
				console.warn('[WebGL2FloatRenderer] Disabled RGB24 GPU path after render failure:', error);
				return false;
			}
			this.failed = true;
			console.warn('[WebGL2FloatRenderer] Disabled after render failure:', error);
			return false;
		}
	}

	dispose() {
		const gl = this.gl;
		if (gl) {
			if (this.texture) { gl.deleteTexture(this.texture); }
			if (this.dummyFloatTexture) { gl.deleteTexture(this.dummyFloatTexture); }
			if (this.dummyUintTexture) { gl.deleteTexture(this.dummyUintTexture); }
			if (this.colormapTexture) { gl.deleteTexture(this.colormapTexture); }
			if (this.program) { gl.deleteProgram(this.program); }
			if (this.vao) { gl.deleteVertexArray(this.vao); }
		}
		this.canvas = null;
		this.gl = null;
		this.program = null;
		this.texture = null;
		this.dummyFloatTexture = null;
		this.dummyUintTexture = null;
		this.colormapTexture = null;
		this.vao = null;
		this.textureData = null;
		this.textureFormat = '';
		this.colormapName = '';
		this.textureWidth = 0;
		this.textureHeight = 0;
	}

	/** @param {HTMLCanvasElement} canvas */
	_ensureContext(canvas) {
		if (this.gl && this.canvas === canvas && this.program && this.texture && this.vao) {
			return true;
		}
		this.dispose();
		const gl = canvas.getContext('webgl2', {
			alpha: false,
			antialias: false,
			depth: false,
			stencil: false,
			preserveDrawingBuffer: true,
			premultipliedAlpha: false
		});
		if (!gl) {
			this.failed = true;
			return false;
		}

		const program = this._createProgram(gl);
		const vao = gl.createVertexArray();
		const texture = gl.createTexture();
		const dummyFloatTexture = gl.createTexture();
		const dummyUintTexture = gl.createTexture();
		const colormapTexture = gl.createTexture();
		if (!program || !vao || !texture || !dummyFloatTexture || !dummyUintTexture || !colormapTexture) {
			this.failed = true;
			return false;
		}

		gl.bindVertexArray(vao);
		const vertexBuffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
			-1, -1, 0, 1,
			1, -1, 1, 1,
			-1, 1, 0, 0,
			1, 1, 1, 0
		]), gl.STATIC_DRAW);
		const stride = 4 * 4;
		const posLoc = gl.getAttribLocation(program, 'a_position');
		const texLoc = gl.getAttribLocation(program, 'a_texCoord');
		gl.enableVertexAttribArray(posLoc);
		gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, stride, 0);
		gl.enableVertexAttribArray(texLoc);
		gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, stride, 2 * 4);

		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

		gl.bindTexture(gl.TEXTURE_2D, dummyFloatTexture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array([0]));

		gl.bindTexture(gl.TEXTURE_2D, dummyUintTexture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array([0]));

		gl.bindTexture(gl.TEXTURE_2D, colormapTexture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

		this.canvas = canvas;
		this.gl = gl;
		this.program = program;
		this.texture = texture;
		this.dummyFloatTexture = dummyFloatTexture;
		this.dummyUintTexture = dummyUintTexture;
		this.colormapTexture = colormapTexture;
		this.vao = vao;
		return true;
	}

	/**
	 * @param {Float32Array|Uint16Array} data
	 * @param {number} width
	 * @param {number} height
	 * @param {'r32f'|'rgb32f'|'rgba32f'|'r16ui'|'rgb16ui'|'rgba16ui'} textureFormat
	 */
	_uploadTextureIfNeeded(data, width, height, textureFormat) {
		const gl = /** @type {WebGL2RenderingContext} */ (this.gl);
		if (this.textureData === data && this.textureWidth === width && this.textureHeight === height && this.textureFormat === textureFormat) {
			PerfTrace.detail('webgl-texture-upload-skipped', 0);
			return;
		}
		const start = performance.now();
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		switch (textureFormat) {
			case 'rgb32f':
				gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, width, height, 0, gl.RGB, gl.FLOAT, data);
				break;
			case 'rgba32f':
				gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data);
				break;
			case 'r16ui':
				gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, width, height, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, data);
				break;
			case 'rgb16ui':
				gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16UI, width, height, 0, gl.RGB_INTEGER, gl.UNSIGNED_SHORT, data);
				break;
			case 'rgba16ui':
				gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16UI, width, height, 0, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, data);
				break;
			default:
				gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, data);
		}
		const error = gl.getError();
		if (error !== gl.NO_ERROR) {
			throw new Error(`Float texture upload failed: WebGL error ${error}`);
		}
		this.textureData = data;
		this.textureWidth = width;
		this.textureHeight = height;
		this.textureFormat = textureFormat;
		PerfTrace.mark('webgl-texture-upload');
		console.log(`[WebGL2] Float texture upload took ${(performance.now() - start).toFixed(2)}ms`);
	}

	/** @param {{channels?: number, isFloat?: boolean, settings?: any}} params */
	_getTextureFormat(params) {
		const channels = params.channels || 1;
		const wantsRgb24 = params.settings?.rgbAs24BitGrayscale && channels === 3;
		if (params.isFloat !== false) {
			if (wantsRgb24 || channels === 3) { return 'rgb32f'; }
			if (channels === 4) { return 'rgba32f'; }
			return 'r32f';
		}
		if (wantsRgb24 || channels === 3) { return 'rgb16ui'; }
		if (channels === 4) { return 'rgba16ui'; }
		return 'r16ui';
	}

	/** @param {string} colormapName */
	_uploadColormapIfNeeded(colormapName) {
		if (!colormapName || colormapName === 'none') {
			this.colormapName = 'none';
			return;
		}
		if (this.colormapName === colormapName) { return; }
		const lut = getColormapLut(colormapName);
		if (!lut) {
			this.colormapName = 'none';
			return;
		}
		const gl = /** @type {WebGL2RenderingContext} */ (this.gl);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.colormapTexture);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 256, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, lut);
		const error = gl.getError();
		if (error !== gl.NO_ERROR) {
			throw new Error(`Colormap texture upload failed: WebGL error ${error}`);
		}
		this.colormapName = colormapName;
	}

	/** @param {{min:number,max:number,typeMax:number,settings:any,nanColor:{r:number,g:number,b:number},channels?:number}} params */
	_draw(params) {
		const gl = /** @type {WebGL2RenderingContext} */ (this.gl);
		const program = /** @type {WebGLProgram} */ (this.program);
		const settings = params.settings || {};
		const textureFormat = this.textureFormat;
		const isUintTexture = textureFormat.endsWith('ui');
		const isGammaMode = settings.normalization?.gammaMode || false;
		const isIdentity = NormalizationHelper.isIdentityTransformation(settings);
		const stats = Number.isFinite(params.min) && Number.isFinite(params.max)
			? { min: params.min, max: params.max }
			: null;
		let displayMin;
		let displayMax;
		let gammaExponent = 1.0;
		if (isGammaMode && isIdentity) {
			displayMin = 0;
			displayMax = params.typeMax;
		} else {
			const range = NormalizationHelper.getNormalizationRange(settings, stats, params.typeMax, true);
			displayMin = range.min;
			displayMax = range.max;
		}
		if (isGammaMode && !isIdentity) {
			const range = NormalizationHelper.getEffectiveVisualizationRange(settings, 0, params.typeMax);
			displayMin = range.min;
			displayMax = range.max;
			const gammaIn = settings.gamma?.in ?? 1.0;
			const gammaOut = settings.gamma?.out ?? 1.0;
			gammaExponent = gammaIn / gammaOut;
		}
		const range = displayMax - displayMin;

		gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
		gl.useProgram(program);
		gl.bindVertexArray(this.vao);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, isUintTexture ? this.dummyFloatTexture : this.texture);
		gl.uniform1i(gl.getUniformLocation(program, 'u_dataFloat'), 0);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.colormapTexture);
		gl.uniform1i(gl.getUniformLocation(program, 'u_colormap'), 1);
		gl.activeTexture(gl.TEXTURE2);
		gl.bindTexture(gl.TEXTURE_2D, isUintTexture ? this.texture : this.dummyUintTexture);
		gl.uniform1i(gl.getUniformLocation(program, 'u_dataUint'), 2);
		gl.uniform1f(gl.getUniformLocation(program, 'u_min'), displayMin);
		gl.uniform1f(gl.getUniformLocation(program, 'u_invRange'), range > 0 ? 1.0 / range : 0.0);
		gl.uniform1f(gl.getUniformLocation(program, 'u_gammaExponent'), gammaExponent);
		gl.uniform1i(gl.getUniformLocation(program, 'u_flipY'), params.flipY ? 1 : 0);
		const channels = params.channels || 1;
		const renderMode = settings.rgbAs24BitGrayscale && channels === 3
			? (isUintTexture ? 4 : 2)
			: (channels >= 3 ? (isUintTexture ? 5 : 3) : (isUintTexture ? 1 : 0));
		gl.uniform1i(gl.getUniformLocation(program, 'u_renderMode'), renderMode);
		gl.uniform1i(gl.getUniformLocation(program, 'u_useColormap'), !!settings.displayColormap && settings.displayColormap !== 'none' ? 1 : 0);
		gl.uniform1f(gl.getUniformLocation(program, 'u_rgb24ChannelDivisor'), params.typeMax > 255 ? 257.0 : 1.0);
		gl.uniform3f(
			gl.getUniformLocation(program, 'u_nanColor'),
			params.nanColor.r / 255,
			params.nanColor.g / 255,
			params.nanColor.b / 255
		);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.flush();
	}

	/**
	 * @param {WebGL2RenderingContext} gl
	 * @returns {WebGLProgram|null}
	 */
	_createProgram(gl) {
		const vertex = this._compileShader(gl, gl.VERTEX_SHADER, `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
	v_texCoord = a_texCoord;
	gl_Position = vec4(a_position, 0.0, 1.0);
}`);
		const fragment = this._compileShader(gl, gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp usampler2D;
uniform sampler2D u_dataFloat;
uniform usampler2D u_dataUint;
uniform sampler2D u_colormap;
uniform float u_min;
uniform float u_invRange;
uniform float u_gammaExponent;
uniform float u_rgb24ChannelDivisor;
uniform bool u_flipY;
uniform int u_renderMode;
uniform bool u_useColormap;
uniform vec3 u_nanColor;
in vec2 v_texCoord;
out vec4 outColor;
float applyGamma(float value) {
	float normalized = clamp((value - u_min) * u_invRange, 0.0, 1.0);
	if (abs(u_gammaExponent - 1.0) > 0.0001) {
		normalized = pow(normalized, u_gammaExponent);
	}
	return normalized;
}
void main() {
	vec2 texCoord = u_flipY ? vec2(v_texCoord.x, 1.0 - v_texCoord.y) : v_texCoord;
	if (u_renderMode == 2 || u_renderMode == 4) {
		vec3 sampleRgb = u_renderMode == 2
			? texture(u_dataFloat, texCoord).rgb
			: vec3(texture(u_dataUint, texCoord).rgb);
		if (isnan(sampleRgb.r) || isinf(sampleRgb.r) || isnan(sampleRgb.g) || isinf(sampleRgb.g) || isnan(sampleRgb.b) || isinf(sampleRgb.b)) {
			outColor = vec4(u_nanColor, 1.0);
			return;
		}
		float r8 = floor(clamp(sampleRgb.r / u_rgb24ChannelDivisor, 0.0, 255.0) + 0.5);
		float g8 = floor(clamp(sampleRgb.g / u_rgb24ChannelDivisor, 0.0, 255.0) + 0.5);
		float b8 = floor(clamp(sampleRgb.b / u_rgb24ChannelDivisor, 0.0, 255.0) + 0.5);
		float value24 = r8 * 65536.0 + g8 * 256.0 + b8;
		float gray = applyGamma(value24);
		outColor = vec4(vec3(gray), 1.0);
		return;
	}
	if (u_renderMode == 3 || u_renderMode == 5) {
		vec3 sampleRgb = u_renderMode == 3
			? texture(u_dataFloat, texCoord).rgb
			: vec3(texture(u_dataUint, texCoord).rgb);
		if (isnan(sampleRgb.r) || isinf(sampleRgb.r) || isnan(sampleRgb.g) || isinf(sampleRgb.g) || isnan(sampleRgb.b) || isinf(sampleRgb.b)) {
			outColor = vec4(u_nanColor, 1.0);
			return;
		}
		outColor = vec4(
			applyGamma(sampleRgb.r),
			applyGamma(sampleRgb.g),
			applyGamma(sampleRgb.b),
			1.0
		);
		return;
	}
	float value = u_renderMode == 1
		? float(texture(u_dataUint, texCoord).r)
		: texture(u_dataFloat, texCoord).r;
	if (u_renderMode == 0) {
		vec4 sampleValue = texture(u_dataFloat, texCoord);
		if (isnan(sampleValue.r) || isinf(sampleValue.r) || isnan(sampleValue.g) || isinf(sampleValue.g) || isnan(sampleValue.b) || isinf(sampleValue.b)) {
			outColor = vec4(u_nanColor, 1.0);
			return;
		}
	}
	float normalized = applyGamma(value);
	if (u_useColormap) {
		outColor = vec4(texture(u_colormap, vec2(normalized, 0.5)).rgb, 1.0);
		return;
	}
	outColor = vec4(vec3(normalized), 1.0);
}`);
		if (!vertex || !fragment) { return null; }
		const program = gl.createProgram();
		if (!program) { return null; }
		gl.attachShader(program, vertex);
		gl.attachShader(program, fragment);
		gl.linkProgram(program);
		gl.deleteShader(vertex);
		gl.deleteShader(fragment);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			console.warn('[WebGL2FloatRenderer] Program link failed:', gl.getProgramInfoLog(program));
			gl.deleteProgram(program);
			return null;
		}
		return program;
	}

	/**
	 * @param {WebGL2RenderingContext} gl
	 * @param {number} type
	 * @param {string} source
	 */
	_compileShader(gl, type, source) {
		const shader = gl.createShader(type);
		if (!shader) { return null; }
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			console.warn('[WebGL2FloatRenderer] Shader compile failed:', gl.getShaderInfoLog(shader));
			gl.deleteShader(shader);
			return null;
		}
		return shader;
	}
}
