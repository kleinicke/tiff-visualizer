// @ts-check
"use strict";
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';
import { DecodeWorkerClient } from './decode-worker-client.js';
import { WebGL2FloatRenderer } from './webgl2-float-renderer.js';

/** @typedef {import('./settings-manager.js').ImageSettings} ImageSettings */
/** @typedef {import('./settings-manager.js').SettingsManager} SettingsManager */
/** @typedef {{postMessage: (msg: any) => any}} VsCodeApi */

/**
 * @typedef {Object} ExrImageData
 * @property {number} width
 * @property {number} height
 * @property {Float32Array | Uint16Array} data
 * @property {number} channels - 1 (grayscale), 3 (RGB), or 4 (RGBA)
 * @property {number} type - Float type (1015 = Float32, 1016 = Float16)
 * @property {number} format - Color format (1023 = RGBA, 1028 = Red/Grayscale)
 */

/**
 * EXR Processor Module
 * Handles OpenEXR image processing, normalization, and HDR tone mapping
 * Uses parse-exr library for EXR file parsing
 */
export class ExrProcessor {
	/**
	 * @param {SettingsManager} settingsManager
	 * @param {VsCodeApi} vscode
	 */
	constructor(settingsManager, vscode) {
		this.settingsManager = settingsManager;
		this.vscode = vscode;
		this._lastRaw = null; // { width, height, data: Float32Array }
		this._pendingRenderData = null; // Store data waiting for format-specific settings
		this._isInitialLoad = true; // Track if this is the first render
		this._cachedStats = undefined; // Cache for min/max stats (only used in stats mode)
		this._lastRenderHistogram = null;
		this._lastRenderUsedWebGL = false;
		this._webglRenderer = new WebGL2FloatRenderer();
		/** @type {AbortSignal|undefined} */
		this.loadSignal = undefined; // Set before each load; aborts the fetch when a newer image switch supersedes it
		/** @type {DecodeWorkerClient|null} */
		this.decodeWorker = null; // Off-thread decoder, set by imagePreview.js; null falls back to local decoding
	}

	/**
	 * Clamp a value between min and max
	 * @param {number} value
	 * @param {number} min
	 * @param {number} max
	 * @returns {number}
	 */
	clamp(value, min, max) {
		return Math.min(Math.max(value, min), max);
	}

	/**
	 * Get NaN color based on settings
	 * @param {ImageSettings} settings - Current settings
	 * @returns {{r: number, g: number, b: number}} - RGB values for NaN color
	 */
	_getNanColor(settings) {
		if (settings.nanColor === 'fuchsia') {
			return { r: 255, g: 0, b: 255 }; // Fuchsia
		} else {
			return { r: 0, g: 0, b: 0 }; // Black (default)
		}
	}



	/**
	 * Process EXR file from URL
	 * @param {string} src - EXR file URL
	 * @returns {Promise<{canvas: HTMLCanvasElement, imageData: ImageData, exrData: Object}>}
	 */
	async processExr(src) {
		const loadSignal = this.loadSignal;
		try {
			// Check if parseExr is available (from parse-exr library)
			// @ts-ignore
			if (typeof parseExr === 'undefined') {
				throw new Error('parseExr library not loaded. Make sure parse-exr is included.');
			}

			const buffer = await DecodeWorkerClient.fetchArrayBuffer(src, loadSignal, 'exr');
			if (loadSignal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }

			// Invalidate stats cache for new image
			this._cachedStats = undefined;

			// Parse EXR using parse-exr library — in the decode worker when
			// available (same vendored build), locally otherwise.
			// Use FloatType (1015) to get Float32Array with decoded float values
			// HalfFloatType (1016) returns Uint16Array with raw bytes which need decoding
			const FloatType = 1015;
			const exrResult = await DecodeWorkerClient.decodeWithFallback(
				this.decodeWorker, 'exr', buffer, src, loadSignal,
				// @ts-ignore
				(b) => parseExr(b, FloatType));
			if (exrResult.wasmFallbackReason) {
				console.warn('[ExrProcessor] Rust EXR decoder fell back to parse-exr:', exrResult.wasmFallbackReason);
			}

			const { width, height, data, format, type, channelNames, displayedChannels } = exrResult;
			const flipY = exrResult.flipY !== false;

			// Determine channels based on format
			// RGBAFormat = 1023, RedFormat = 1028
			let channels;
			const pixelCount = width * height;
			if (Array.isArray(displayedChannels) && displayedChannels.length > 0 && data.length === pixelCount * displayedChannels.length) {
				channels = displayedChannels.length;
			} else if (format === 1023) { // RGBA
				channels = 4;
			} else if (format === 1028) { // Red (grayscale)
				channels = 1;
			} else {
				// Fallback: try to detect from data length
				const totalValues = data.length;
				channels = totalValues / pixelCount;
			}

			// Create canvas
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;

			// Store raw EXR data for pixel inspection and re-rendering
			this.rawExrData = {
				width,
				height,
				data: data, // Float32Array or Uint16Array
				channels,
				type, // 1015 = Float32, 1016 = HalfFloat
				format,
				isFloat: true, // EXR is always floating point
				channelNames: channelNames || [], // Original EXR channel names
				flipY
			};

			// Send format information to VS Code BEFORE rendering
			if (this.vscode && this._isInitialLoad) {
				this.vscode.postMessage({
					type: 'formatInfo',
					value: {
						width: width,
						height: height,
						channels: channels,
						samplesPerPixel: channels,
						dataType: type === 1016 ? 'float16' : 'float32',
						isHdr: true,
						formatLabel: 'EXR',
						formatType: 'exr-float', // For per-format settings
						isInitialLoad: true, // Signal that this is the first load
						channelNames: channelNames || [], // All channel names in file
						displayedChannels: displayedChannels || [] // Channels actually being displayed
					}
				});

				// Store pending render data - will render when settings are updated
				this._pendingRenderData = { width, height, data, channels, type, format };

				// Return placeholder - actual rendering happens when settings update
				const placeholderImageData = new ImageData(width, height);
				return {
					canvas: canvas,
					imageData: placeholderImageData,
					exrData: this.rawExrData
				};
			}

			// If not initial load, render immediately with current settings
			const imageData = this.renderExrToCanvas(this.settingsManager.settings);

			return {
				canvas: canvas,
				imageData: imageData,
				exrData: this.rawExrData
			};

		} catch (error) {
			console.error('Error processing EXR:', error);
			throw error;
		}
	}

	/**
	 * Render EXR data to canvas with current settings
	 * @param {ImageSettings} settings - Current rendering settings
	 * @returns {ImageData} - Rendered image data
	 */
	renderExrToCanvas(settings, renderOptions = {}) {
		this._lastRenderHistogram = null;
		this._lastRenderUsedWebGL = false;
		if (!this.rawExrData) {
			throw new Error('No EXR data loaded');
		}

		const { width, height, data, channels, flipY } = this.rawExrData;
		const isGammaMode = settings.normalization?.gammaMode || false;

		// Calculate stats if needed (for auto-normalize or just to have them)
		/** @type {{min: number, max: number} | undefined} */
		let stats = this._cachedStats;
		if (!stats && NormalizationHelper.needsStats(settings)) {
			stats = ImageStatsCalculator.calculateFloatStats(data, width, height, channels);
			this._cachedStats = stats;

			// Send stats to VS Code for status bar display
			if (this.vscode && stats) {
				this.vscode.postMessage({ type: 'stats', value: stats });
			}

			// Only update settings if auto-normalize is enabled (don't overwrite manual values!)
			const isAutoNormalize = settings.normalization?.autoNormalize !== false;
			if (isAutoNormalize && this.settingsManager && this.settingsManager.settings.normalization) {
				this.settingsManager.settings.normalization.min = stats.min;
				this.settingsManager.settings.normalization.max = stats.max;
			}
		}

		const nanColor = this._getNanColor(settings);

		if (renderOptions.targetCanvas && this._webglRenderer.canRender({
			data,
			width,
			height,
			channels,
			isFloat: true,
			settings,
			collectHistogram: renderOptions.collectHistogram === true
		})) {
			const rendered = this._webglRenderer.render(renderOptions.targetCanvas, {
				data,
				width,
				height,
				min: (stats && Number.isFinite(stats.min)) ? stats.min : 0,
				max: (stats && Number.isFinite(stats.max)) ? stats.max : 1,
				typeMax: 1.0,
				settings,
				nanColor,
				channels,
				flipY
			});
			if (rendered) {
				this._lastRenderUsedWebGL = true;
				return renderOptions.placeholderImageData || new ImageData(width, height);
			}
		}

		// Create options object
		const options = {
			nanColor: nanColor,
			flipY,
			collectHistogram: renderOptions.collectHistogram === true
		};

		const imageData = ImageRenderer.render(
			data,
			width,
			height,
			channels,
			true, // isFloat
			stats || { min: 0, max: 1 },
			settings,
			options
		);
		this._lastRenderHistogram = options.renderHistogramResult || null;

		return imageData;
	}

	/**
	 * Get pixel value at coordinates for inspection
	 * @param {number} x - X coordinate
	 * @param {number} y - Y coordinate
	 * @returns {number[]|null} - Pixel values (raw HDR values)
	 */
	getPixelValue(x, y) {
		if (!this.rawExrData) return null;

		const { width, height, data, channels } = this.rawExrData;
		if (x < 0 || x >= width || y < 0 || y >= height) return null;

		const flippedY = this.rawExrData.flipY ? height - 1 - y : y;
		const dataIndex = (flippedY * width + x) * channels;
		const values = [];
		for (let i = 0; i < channels; i++) {
			values.push(data[dataIndex + i]);
		}
		return values;
	}

	/**
	 * Update rendering with new settings (called when settings change)
	 * @param {ImageSettings} settings - New settings
	 * @returns {ImageData|null} - Updated image data
	 */
	updateSettings(settings, renderOptions = {}) {
		if (this._pendingRenderData && this._isInitialLoad) {
			// First render after initial load - use pending data
			const imageData = this.renderExrToCanvas(settings, renderOptions);
			this._isInitialLoad = false;
			this._pendingRenderData = null;

			return imageData;
		} else if (this.rawExrData) {
			// Re-render with new settings
			const { width, height } = this.rawExrData;
			return this.renderExrToCanvas(settings);
		}
		return null;
	}
}
