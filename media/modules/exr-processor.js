// @ts-check
"use strict";

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
		this.rawExrData = null;
		this._pendingRenderData = null; // Store data waiting for format-specific settings
		this._isInitialLoad = true; // Track if this is the first render
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
	 * Apply gamma and brightness corrections in the correct order
	 * The correct order is: remove input gamma → apply brightness → apply output gamma
	 * @param {number} normalizedValue - Value in 0-1 range
	 * @param {Object} gamma - Gamma settings {in, out}
	 * @param {Object} brightness - Brightness settings {offset}
	 * @returns {number} - Corrected value
	 */
	_applyGammaAndBrightness(normalizedValue, gamma, brightness) {
		// Optimization: Skip if no changes (gamma is identity and brightness is 0)
		if (Math.abs(gamma.in - gamma.out) < 0.001 && Math.abs(brightness.offset) < 0.001) {
			return normalizedValue;
		}

		// Step 1: Remove input gamma (linearize) - raise to gammaIn power
		let linear = Math.pow(normalizedValue, gamma.in);

		// Step 2: Apply brightness (exposure compensation) in linear space (no clamping)
		const exposureStops = brightness.offset;
		linear = linear * Math.pow(2, exposureStops);

		// Step 3: Apply output gamma - raise to 1/gammaOut power
		let corrected = Math.pow(linear, 1.0 / gamma.out);

		// Note: Do NOT clamp here - allow values outside [0,1] for float images
		// Clamping will happen at display conversion time
		return corrected;
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

		// Auto-detect normalization range if needed
		let min = normalization.min;
		let max = normalization.max;

		if (normalization.autoNormalize) {
			min = Infinity;
			max = -Infinity;
			for (let i = 0; i < data.length; i++) {
				const value = data[i];
				if (!isNaN(value) && isFinite(value)) {
					if (value < min) min = value;
					if (value > max) max = value;
				}
			}

			// Update settings manager with detected range so UI reflects it
			if (this.settingsManager && this.settingsManager.settings.normalization) {
				this.settingsManager.settings.normalization.min = min;
				this.settingsManager.settings.normalization.max = max;
			}

			// Send detected range back to VS Code for status bar update
			if (this.vscode) {
				this.vscode.postMessage({
					type: 'stats',
					value: {
						min: min,
						max: max
					}
				});
			}
		}

		const range = max - min;
		if (range === 0) {
			// Avoid division by zero
			min = 0;
			max = 1;
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
						let normalized = (value - min) / (max - min);

						// Apply gamma and brightness corrections using the correct order
						normalized = this._applyGammaAndBrightness(normalized, gamma, brightness);

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
						r = (rVal - min) / (max - min);
						g = (gVal - min) / (max - min);
						b = (bVal - min) / (max - min);

						// Apply gamma and brightness corrections using the correct order
						r = this._applyGammaAndBrightness(r, gamma, brightness);
						g = this._applyGammaAndBrightness(g, gamma, brightness);
						b = this._applyGammaAndBrightness(b, gamma, brightness);

						// Clamp only for display conversion to 0-255 range
						r = Math.round(Math.max(0, Math.min(1, r)) * 255);
						g = Math.round(Math.max(0, Math.min(1, g)) * 255);
						b = Math.round(Math.max(0, Math.min(1, b)) * 255);
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
						r = (rVal - min) / (max - min);
						g = (gVal - min) / (max - min);
						b = (bVal - min) / (max - min);

						// Apply gamma and brightness corrections using the correct order
						r = this._applyGammaAndBrightness(r, gamma, brightness);
						g = this._applyGammaAndBrightness(g, gamma, brightness);
						b = this._applyGammaAndBrightness(b, gamma, brightness);

						// Clamp only for display conversion to 0-255 range
						r = Math.round(Math.max(0, Math.min(1, r)) * 255);
						g = Math.round(Math.max(0, Math.min(1, g)) * 255);
						b = Math.round(Math.max(0, Math.min(1, b)) * 255);

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
