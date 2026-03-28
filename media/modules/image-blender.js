// @ts-check
"use strict";

/**
 * Image Blender Module
 * Pure computation module for blending two or more images using mathematical operations.
 * No DOM or state management — takes typed arrays in, returns typed arrays out.
 */
export class ImageBlender {
	/**
	 * Available blend modes
	 */
	static MODES = /** @type {const} */ ({
		SUBTRACT: 'subtract',
		ADD: 'add',
		MULTIPLY: 'multiply',
		DIFFERENCE: 'difference',
		MASK: 'mask'
	});

	/**
	 * Blend two float arrays using the given mode.
	 * @param {Float32Array} baseData - Base image data (A)
	 * @param {Float32Array} overlayData - Overlay image data (B)
	 * @param {string} mode - Blend mode (subtract, add, multiply, difference, mask)
	 * @param {Object} [maskOptions] - Options for mask mode
	 * @param {number} [maskOptions.threshold=0.5] - Mask threshold
	 * @param {boolean} [maskOptions.filterHigher=true] - Filter values higher than threshold
	 * @returns {Float32Array} Blended result
	 */
	static blend(baseData, overlayData, mode, maskOptions) {
		if (baseData.length !== overlayData.length) {
			throw new Error(`Data length mismatch: base=${baseData.length}, overlay=${overlayData.length}`);
		}

		const result = new Float32Array(baseData.length);

		switch (mode) {
			case ImageBlender.MODES.SUBTRACT:
				ImageBlender._blendSubtract(baseData, overlayData, result);
				break;
			case ImageBlender.MODES.ADD:
				ImageBlender._blendAdd(baseData, overlayData, result);
				break;
			case ImageBlender.MODES.MULTIPLY:
				ImageBlender._blendMultiply(baseData, overlayData, result);
				break;
			case ImageBlender.MODES.DIFFERENCE:
				ImageBlender._blendDifference(baseData, overlayData, result);
				break;
			case ImageBlender.MODES.MASK:
				ImageBlender._blendMask(baseData, overlayData, result, maskOptions);
				break;
			default:
				throw new Error(`Unknown blend mode: ${mode}`);
		}

		return result;
	}

	/**
	 * Blend multiple overlays onto a base image in sequence.
	 * result = op(op(base, overlay1), overlay2)
	 * @param {Float32Array} baseData - Base image data
	 * @param {Array<{data: Float32Array, enabled: boolean}>} overlays - Overlay images
	 * @param {string} mode - Blend mode
	 * @param {Object} [maskOptions] - Options for mask mode
	 * @returns {Float32Array} Final blended result
	 */
	static blendMultiple(baseData, overlays, mode, maskOptions) {
		let result = baseData;
		let isFirstBlend = true;

		for (const overlay of overlays) {
			if (!overlay.enabled || !overlay.data) {
				continue;
			}

			if (isFirstBlend) {
				// First blend: blend base with first overlay
				result = ImageBlender.blend(result, overlay.data, mode, maskOptions);
				isFirstBlend = false;
			} else {
				// Subsequent blends: blend result with next overlay
				result = ImageBlender.blend(result, overlay.data, mode, maskOptions);
			}
		}

		// If no overlays were enabled, return a copy of the base
		if (isFirstBlend) {
			return new Float32Array(baseData);
		}

		return result;
	}

	/**
	 * Calculate min/max statistics of float data, ignoring NaN.
	 * @param {Float32Array} data
	 * @returns {{min: number, max: number}}
	 */
	static calculateStats(data) {
		let min = Infinity;
		let max = -Infinity;

		for (let i = 0; i < data.length; i++) {
			const val = data[i];
			if (Number.isFinite(val)) {
				if (val < min) min = val;
				if (val > max) max = val;
			}
		}

		return { min, max };
	}

	/**
	 * Render blended float data to RGBA ImageData.
	 * @param {Float32Array} data - Blended float data (single channel)
	 * @param {number} width - Image width
	 * @param {number} height - Image height
	 * @param {Object} options - Rendering options
	 * @param {string} [options.colormap='original'] - Colormap name: 'original', 'scaled', or a named colormap
	 * @param {number} [options.originalMin=0] - Min value when colormap='original'
	 * @param {number} [options.originalMax=1] - Max value when colormap='original'
	 * @param {boolean} [options.includeNegative=false] - Whether to include negative values
	 * @param {Object} [options.colormapConverter] - ColormapConverter instance for named colormaps
	 * @param {{r: number, g: number, b: number}} [options.nanColor] - Color for NaN pixels
	 * @returns {ImageData} Rendered RGBA image
	 */
	static renderToImageData(data, width, height, options = {}) {
		const {
			colormap = 'original',
			originalMin = 0,
			originalMax = 1,
			includeNegative = false,
			colormapConverter = null,
			nanColor = { r: 255, g: 0, b: 255 }
		} = options;

		const out = new Uint8ClampedArray(width * height * 4);

		// Determine normalization range
		let min, max;
		if (colormap === 'original') {
			min = originalMin;
			max = originalMax;
		} else if (colormap === 'scaled') {
			const stats = ImageBlender.calculateStats(data);
			min = stats.min;
			max = stats.max;
		} else {
			// Named colormap — auto-scale
			const stats = ImageBlender.calculateStats(data);
			min = stats.min;
			max = stats.max;
		}

		// Handle include negative: make range symmetric around 0
		if (includeNegative && min < 0) {
			const absMax = Math.max(Math.abs(min), Math.abs(max));
			min = -absMax;
			max = absMax;
		} else if (!includeNegative) {
			// Clamp min to 0 if not including negatives
			min = Math.max(0, min);
		}

		const range = max - min;
		const invRange = range > 0 ? 1.0 / range : 0;

		// Check if we should use a named colormap
		const useNamedColormap = colormap !== 'original' && colormap !== 'scaled' && colormap !== 'gray'
			&& colormapConverter && colormapConverter.colormaps && colormapConverter.colormaps[colormap];

		let colormapLUT = null;
		if (useNamedColormap) {
			colormapLUT = colormapConverter.colormaps[colormap];
		}

		for (let i = 0; i < width * height; i++) {
			const value = data[i];
			const p = i * 4;

			if (!Number.isFinite(value)) {
				out[p] = nanColor.r;
				out[p + 1] = nanColor.g;
				out[p + 2] = nanColor.b;
				out[p + 3] = 255;
				continue;
			}

			const normalized = Math.max(0, Math.min(1, (value - min) * invRange));

			if (colormapLUT) {
				// Use named colormap
				const idx = Math.round(normalized * 255);
				const [r, g, b] = colormapLUT[idx];
				out[p] = r;
				out[p + 1] = g;
				out[p + 2] = b;
			} else {
				// Grayscale
				const intensity = Math.round(normalized * 255);
				out[p] = intensity;
				out[p + 1] = intensity;
				out[p + 2] = intensity;
			}
			out[p + 3] = 255;
		}

		return new ImageData(out, width, height);
	}

	// --- Private blend implementations ---

	/** @private */
	static _blendSubtract(base, overlay, result) {
		for (let i = 0; i < base.length; i++) {
			const a = base[i];
			const b = overlay[i];
			if (!Number.isFinite(a) || !Number.isFinite(b)) {
				result[i] = NaN;
			} else {
				result[i] = a - b;
			}
		}
	}

	/** @private */
	static _blendAdd(base, overlay, result) {
		for (let i = 0; i < base.length; i++) {
			const a = base[i];
			const b = overlay[i];
			if (!Number.isFinite(a) || !Number.isFinite(b)) {
				result[i] = NaN;
			} else {
				result[i] = a + b;
			}
		}
	}

	/** @private */
	static _blendMultiply(base, overlay, result) {
		for (let i = 0; i < base.length; i++) {
			const a = base[i];
			const b = overlay[i];
			if (!Number.isFinite(a) || !Number.isFinite(b)) {
				result[i] = NaN;
			} else {
				result[i] = a * b;
			}
		}
	}

	/** @private */
	static _blendDifference(base, overlay, result) {
		for (let i = 0; i < base.length; i++) {
			const a = base[i];
			const b = overlay[i];
			if (!Number.isFinite(a) || !Number.isFinite(b)) {
				result[i] = NaN;
			} else {
				result[i] = Math.abs(a - b);
			}
		}
	}

	/** @private */
	static _blendMask(base, overlay, result, maskOptions = {}) {
		const threshold = maskOptions.threshold ?? 0.5;
		const filterHigher = maskOptions.filterHigher ?? true;

		for (let i = 0; i < base.length; i++) {
			const maskValue = overlay[i];
			const shouldFilter = filterHigher
				? maskValue > threshold
				: maskValue < threshold;

			if (shouldFilter || !Number.isFinite(base[i])) {
				result[i] = NaN;
			} else {
				result[i] = base[i];
			}
		}
	}
}
