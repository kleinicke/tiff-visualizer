// @ts-check
"use strict";

import { NormalizationHelper } from './normalization-helper.js';
import { PerfTrace } from './perf-trace.js';

/**
 * Small WebGL2 renderer for the hot scientific-image path:
 * single-channel Float32 data rendered directly to the visible canvas.
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
		/** @type {WebGLVertexArrayObject|null} */
		this.vao = null;
		/** @type {Float32Array|null} */
		this.textureData = null;
		this.textureWidth = 0;
		this.textureHeight = 0;
		this.failed = false;
	}

	/**
	 * @param {{data: ArrayLike<number>, width: number, height: number, channels: number, isFloat: boolean, hasEnabledMasks?: boolean, settings: any, collectHistogram?: boolean}} params
	 */
	canRender(params) {
		if (this.failed) { return false; }
		if (params.channels !== 1 || !params.isFloat) { return false; }
		if (!ArrayBuffer.isView(params.data) || params.data.BYTES_PER_ELEMENT !== 4) { return false; }
		if (params.hasEnabledMasks) { return false; }
		if (params.settings?.rgbAs24BitGrayscale) { return false; }
		if (params.settings?.displayColormap && params.settings.displayColormap !== 'none') { return false; }
		return typeof WebGL2RenderingContext !== 'undefined';
	}

	/**
	 * @param {HTMLCanvasElement} canvas
	 * @param {{data: Float32Array, width: number, height: number, min: number, max: number, typeMax: number, settings: any, nanColor: {r:number,g:number,b:number}, flipY?: boolean}} params
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

			this._uploadTextureIfNeeded(params.data, params.width, params.height);
			this._draw(params);
			PerfTrace.mark('render-webgl');
			return true;
		} catch (error) {
			this.failed = true;
			console.warn('[WebGL2FloatRenderer] Disabled after render failure:', error);
			return false;
		}
	}

	dispose() {
		const gl = this.gl;
		if (gl) {
			if (this.texture) { gl.deleteTexture(this.texture); }
			if (this.program) { gl.deleteProgram(this.program); }
			if (this.vao) { gl.deleteVertexArray(this.vao); }
		}
		this.canvas = null;
		this.gl = null;
		this.program = null;
		this.texture = null;
		this.vao = null;
		this.textureData = null;
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
		if (!program || !vao || !texture) {
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

		this.canvas = canvas;
		this.gl = gl;
		this.program = program;
		this.texture = texture;
		this.vao = vao;
		return true;
	}

	/**
	 * @param {Float32Array} data
	 * @param {number} width
	 * @param {number} height
	 */
	_uploadTextureIfNeeded(data, width, height) {
		const gl = /** @type {WebGL2RenderingContext} */ (this.gl);
		if (this.textureData === data && this.textureWidth === width && this.textureHeight === height) {
			PerfTrace.detail('webgl-texture-upload-skipped', 0);
			return;
		}
		const start = performance.now();
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, data);
		const error = gl.getError();
		if (error !== gl.NO_ERROR) {
			throw new Error(`Float texture upload failed: WebGL error ${error}`);
		}
		this.textureData = data;
		this.textureWidth = width;
		this.textureHeight = height;
		PerfTrace.mark('webgl-texture-upload');
		console.log(`[WebGL2] Float texture upload took ${(performance.now() - start).toFixed(2)}ms`);
	}

	/** @param {{min:number,max:number,typeMax:number,settings:any,nanColor:{r:number,g:number,b:number}}} params */
	_draw(params) {
		const gl = /** @type {WebGL2RenderingContext} */ (this.gl);
		const program = /** @type {WebGLProgram} */ (this.program);
		const settings = params.settings || {};
		const isGammaMode = settings.normalization?.gammaMode || false;
		const isIdentity = NormalizationHelper.isIdentityTransformation(settings);
		let displayMin = params.min;
		let displayMax = params.max;
		let gammaExponent = 1.0;
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
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		gl.uniform1i(gl.getUniformLocation(program, 'u_data'), 0);
		gl.uniform1f(gl.getUniformLocation(program, 'u_min'), displayMin);
		gl.uniform1f(gl.getUniformLocation(program, 'u_invRange'), range > 0 ? 1.0 / range : 0.0);
		gl.uniform1f(gl.getUniformLocation(program, 'u_gammaExponent'), gammaExponent);
		gl.uniform1i(gl.getUniformLocation(program, 'u_flipY'), params.flipY ? 1 : 0);
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
uniform sampler2D u_data;
uniform float u_min;
uniform float u_invRange;
uniform float u_gammaExponent;
uniform bool u_flipY;
uniform vec3 u_nanColor;
in vec2 v_texCoord;
out vec4 outColor;
void main() {
	vec2 texCoord = u_flipY ? vec2(v_texCoord.x, 1.0 - v_texCoord.y) : v_texCoord;
	float value = texture(u_data, texCoord).r;
	if (isnan(value) || isinf(value)) {
		outColor = vec4(u_nanColor, 1.0);
		return;
	}
	float normalized = clamp((value - u_min) * u_invRange, 0.0, 1.0);
	if (abs(u_gammaExponent - 1.0) > 0.0001) {
		normalized = pow(normalized, u_gammaExponent);
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
