// @ts-check
"use strict";
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';

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
	constructor(settingsManager, vscode) {
		this.settingsManager = settingsManager;
		this.vscode = vscode;
		this._lastRaw = null; // { width, height, data: Float32Array }
		this._pendingRenderData = null; // Store data waiting for format-specific settings
		this._isInitialLoad = true; // Track if this is the first render
		this._cachedStats = undefined; // Cache for min/max stats (only used in stats mode)
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
	 * @param {Object} settings - Current settings
	 * @returns {Object} - RGB values for NaN color
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
		try {
			// Check if parseExr is available (from parse-exr library)
			// @ts-ignore
			if (typeof parseExr === 'undefined') {
				throw new Error('parseExr library not loaded. Make sure parse-exr is included.');
			}

			const response = await fetch(src);
			const buffer = await response.arrayBuffer();

			// Invalidate stats cache for new image
			this._cachedStats = undefined;

			// Parse EXR using parse-exr library
			// Use FloatType (1015) to get Float32Array with decoded float values
			// HalfFloatType (1016) returns Uint16Array with raw bytes which need decoding
			// @ts-ignore
			const FloatType = 1015;
			// @ts-ignore
			const exrResult = parseExr(buffer, FloatType);

			const { width, height, data, format, type, channelNames, displayedChannels } = exrResult;

			// Determine channels based on format
			// RGBAFormat = 1023, RedFormat = 1028
			let channels;
			if (format === 1023) { // RGBA
				channels = 4;
			} else if (format === 1028) { // Red (grayscale)
				channels = 1;
			} else {
				// Fallback: try to detect from data length
				const pixelCount = width * height;
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
				channelNames: channelNames || [] // Original EXR channel names
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
	 * @param {HTMLCanvasElement} canvas - Target canvas
	 * @param {Object} settings - Current rendering settings
	 * @returns {ImageData} - Rendered image data
	 */
	renderExrToCanvas(settings) {
		if (!this.rawExrData) {
			throw new Error('No EXR data loaded');
		}

		const { width, height, data, channels } = this.rawExrData;
		const isGammaMode = settings.normalization?.gammaMode || false;

		// Calculate stats if needed (for auto-normalize or just to have them)
		/** @type {{min: number, max: number} | undefined} */
		let stats = this._cachedStats;
		if (!stats && !isGammaMode) {
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

		// Create options object
		const options = {
			nanColor: nanColor,
			// EXR data is typically bottom-up, so we need to flip it for display
			flipY: true
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

		return imageData;
	}

	/**
	 * Get pixel value at coordinates for inspection
	 * @param {number} x - X coordinate
	 * @param {number} y - Y coordinate
	 * @returns {Array<number>} - Pixel values (raw HDR values)
	 */
	getPixelValue(x, y) {
		if (!this.rawExrData) return null;

		const { width, height, data, channels } = this.rawExrData;
		if (x < 0 || x >= width || y < 0 || y >= height) return null;

		// Apply Y-flip to match rendering (EXR uses bottom-left origin, canvas uses top-left)
		const flippedY = height - 1 - y;
		const dataIndex = (flippedY * width + x) * channels;
		const values = [];
		for (let i = 0; i < channels; i++) {
			values.push(data[dataIndex + i]);
		}
		return values;
	}

	/**
	 * Update rendering with new settings (called when settings change)
	 * @param {Object} settings - New settings
	 * @returns {ImageData|null} - Updated image data
	 */
	updateSettings(settings) {
		if (this._pendingRenderData && this._isInitialLoad) {
			// First render after initial load - use pending data
			const { width, height } = this._pendingRenderData;
			const imageData = this.renderExrToCanvas(settings);
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
