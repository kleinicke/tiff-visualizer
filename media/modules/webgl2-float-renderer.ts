"use strict";
import { nanIsTransparent } from './nan-color.js';

import { NormalizationHelper } from './normalization-helper.js';
import { PerfTrace } from './perf-trace.js';
import { getColormapLut } from './colormaps.js';

/** Concrete typed-array types actually passed in as pixel data by callers. */
type TypedPixelData = Uint8Array | Uint16Array | Float32Array;

export interface CanRenderParams {
	data: TypedPixelData;
	width: number;
	height: number;
	channels: number;
	isFloat: boolean;
	settings: any;
	collectHistogram?: boolean;
}

export interface RenderParams {
	data: TypedPixelData;
	width: number;
	height: number;
	channels?: number;
	isFloat?: boolean;
	min: number;
	max: number;
	typeMin?: number;
	typeMax: number;
	settings: any;
	nanColor: { r: number; g: number; b: number };
	/** GDAL_NODATA sentinel; drawn in nanColor, as the CPU path does. */
	nodataValue?: number;
	flipY?: boolean;
}

type TextureFormat = 'r32f' | 'rgb32f' | 'rgba32f' | 'r16ui' | 'rgb16ui' | 'rgba16ui' | 'r8ui' | 'rgb8ui' | 'rgba8ui' | '';

const validatedUploadPixelsByFormat = new Map<string, number>();
const validatedColormapUploads = new Set<string>();

/**
 * Small WebGL2 renderer for the hot scientific-image paths:
 * scalar/float RGB/uint16 data rendered directly to the visible canvas.
 *
 * It is intentionally narrow. Unsupported settings should fall back to the CPU
 * ImageRenderer path rather than growing hidden behavior differences.
 */
/**
 * Shape of a four-channel texture holding `samples` RGB samples back to back,
 * or null when it does not fit. Prefers an exact shape, so the samples upload
 * in one call without padding.
 */
export function linearRgbTextureShape(samples: number, maxTextureSize: number): { width: number; height: number } | null {
	const texels = Math.ceil(samples / 4);
	const minWidth = Math.ceil(texels / maxTextureSize);
	if (minWidth > maxTextureSize) { return null; }
	if (samples % 4 === 0) {
		for (let width = Math.min(maxTextureSize, texels); width >= minWidth; width--) {
			if (texels % width === 0 && texels / width <= maxTextureSize) { return { width, height: texels / width }; }
		}
	}
	const width = Math.min(maxTextureSize, texels);
	const height = Math.ceil(texels / width);
	return height <= maxTextureSize ? { width, height } : null;
}

export class WebGL2FloatRenderer {
	canvas: HTMLCanvasElement | null;
	gl: WebGL2RenderingContext | null;
	program: WebGLProgram | null;
	texture: WebGLTexture | null;
	dummyFloatTexture: WebGLTexture | null;
	dummyUintTexture: WebGLTexture | null;
	colormapTexture: WebGLTexture | null;
	vao: WebGLVertexArrayObject | null;
	textureData: TypedPixelData | null;
	textureFormat: TextureFormat;
	/** Three-channel data uploaded as a one-channel texture three texels wide per pixel. */
	texturePacked: boolean;
	/** Three-channel data uploaded back to back into a four-channel texture. */
	textureLinear: boolean;
	/** Allows the linear layout; tests turn it off to draw the native RGB reference. */
	allowLinearRgb: boolean;
	colormapName: string;
	textureWidth: number;
	textureHeight: number;
	failed: boolean;
	rgb32fFailed: boolean;
	uintTextureFailed: boolean;

	constructor() {
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
		this.texturePacked = false;
		this.textureLinear = false;
		this.allowLinearRgb = true;
		this.colormapName = '';
		this.textureWidth = 0;
		this.textureHeight = 0;
		this.failed = false;
		this.rgb32fFailed = false;
		this.uintTextureFailed = false;
	}

	canRender(params: CanRenderParams): boolean {
		if (params.settings?.gpuAcceleration === false) { return false; }
		if (this.failed) { return false; }
		if (!ArrayBuffer.isView(params.data)) { return false; }
		// Drawing pixels with no value as HOLES needs a canvas that can be
		// transparent; this context is deliberately `alpha: false`, which is
		// what lets the compositor skip blending for every ordinary image.
		// Rather than pay that for everyone, decline and let the CPU renderer —
		// which writes real alpha — handle the files where it was asked for.
		if (nanIsTransparent(params.settings)) { return false; }
		const wantsRgb24 = params.settings?.rgbAs24BitGrayscale && params.channels === 3;
		const wantsScalar = params.channels === 1;
		// Debayering happens on the CPU inside NormalizationHelper.render(), which
		// this path bypasses. Decline so the mosaic is not shown as raw grayscale.
		const debayer = params.settings?.debayer;
		if (debayer?.enabled && params.channels === 1 && debayer.view !== 'mosaic') { return false; }
		const wantsColor = !wantsRgb24 && (params.channels === 3 || params.channels === 4);
		if (params.isFloat) {
			if (params.data.BYTES_PER_ELEMENT !== 4) { return false; }
			if (wantsRgb24 && this.rgb32fFailed) { return false; }
			if (!wantsScalar && !wantsRgb24 && !wantsColor) { return false; }
		} else {
			// Both widths upload as native integer textures; the shader samples a
			// usampler2D and normalizes with typeMax, so it does not care which.
			const isUintCarrier = params.data instanceof Uint16Array
				|| params.data instanceof Uint8Array
				|| params.data instanceof Uint8ClampedArray;
			if (this.uintTextureFailed || !isUintCarrier) { return false; }
			if (!wantsScalar && !wantsRgb24 && !wantsColor) { return false; }
			if (params.settings?.displayColormap && params.settings.displayColormap !== 'none' && !wantsScalar) { return false; }
		}
		return typeof WebGL2RenderingContext !== 'undefined';
	}

	/**
	 * @returns true when WebGL rendered the canvas
	 */
	render(canvas: HTMLCanvasElement, params: RenderParams): boolean {
		try {
			const setupStart = performance.now();
			if (!this._ensureContext(canvas)) { return false; }
			PerfTrace.mark('webgl-context-setup');
			PerfTrace.detail('webgl-context-setup-detail', performance.now() - setupStart);
			const gl = this.gl as WebGL2RenderingContext;
			const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
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

	dispose(): void {
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
		this.texturePacked = false;
		this.textureLinear = false;
		this.colormapName = '';
		this.textureWidth = 0;
		this.textureHeight = 0;
	}

	_ensureContext(canvas: HTMLCanvasElement): boolean {
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

		// Dithering changes scientific display pixels by one level on hardware GPUs.
		gl.disable(gl.DITHER);
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

	_uploadTextureIfNeeded(data: TypedPixelData, width: number, height: number, textureFormat: TextureFormat): void {
		const gl = this.gl as WebGL2RenderingContext;
		if (this.textureData === data && this.textureWidth === width && this.textureHeight === height && this.textureFormat === textureFormat) {
			PerfTrace.detail('webgl-texture-upload-skipped', 0);
			return;
		}
		const start = performance.now();
		const setupStart = performance.now();
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		PerfTrace.detail('webgl-texture-upload-setup', performance.now() - setupStart);
		const uploadStart = performance.now();
		// The GPU has no three-channel formats (Metal, via ANGLE): RGB uploads
		// are expanded to RGBA during upload, which measured 66ms against 28ms
		// for the same 5120x5120 RGB8 bytes uploaded as one channel. Upload them
		// as a one-channel texture three texels wide per pixel instead; the
		// shader fetches the three texels. Falls back when that is too wide.
		const rgb = textureFormat === 'rgb8ui' || textureFormat === 'rgb16ui' || textureFormat === 'rgb32f';
		const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
		const packed = rgb && width * 3 <= maxTextureSize;
		// Wider images keep the samples back to back in a four-channel
		// texture (native on the GPU, so no expansion either); the shader
		// fetches the two texels holding a pixel's three samples.
		const linear = !packed && rgb && this.allowLinearRgb && data.length === width * height * 3
			? linearRgbTextureShape(data.length, maxTextureSize) : null;
		if (packed) {
			const packedFormat = textureFormat === 'rgb8ui' ? [gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE]
				: textureFormat === 'rgb16ui' ? [gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT]
					: [gl.R32F, gl.RED, gl.FLOAT];
			gl.texImage2D(gl.TEXTURE_2D, 0, packedFormat[0], width * 3, height, 0, packedFormat[1], packedFormat[2], data);
		} else if (linear) {
			const [internal, format, type] = textureFormat === 'rgb8ui' ? [gl.RGBA8UI, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE]
				: textureFormat === 'rgb16ui' ? [gl.RGBA16UI, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT]
					: [gl.RGBA32F, gl.RGBA, gl.FLOAT];
			const rowSamples = linear.width * 4;
			if (linear.width * linear.height * 4 === data.length) {
				gl.texImage2D(gl.TEXTURE_2D, 0, internal, linear.width, linear.height, 0, format, type, data);
			} else {
				// No exact shape: whole rows straight from the samples, then the
				// last partial row from a small zero-padded copy.
				gl.texImage2D(gl.TEXTURE_2D, 0, internal, linear.width, linear.height, 0, format, type, null);
				const fullRows = Math.floor(data.length / rowSamples);
				if (fullRows > 0) {
					gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, linear.width, fullRows, format, type, data.subarray(0, fullRows * rowSamples));
				}
				if (fullRows < linear.height) {
					const Carrier = data.constructor as { new(length: number): TypedPixelData };
					const tail = new Carrier(rowSamples);
					tail.set(data.subarray(fullRows * rowSamples) as any);
					gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, fullRows, linear.width, 1, format, type, tail);
				}
			}
		} else {
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
				case 'r8ui':
					gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, width, height, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, data);
					break;
				case 'rgb8ui':
					gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8UI, width, height, 0, gl.RGB_INTEGER, gl.UNSIGNED_BYTE, data);
					break;
				case 'rgba8ui':
					gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8UI, width, height, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, data);
					break;
				default:
					gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, data);
			}
		}
		const layoutSuffix = packed ? '-packed' : linear ? '-linear' : '';
		PerfTrace.detail(`webgl-texImage2D-${textureFormat}${layoutSuffix}`, performance.now() - uploadStart);
		const pixels = width * height;
		const validationKey = `${textureFormat}${layoutSuffix}`;
		const validatedPixels = validatedUploadPixelsByFormat.get(validationKey) || 0;
		if (pixels > validatedPixels) {
			const errorStart = performance.now();
			const error = gl.getError();
			PerfTrace.detail('webgl-texture-upload-error-check', performance.now() - errorStart);
			if (error !== gl.NO_ERROR) {
				throw new Error(`Float texture upload failed: WebGL error ${error}`);
			}
			validatedUploadPixelsByFormat.set(validationKey, pixels);
		} else {
			PerfTrace.detail('webgl-texture-upload-error-check-skipped', 0);
		}
		this.textureData = data;
		this.textureWidth = width;
		this.textureHeight = height;
		this.textureFormat = textureFormat;
		this.texturePacked = packed;
		this.textureLinear = !!linear;
		PerfTrace.mark('webgl-texture-upload');
		console.log(`[WebGL2] Float texture upload took ${(performance.now() - start).toFixed(2)}ms`);
	}

	_getTextureFormat(params: { channels?: number; isFloat?: boolean; settings?: any; data?: TypedPixelData }): TextureFormat {
		const channels = params.channels || 1;
		const wantsRgb24 = params.settings?.rgbAs24BitGrayscale && channels === 3;
		if (params.isFloat !== false) {
			if (wantsRgb24 || channels === 3) { return 'rgb32f'; }
			if (channels === 4) { return 'rgba32f'; }
			return 'r32f';
		}
		// 8-bit samples get an 8-bit texture rather than being widened to 16: the
		// upload is a third of the bytes and needs no conversion pass.
		const eightBit = params.data?.BYTES_PER_ELEMENT === 1;
		if (wantsRgb24 || channels === 3) { return eightBit ? 'rgb8ui' : 'rgb16ui'; }
		if (channels === 4) { return eightBit ? 'rgba8ui' : 'rgba16ui'; }
		return eightBit ? 'r8ui' : 'r16ui';
	}

	_uploadColormapIfNeeded(colormapName: string): void {
		if (!colormapName || colormapName === 'none') {
			this.colormapName = 'none';
			return;
		}
		if (this.colormapName === colormapName) { return; }
		const start = performance.now();
		const lut = getColormapLut(colormapName);
		if (!lut) {
			this.colormapName = 'none';
			return;
		}
		const gl = this.gl as WebGL2RenderingContext;
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.colormapTexture);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 256, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, lut);
		if (!validatedColormapUploads.has(colormapName)) {
			const error = gl.getError();
			if (error !== gl.NO_ERROR) {
				throw new Error(`Colormap texture upload failed: WebGL error ${error}`);
			}
			validatedColormapUploads.add(colormapName);
		}
		this.colormapName = colormapName;
		PerfTrace.detail('webgl-colormap-upload', performance.now() - start);
	}

	_draw(params: { min: number; max: number; typeMin?: number; typeMax: number; settings: any; nanColor: { r: number; g: number; b: number }; channels?: number; flipY?: boolean; nodataValue?: number }): void {
		const gl = this.gl as WebGL2RenderingContext;
		const program = this.program as WebGLProgram;
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
			displayMin = params.typeMin ?? 0;
			displayMax = params.typeMax;
		} else {
			const range = NormalizationHelper.getNormalizationRange(settings, stats, params.typeMax, true, params.typeMin ?? 0);
			displayMin = range.min;
			displayMax = range.max;
		}
		if (isGammaMode && !isIdentity) {
			const range = NormalizationHelper.getEffectiveVisualizationRange(settings, params.typeMin ?? 0, params.typeMax);
			displayMin = range.min;
			displayMax = range.max;
			const gammaIn = settings.gamma?.in ?? 1.0;
			const gammaOut = settings.gamma?.out ?? 1.0;
			gammaExponent = gammaIn / gammaOut;
		}
		const range = displayMax - displayMin;

		const stateStart = performance.now();
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
		gl.uniform1i(gl.getUniformLocation(program, 'u_packedRgb'), this.texturePacked ? 1 : 0);
		gl.uniform1i(gl.getUniformLocation(program, 'u_linearRgb'), this.textureLinear ? 1 : 0);
		gl.uniform2i(gl.getUniformLocation(program, 'u_imageSize'), this.textureWidth, this.textureHeight);
		gl.uniform1i(gl.getUniformLocation(program, 'u_useColormap'), !!settings.displayColormap && settings.displayColormap !== 'none' ? 1 : 0);
		gl.uniform1f(gl.getUniformLocation(program, 'u_rgb24ChannelDivisor'), params.typeMax > 255 ? 257.0 : 1.0);
		const nodata = Number(params.nodataValue);
		gl.uniform1i(gl.getUniformLocation(program, 'u_hasNodata'), Number.isFinite(nodata) ? 1 : 0);
		gl.uniform1f(gl.getUniformLocation(program, 'u_nodata'), Number.isFinite(nodata) ? nodata : 0);
		gl.uniform3f(
			gl.getUniformLocation(program, 'u_nanColor'),
			params.nanColor.r / 255,
			params.nanColor.g / 255,
			params.nanColor.b / 255
		);
		PerfTrace.detail('webgl-draw-state', performance.now() - stateStart);
		const drawStart = performance.now();
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		PerfTrace.detail('webgl-draw-submit', performance.now() - drawStart);
		const flushStart = performance.now();
		gl.flush();
		PerfTrace.detail('webgl-flush', performance.now() - flushStart);
	}

	_createProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
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
// The file's "no measurement here" sentinel (GDAL_NODATA), or NaN when the
// file declares none — a NaN uniform never equals a sample, so the test below
// costs one comparison and changes nothing for files without one.
uniform float u_nodata;
uniform bool u_hasNodata;
// Three-channel data stored three texels wide per pixel (see the upload).
uniform bool u_packedRgb;
// Three-channel data stored back to back, four samples per texel.
uniform bool u_linearRgb;
uniform ivec2 u_imageSize;
in vec2 v_texCoord;
out vec4 outColor;
// The texel NEAREST sampling would pick for texCoord, as an integer coordinate.
ivec2 packedPixel(vec2 texCoord) {
	return clamp(ivec2(floor(texCoord * vec2(u_imageSize))), ivec2(0), u_imageSize - 1);
}
// The texel holding linear sample index, in a texture of the given size.
ivec2 linearTexel(int index, ivec2 size) {
	int texel = min(index, size.x * size.y - 1);
	return ivec2(texel % size.x, texel / size.x);
}
vec3 pickLinear(vec4 first, vec4 second, int offset) {
	float samples[8] = float[8](first.r, first.g, first.b, first.a, second.r, second.g, second.b, second.a);
	return vec3(samples[offset], samples[offset + 1], samples[offset + 2]);
}
vec3 sampleFloatRgb(vec2 texCoord) {
	if (u_linearRgb) {
		ivec2 p = packedPixel(texCoord);
		int start = (p.y * u_imageSize.x + p.x) * 3;
		ivec2 size = textureSize(u_dataFloat, 0);
		return pickLinear(texelFetch(u_dataFloat, linearTexel(start >> 2, size), 0),
			texelFetch(u_dataFloat, linearTexel((start >> 2) + 1, size), 0), start & 3);
	}
	if (!u_packedRgb) { return texture(u_dataFloat, texCoord).rgb; }
	ivec2 p = packedPixel(texCoord);
	int x = p.x * 3;
	return vec3(texelFetch(u_dataFloat, ivec2(x, p.y), 0).r,
		texelFetch(u_dataFloat, ivec2(x + 1, p.y), 0).r,
		texelFetch(u_dataFloat, ivec2(x + 2, p.y), 0).r);
}
vec3 sampleUintRgb(vec2 texCoord) {
	if (u_linearRgb) {
		ivec2 p = packedPixel(texCoord);
		int start = (p.y * u_imageSize.x + p.x) * 3;
		ivec2 size = textureSize(u_dataUint, 0);
		return pickLinear(vec4(texelFetch(u_dataUint, linearTexel(start >> 2, size), 0)),
			vec4(texelFetch(u_dataUint, linearTexel((start >> 2) + 1, size), 0)), start & 3);
	}
	if (!u_packedRgb) { return vec3(texture(u_dataUint, texCoord).rgb); }
	ivec2 p = packedPixel(texCoord);
	int x = p.x * 3;
	return vec3(float(texelFetch(u_dataUint, ivec2(x, p.y), 0).r),
		float(texelFetch(u_dataUint, ivec2(x + 1, p.y), 0).r),
		float(texelFetch(u_dataUint, ivec2(x + 2, p.y), 0).r));
}
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
			? sampleFloatRgb(texCoord)
			: sampleUintRgb(texCoord);
		if (isnan(sampleRgb.r) || isinf(sampleRgb.r) || isnan(sampleRgb.g) || isinf(sampleRgb.g) || isnan(sampleRgb.b) || isinf(sampleRgb.b)
			|| (u_hasNodata && (sampleRgb.r == u_nodata || sampleRgb.g == u_nodata || sampleRgb.b == u_nodata))) {
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
			? sampleFloatRgb(texCoord)
			: sampleUintRgb(texCoord);
		if (isnan(sampleRgb.r) || isinf(sampleRgb.r) || isnan(sampleRgb.g) || isinf(sampleRgb.g) || isnan(sampleRgb.b) || isinf(sampleRgb.b)
			|| (u_hasNodata && (sampleRgb.r == u_nodata || sampleRgb.g == u_nodata || sampleRgb.b == u_nodata))) {
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
	if (u_hasNodata && value == u_nodata) {
		outColor = vec4(u_nanColor, 1.0);
		return;
	}
	float normalized = applyGamma(value);
	if (u_useColormap) {
		outColor = vec4(texture(u_colormap, vec2(normalized, 0.5)).rgb, 1.0);
		return;
	}
	// Match the CPU's Math.round before the driver converts to UNORM8.
	// Hardware conversion may round intermediate values differently.
	float byteValue = floor(normalized * 255.0 + 0.5);
	outColor = vec4(vec3(byteValue / 255.0), 1.0);
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

	_compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
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
