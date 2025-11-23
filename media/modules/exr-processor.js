// @ts-check
"use strict";
import { NormalizationHelper } from './normalization-helper.js';

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

			const { width, height, data, format, type } = exrResult;

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
				isFloat: true // EXR is always floating point
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
						isInitialLoad: true // Signal that this is the first load
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
			const imageData = this.renderExrToCanvas(canvas, this.settingsManager.settings);

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
	renderExrToCanvas(canvas, settings) {
		if (!this.rawExrData) {
			throw new Error('No EXR data loaded');
		}

		const { width, height, data, channels } = this.rawExrData;
		const ctx = canvas.getContext('2d');
		const imageData = ctx.createImageData(width, height);
		const pixels = imageData.data;

		// Get settings
		const normalization = settings.normalization || { min: 0, max: 1, autoNormalize: true };
		const gamma = settings.gamma || { in: 1.0, out: 1.0 };
		const brightness = settings.brightness || { offset: 0 };
		const nanColor = this._getNanColor(settings);

		// Calculate stats if needed (for auto-normalize or just to have them)
		/** @type {{min: number, max: number} | undefined} */
		let stats = this._cachedStats;
		if (!stats && (settings.normalization?.autoNormalize || !settings.normalization)) {
			let minVal = Infinity;
			let maxVal = -Infinity;

			// Re-implementing stats calculation loop correctly based on raw data
			const len = width * height;
			for (let i = 0; i < len; i++) {
				for (let c = 0; c < Math.min(channels, 3); c++) { // Only consider RGB channels for min/max
					const val = data[i * channels + c];
					if (Number.isFinite(val)) {
						if (val < minVal) minVal = val;
						if (val > maxVal) maxVal = val;
					}
				}
			}
			stats = { min: minVal, max: maxVal };
			this._cachedStats = stats;

			// Update settings manager and VS Code
			if (this.settingsManager && this.settingsManager.settings.normalization) {
				this.settingsManager.settings.normalization.min = minVal;
				this.settingsManager.settings.normalization.max = maxVal;
			}
		}


		// Auto-detect normalization range if needed
		// Use NormalizationHelper to calculate range
		const { min, max } = NormalizationHelper.getNormalizationRange(
			settings,
			stats || { min: 0, max: 1 },
			1.0,
			true // isFloat
		);

		const range = max - min;
		const invRange = range > 0 ? 1.0 / range : 0;

		// Optimization: Check for identity transform
		const isIdentityGamma = NormalizationHelper.isIdentityTransformation(settings);

		if (isIdentityGamma) {
			console.log('EXR: Identity transform detected, using fast loop');
			// Fast path loop: just normalize and clamp, no gamma math
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					const flippedY = height - 1 - y;
					const pixelIndex = (y * width + x) * 4;
					const dataIndex = (flippedY * width + x) * channels;

					let r, g, b, a = 255;

					if (channels === 1) {
						const value = data[dataIndex];
						if (isNaN(value) || !isFinite(value)) {
							r = nanColor.r; g = nanColor.g; b = nanColor.b;
						} else {
							// Normalize and clamp
							const normalized = (value - min) * invRange;
							const intensity = Math.round(Math.max(0, Math.min(1, normalized)) * 255);
							r = g = b = intensity;
						}
					} else if (channels === 3) {
						const rVal = data[dataIndex];
						const gVal = data[dataIndex + 1];
						const bVal = data[dataIndex + 2];

						if (isNaN(rVal) || isNaN(gVal) || isNaN(bVal)) {
							r = nanColor.r; g = nanColor.g; b = nanColor.b;
						} else {
							r = Math.round(Math.max(0, Math.min(1, (rVal - min) * invRange)) * 255);
							g = Math.round(Math.max(0, Math.min(1, (gVal - min) * invRange)) * 255);
							b = Math.round(Math.max(0, Math.min(1, (bVal - min) * invRange)) * 255);
						}
					} else if (channels === 4) {
						const rVal = data[dataIndex];
						const gVal = data[dataIndex + 1];
						const bVal = data[dataIndex + 2];
						const aVal = data[dataIndex + 3];

						if (isNaN(rVal) || isNaN(gVal) || isNaN(bVal)) {
							r = nanColor.r; g = nanColor.g; b = nanColor.b; a = 255;
						} else {
							r = Math.round(Math.max(0, Math.min(1, (rVal - min) * invRange)) * 255);
							g = Math.round(Math.max(0, Math.min(1, (gVal - min) * invRange)) * 255);
							b = Math.round(Math.max(0, Math.min(1, (bVal - min) * invRange)) * 255);
							a = Math.round(this.clamp(aVal, 0, 1) * 255);
						}
					}

					pixels[pixelIndex] = r;
					pixels[pixelIndex + 1] = g;
					pixels[pixelIndex + 2] = b;
					pixels[pixelIndex + 3] = a;
				}
			}
			ctx.putImageData(imageData, 0, 0);
			return imageData;
		}

		// Render pixels
		// Note: EXR images are typically stored with origin at bottom-left, so flip vertically
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				// Flip Y coordinate for display (EXR uses bottom-left origin, canvas uses top-left)
				const flippedY = height - 1 - y;
				const pixelIndex = (y * width + x) * 4;
				const dataIndex = (flippedY * width + x) * channels;

				let r, g, b, a = 255;

				if (channels === 1) {
					// Grayscale (depth map, single channel)
					const value = data[dataIndex];
					if (isNaN(value) || !isFinite(value)) {
						r = nanColor.r;
						g = nanColor.g;
						b = nanColor.b;
					} else {
						// Normalize and apply tone mapping
						let normalized = (value - min) * invRange;

						// Apply gamma and brightness corrections using the correct order
						normalized = NormalizationHelper.applyGammaAndBrightness(normalized, settings);

						// Clamp only for display conversion to 0-255 range
						const displayValue = Math.max(0, Math.min(1, normalized));
						const intensity = Math.round(displayValue * 255);
						r = g = b = intensity;
					}
				} else if (channels === 3) {
					// RGB
					const rVal = data[dataIndex];
					const gVal = data[dataIndex + 1];
					const bVal = data[dataIndex + 2];

					if (isNaN(rVal) || isNaN(gVal) || isNaN(bVal)) {
						r = nanColor.r;
						g = nanColor.g;
						b = nanColor.b;
					} else {
						// Normalize each channel
						let rNorm = (rVal - min) * invRange;
						let gNorm = (gVal - min) * invRange;
						let bNorm = (bVal - min) * invRange;

						// Apply gamma and brightness corrections using the correct order
						rNorm = NormalizationHelper.applyGammaAndBrightness(rNorm, settings);
						gNorm = NormalizationHelper.applyGammaAndBrightness(gNorm, settings);
						bNorm = NormalizationHelper.applyGammaAndBrightness(bNorm, settings);

						// Clamp only for display conversion to 0-255 range
						r = Math.round(Math.max(0, Math.min(1, rNorm)) * 255);
						g = Math.round(Math.max(0, Math.min(1, gNorm)) * 255);
						b = Math.round(Math.max(0, Math.min(1, bNorm)) * 255);
					}
				} else if (channels === 4) {
					// RGBA
					const rVal = data[dataIndex];
					const gVal = data[dataIndex + 1];
					const bVal = data[dataIndex + 2];
					const aVal = data[dataIndex + 3];

					if (isNaN(rVal) || isNaN(gVal) || isNaN(bVal)) {
						r = nanColor.r;
						g = nanColor.g;
						b = nanColor.b;
						a = 255;
					} else {
						// Normalize RGB channels
						let rNorm = (rVal - min) * invRange;
						let gNorm = (gVal - min) * invRange;
						let bNorm = (bVal - min) * invRange;

						// Apply gamma and brightness corrections using the correct order
						rNorm = NormalizationHelper.applyGammaAndBrightness(rNorm, settings);
						gNorm = NormalizationHelper.applyGammaAndBrightness(gNorm, settings);
						bNorm = NormalizationHelper.applyGammaAndBrightness(bNorm, settings);

						// Clamp only for display conversion to 0-255 range
						r = Math.round(Math.max(0, Math.min(1, rNorm)) * 255);
						g = Math.round(Math.max(0, Math.min(1, gNorm)) * 255);
						b = Math.round(Math.max(0, Math.min(1, bNorm)) * 255);

						// Alpha channel - normalize to 0-1 range and clamp for display
						// Do NOT apply gamma/brightness to alpha as it represents opacity
						a = Math.round(this.clamp(aVal, 0, 1) * 255);
					}
				}

				pixels[pixelIndex] = r;
				pixels[pixelIndex + 1] = g;
				pixels[pixelIndex + 2] = b;
				pixels[pixelIndex + 3] = a;
			}
		}

		ctx.putImageData(imageData, 0, 0);
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
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;

			const imageData = this.renderExrToCanvas(canvas, settings);
			this._isInitialLoad = false;
			this._pendingRenderData = null;

			return imageData;
		} else if (this.rawExrData) {
			// Re-render with new settings
			const { width, height } = this.rawExrData;
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;

			return this.renderExrToCanvas(canvas, settings);
		}
		return null;
	}
}
