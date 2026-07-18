"use strict";

/**
 * Colormap Converter Module
 *
 * "Decode" direction: recover scalar float values from a colormapped RGB image
 * (i.e. the inverse of applying a colormap). The forward colormaps and the fast
 * inverse RGB->index lookup live in the shared colormaps.js module, so this and
 * the render-time "apply" path stay consistent.
 */

import { COLORMAP_NAMES, rgbToColormapIndex } from './colormaps.js';

export class ColormapConverter {
	colormapNames: string[];

	constructor() {
		this.colormapNames = COLORMAP_NAMES;
	}

	/**
	 * Decode a colormapped image (RGBA ImageData) to float values.
	 * @param imageData - The source image data (true colors)
	 * @param colormapName - Name of the colormap used in the image
	 * @param minValue - Value mapped to the start of the colormap
	 * @param maxValue - Value mapped to the end of the colormap
	 * @param inverted - Whether the colormap was applied inverted
	 * @param logarithmic - Whether to use logarithmic mapping
	 * @returns Array of float values (one per pixel)
	 */
	convertToFloat(imageData: ImageData, colormapName: string, minValue: number, maxValue: number, inverted = false, logarithmic = false): Float32Array {
		return this.decodeRgb(
			imageData.data, imageData.width, imageData.height, 4,
			colormapName, minValue, maxValue, inverted, logarithmic
		);
	}

	/**
	 * Decode interleaved RGB(A) pixel data to float values.
	 * @param rgb - Interleaved pixel data (0-255)
	 * @param channels - Number of interleaved channels (3 for RGB, 4 for RGBA)
	 */
	decodeRgb(rgb: ArrayLike<number>, width: number, height: number, channels: number, colormapName: string, minValue: number, maxValue: number, inverted = false, logarithmic = false): Float32Array {
		if (this.colormapNames.indexOf(colormapName) === -1) {
			throw new Error(`Unknown colormap: ${colormapName}`);
		}

		const count = width * height;
		const floatData = new Float32Array(count);

		const useLog = logarithmic === true;
		const logMin = useLog ? Math.log10(Math.max(1e-10, Math.abs(minValue))) : 0;
		const logMax = useLog ? Math.log10(Math.max(1e-10, Math.abs(maxValue))) : 0;

		for (let i = 0; i < count; i++) {
			const o = i * channels;
			const r = rgb[o];
			const g = rgb[o + 1];
			const b = rgb[o + 2];

			let index = rgbToColormapIndex(colormapName, r, g, b);
			if (index < 0) { index = 0; }
			if (inverted) { index = 255 - index; }

			const t = index / 255.0; // normalized position along the colormap

			let value: number;
			if (useLog) {
				value = Math.pow(10, logMin + t * (logMax - logMin));
				if (minValue < 0 && maxValue < 0) {
					value = -value;
				} else if (minValue < 0) {
					// Mixed-sign range: fall back to linear interpolation
					value = minValue + t * (maxValue - minValue);
				}
			} else {
				value = minValue + t * (maxValue - minValue);
			}

			floatData[i] = value;
		}

		return floatData;
	}
}
