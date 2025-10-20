// @ts-check
"use strict";

/**
 * @typedef {Object} GeoTIFFGlobal
 * @property {function} fromArrayBuffer
 */

/**
 * @type {GeoTIFFGlobal}
 */
// @ts-ignore - GeoTIFF is loaded globally via script tag
const GeoTIFF = window.GeoTIFF;

/**
 * TIFF Processor Module
 * Handles TIFF image processing, normalization, and data extraction
 */
export class TiffProcessor {
	constructor(settingsManager, vscode) {
		this.settingsManager = settingsManager;
		this.vscode = vscode;
		this.rawTiffData = null;
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
	 * Process TIFF file from URL
	 * @param {string} src - TIFF file URL
	 * @returns {Promise<{canvas: HTMLCanvasElement, imageData: ImageData, tiffData: Object}>}
	 */
	async processTiff(src) {
		try {
			const response = await fetch(src);
			const buffer = await response.arrayBuffer();

			const tiff = await GeoTIFF.fromArrayBuffer(buffer);
			const image = await tiff.getImage();
			const sampleFormat = image.getSampleFormat();

			// Post format info to VS Code
			const width = image.getWidth();
			const height = image.getHeight();

			const fileDir = image.fileDirectory || {};
			const compression = fileDir.Compression || 'Unknown';
			const predictor = fileDir.Predictor;
			const photometricInterpretation = fileDir.PhotometricInterpretation;
			const planarConfig = fileDir.PlanarConfiguration;

			// Send format information to VS Code
			if (this.vscode) {
				// Determine if this is a float TIFF or int TIFF
				const showNormTiff = sampleFormat === 3; // 3 = IEEE floating point
				const formatType = showNormTiff ? 'tiff-float' : 'tiff-int';

				this.vscode.postMessage({
					type: 'formatInfo',
					value: {
						width: width,
						height: height,
						sampleFormat: sampleFormat,
						compression: compression,
						predictor: predictor,
						photometricInterpretation: photometricInterpretation,
						planarConfig: planarConfig,
						samplesPerPixel: image.getSamplesPerPixel(),
						bitsPerSample: image.getBitsPerSample(),
						formatType: formatType // For per-format settings
					}
				});
			}

			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;

			const rasters = await image.readRasters();
			const samplesPerPixel = image.getSamplesPerPixel();
			const bitsPerSample = image.getBitsPerSample();

			// Choose the correct typed array based on sample format and bits per sample
			let data;
			const showNormFormat = Array.isArray(sampleFormat) ? sampleFormat.includes(3) : sampleFormat === 3;
			if (showNormFormat) {
				data = new Float32Array(width * height * samplesPerPixel);
			} else if (bitsPerSample === 16) {
				data = new Uint16Array(width * height * samplesPerPixel);
			} else {
				data = new Uint8Array(width * height * samplesPerPixel);
			}

			// Store data properly based on samples per pixel
			if (samplesPerPixel === 1) {
				data.set(rasters[0]);
			} else {
				// Interleave the data: RGBRGBRGB...
				for (let i = 0; i < rasters[0].length; i++) {
					for (let j = 0; j < samplesPerPixel; j++) {
						data[i * samplesPerPixel + j] = rasters[j][i];
					}
				}
			}

			const imageData = await this.renderTiff(image, rasters);
			
			// Store TIFF data for pixel inspection and re-rendering
			this.rawTiffData = {
				image: image,
				rasters: rasters,
				ifd: {
					width,
					height,
					t339: Array.isArray(sampleFormat) ? sampleFormat[0] : sampleFormat, // SampleFormat
					t277: samplesPerPixel, // SamplesPerPixel
					t284: 1, // PlanarConfiguration (chunky)
					t258: bitsPerSample // BitsPerSample
				},
				data: data
			};

			return { canvas, imageData, tiffData: this.rawTiffData };
		} catch (error) {
			console.error('Error processing TIFF:', error);
			throw error;
		}
	}

	/**
	 * Render TIFF data to ImageData with current settings
	 * @param {*} image - GeoTIFF image object
	 * @param {*} rasters - Raster data
	 * @returns {Promise<ImageData>}
	 */
	async renderTiffWithSettings(image, rasters) {
		// Create copies of rasters to avoid modifying the original data
		const rastersCopy = [];
		for (let i = 0; i < rasters.length; i++) {
			rastersCopy.push(new Float32Array(rasters[i]));
		}

		// Apply mask filtering if enabled
		const settings = this.settingsManager.settings;
		if (settings.maskFilters && settings.maskFilters.length > 0) {
			try {
				// Apply all enabled masks in sequence
				for (const maskFilter of settings.maskFilters) {
					if (maskFilter.enabled && maskFilter.maskUri) {
						const maskData = await this.loadMaskImage(maskFilter.maskUri);
						// Apply mask filter to each band
						for (let band = 0; band < rastersCopy.length; band++) {
							const filteredData = this.applyMaskFilter(
								rastersCopy[band],
								maskData,
								maskFilter.threshold,
								maskFilter.filterHigher
							);
							rastersCopy[band] = filteredData;
						}
					}
				}
			} catch (error) {
				console.error('Error applying mask filters:', error);
				// Continue without mask filtering if there's an error
			}
		}

		const width = image.getWidth();
		const height = image.getHeight();
		const sampleFormat = image.getSampleFormat();
		const bitsPerSample = image.getBitsPerSample();

		let min = Infinity;
		let max = -Infinity;

		let imageDataArray;

		// Calculate min/max from the first 3 channels only (like original code)
		const displayRasters = [];
		for (let i = 0; i < rastersCopy.length; i++) {
			displayRasters.push(new Float32Array(rastersCopy[i]));
		}

		// Use the first 3 channels to determine the image stats
		// For RGB-as-24bit mode, calculate stats from combined 24-bit values
		if (settings.rgbAs24BitGrayscale && rastersCopy.length >= 3) {
			console.log(`[TiffProcessor] Computing 24-bit stats from ${rastersCopy[0].length} pixels`);
			// Calculate min/max of combined 24-bit values
			for (let j = 0; j < rastersCopy[0].length; j++) {
				// Get RGB values and normalize to 0-255 range
				const values = [];
				for (let i = 0; i < 3; i++) {
					const value = rastersCopy[i][j];
					if (!isNaN(value) && isFinite(value)) {
						values.push(Math.round(Math.max(0, Math.min(255, value))));
					} else {
						values.push(0);
					}
				}
				// Combine into 24-bit value
				const combined24bit = (values[0] << 16) | (values[1] << 8) | values[2];
				if (j === 0) {
					console.log(`[TiffProcessor] First pixel 24-bit stats: R=${values[0]}, G=${values[1]}, B=${values[2]}, combined=${combined24bit}`);
				}
				min = Math.min(min, combined24bit);
				max = Math.max(max, combined24bit);
			}
			console.log(`[TiffProcessor] 24-bit stats: min=${min}, max=${max}`);
		} else {
			// Normal mode: use individual channel values
			for (let i = 0; i < Math.min(rastersCopy.length, 3); i++) {
				for (let j = 0; j < rastersCopy[i].length; j++) {
					const value = rastersCopy[i][j];
					if (!isNaN(value) && isFinite(value)) {
						min = Math.min(min, value);
						max = Math.max(max, value);
					}
				}
			}
		}

		// Send stats to VS Code
		if (this.vscode) {
			this.vscode.postMessage({ type: 'stats', value: { min, max } });
		}

		// Get normalization settings
		let normMin, normMax;

		if (settings.normalization.autoNormalize) {
			// Auto-normalize: use actual image min/max
			normMin = min;
			normMax = max;
		} else if (settings.normalization.gammaMode) {
			// Gamma mode normalization range depends on data type
			const showNorm = Array.isArray(sampleFormat) ? sampleFormat.includes(3) : sampleFormat === 3;
			if (showNorm) {
				// Float TIFFs: normalize to 0-1 range (floats are typically already in 0-1 range)
				normMin = 0;
				normMax = 1;
			} else {
				// Integer TIFFs: normalize to type's maximum value
				normMin = 0;
				if (bitsPerSample === 16) {
					normMax = 65535;
				} else {
					normMax = 255;
				}
			}
		} else {
			// Manual mode: use user-specified range
			normMin = settings.normalization.min;
			normMax = settings.normalization.max;

			// If normalized float mode is enabled for uint images, interpret the range as 0-1
			const showNorm = Array.isArray(sampleFormat) ? sampleFormat.includes(3) : sampleFormat === 3;
			if (settings.normalizedFloatMode && !showNorm) {
				// Multiply by type's maximum value
				const typeMax = bitsPerSample === 16 ? 65535 : 255;
				normMin = normMin * typeMax;
				normMax = normMax * typeMax;
				console.log(`[TiffProcessor] Normalized float mode: converting range [${settings.normalization.min}, ${settings.normalization.max}] to [${normMin}, ${normMax}]`);
			}
		}

		// Normalize and create image data
		const showNorm = Array.isArray(sampleFormat) ? sampleFormat.includes(3) : sampleFormat === 3;
		console.log(`[TiffProcessor] Detected float: ${showNorm}, sampleFormat:`, sampleFormat);

		if (showNorm) { // Float data
			imageDataArray = this._processFloatTiff(displayRasters, width, height, normMin, normMax, settings);
		} else {
			// Pass normalization parameters to integer TIFF processing too
			imageDataArray = this._processIntegerTiff(displayRasters, width, height, normMin, normMax, settings, bitsPerSample);
		}

		return new ImageData(imageDataArray, width, height);
	}

	/**
	 * Render TIFF data to ImageData
	 * @param {*} image - GeoTIFF image object
	 * @param {*} rasters - Raster data
	 * @returns {Promise<ImageData>}
	 */
	async renderTiff(image, rasters) {
		// Apply mask filtering if enabled
		const settings = this.settingsManager.settings;
		if (settings.maskFilters && settings.maskFilters.length > 0) {
			try {
				// Apply all enabled masks in sequence
				for (const maskFilter of settings.maskFilters) {
					if (maskFilter.enabled && maskFilter.maskUri) {
						const maskData = await this.loadMaskImage(maskFilter.maskUri);
						const maskWidth = image.getWidth();
						const maskHeight = image.getHeight();
						
						// Apply mask filter to each band
						for (let band = 0; band < rasters.length; band++) {
							const originalData = new Float32Array(rasters[band]);
							const filteredData = this.applyMaskFilter(
								originalData, 
								maskData, 
								maskFilter.threshold, 
								maskFilter.filterHigher
							);
							rasters[band] = filteredData;
						}
					}
				}
			} catch (error) {
				console.error('Error applying mask filters:', error);
				// Continue without mask filtering if there's an error
			}
		}
		
		const width = image.getWidth();
		const height = image.getHeight();
		const sampleFormat = image.getSampleFormat();
		const bitsPerSample = image.getBitsPerSample();

		let min = Infinity;
		let max = -Infinity;

		let imageDataArray;

		// Calculate min/max from the first 3 channels only (like original code)
		const displayRasters = [];
		for (let i = 0; i < rasters.length; i++) {
			displayRasters.push(new Float32Array(rasters[i]));
		}

		// Use the first 3 channels to determine the image stats
		// For RGB-as-24bit mode, calculate stats from combined 24-bit values
		if (settings.rgbAs24BitGrayscale && rasters.length >= 3) {
			// Calculate min/max of combined 24-bit values
			for (let j = 0; j < rasters[0].length; j++) {
				// Get RGB values and normalize to 0-255 range
				const values = [];
				for (let i = 0; i < 3; i++) {
					const value = rasters[i][j];
					if (!isNaN(value) && isFinite(value)) {
						values.push(Math.round(Math.max(0, Math.min(255, value))));
					} else {
						values.push(0);
					}
				}
				// Combine into 24-bit value
				const combined24bit = (values[0] << 16) | (values[1] << 8) | values[2];
				min = Math.min(min, combined24bit);
				max = Math.max(max, combined24bit);
			}
		} else {
			// Normal mode: use individual channel values
			for (let i = 0; i < Math.min(rasters.length, 3); i++) {
				for (let j = 0; j < rasters[i].length; j++) {
					const value = rasters[i][j];
					if (!isNaN(value) && isFinite(value)) {
						min = Math.min(min, value);
						max = Math.max(max, value);
					}
				}
			}
		}

		// Send stats to VS Code
		if (this.vscode) {
			this.vscode.postMessage({ type: 'stats', value: { min, max } });
		}

		// Get normalization settings (settings already declared above)
		let normMin, normMax;

		if (settings.normalization.autoNormalize) {
			// Auto-normalize: use actual image min/max
			normMin = min;
			normMax = max;
		} else if (settings.normalization.gammaMode) {
			// Gamma mode normalization range depends on data type
			const showNorm = Array.isArray(sampleFormat) ? sampleFormat.includes(3) : sampleFormat === 3;
			if (showNorm) {
				// Float TIFFs: normalize to 0-1 range (floats are typically already in 0-1 range)
				normMin = 0;
				normMax = 1;
			} else {
				// Integer TIFFs: normalize to type's maximum value
				normMin = 0;
				if (bitsPerSample === 16) {
					normMax = 65535;
				} else {
					normMax = 255;
				}
			}
		} else {
			// Manual mode: use user-specified range
			normMin = settings.normalization.min;
			normMax = settings.normalization.max;

			// If normalized float mode is enabled for uint images, interpret the range as 0-1
			const showNorm = Array.isArray(sampleFormat) ? sampleFormat.includes(3) : sampleFormat === 3;
			if (settings.normalizedFloatMode && !showNorm) {
				// Multiply by type's maximum value
				const typeMax = bitsPerSample === 16 ? 65535 : 255;
				normMin = normMin * typeMax;
				normMax = normMax * typeMax;
				console.log(`[TiffProcessor] Normalized float mode: converting range [${settings.normalization.min}, ${settings.normalization.max}] to [${normMin}, ${normMax}]`);
			}
		}

		// Normalize and create image data
		const showNorm = Array.isArray(sampleFormat) ? sampleFormat.includes(3) : sampleFormat === 3;
		console.log(`[TiffProcessor] Detected float: ${showNorm}, sampleFormat:`, sampleFormat);

		if (showNorm) { // Float data
			imageDataArray = this._processFloatTiff(displayRasters, width, height, normMin, normMax, settings);
		} else {
			// Pass normalization parameters to integer TIFF processing too
			imageDataArray = this._processIntegerTiff(displayRasters, width, height, normMin, normMax, settings, bitsPerSample);
		}

		return new ImageData(imageDataArray, width, height);
	}

	/**
	 * Process float TIFF data
	 * @private
	 */
	_processFloatTiff(rasters, width, height, normMin, normMax, settings) {
		const imageDataArray = new Uint8ClampedArray(width * height * 4);
		const numBands = rasters.length;
		const range = normMax - normMin;
		const nanColor = this._getNanColor(settings);

		console.log(`[TiffProcessor] _processFloatTiff: numBands=${numBands}, rgbAs24BitGrayscale=${settings.rgbAs24BitGrayscale}`);

		for (let i = 0; i < width * height; i++) {
			let r, g, b;

			// Check if any band has NaN values
			let hasNaN = false;
			for (let band = 0; band < Math.min(3, numBands); band++) {
				if (isNaN(rasters[band][i])) {
					hasNaN = true;
					break;
				}
			}

			if (hasNaN) {
				// Use NaN color for this pixel
				r = nanColor.r;
				g = nanColor.g;
				b = nanColor.b;
			} else if (numBands === 1) {
				// Grayscale
				const value = rasters[0][i];
				let normalized;
				if (range > 0) {
					normalized = (value - normMin) / range;
				} else {
					normalized = 0; // Handle case where min === max
				}
				normalized = this.clamp(normalized, 0, 1);

				// Apply gamma and brightness corrections
				if (settings.normalization.gammaMode) {
					normalized = this._applyGammaAndBrightness(normalized, settings);
				}

				const displayValue = Math.round(normalized * 255);
				r = g = b = displayValue;
			} else if (settings.rgbAs24BitGrayscale && numBands >= 3) {
				// RGB as 24-bit grayscale: Combine RGB channels into single 24-bit value
				// First normalize each channel to 0-255 range, then combine
				const values = [];
				for (let band = 0; band < 3; band++) {
					let value = rasters[band][i];
					let normalized;
					if (range > 0) {
						normalized = (value - normMin) / range;
					} else {
						normalized = 0;
					}
					normalized = this.clamp(normalized, 0, 1);
					values.push(Math.round(normalized * 255));
				}

				// Combine into 24-bit value: (R << 16) | (G << 8) | B
				const combined24bit = (values[0] << 16) | (values[1] << 8) | values[2];
				// Max value is 16777215 (0xFFFFFF)

				// Normalize 24-bit value to 0-1 range for display
				// NOTE: For gamma mode, this should use 0-16777215 as the expected range
				// For auto-normalize, it should use the actual min/max of combined values
				let normalized24 = combined24bit / 16777215.0;

				// Apply gamma and brightness to the combined value
				if (settings.normalization.gammaMode) {
					normalized24 = this._applyGammaAndBrightness(normalized24, settings);
				}

				// Display as grayscale
				const displayValue = Math.round(normalized24 * 255);
				r = g = b = displayValue;
			} else {
				// RGB or multi-band (normal mode)
				const values = [];
				for (let band = 0; band < Math.min(3, numBands); band++) {
					let value = rasters[band][i];
					let normalized;
					if (range > 0) {
						normalized = (value - normMin) / range;
					} else {
						normalized = 0; // Handle case where min === max
					}
					normalized = this.clamp(normalized, 0, 1);

					if (settings.normalization.gammaMode) {
						normalized = this._applyGammaAndBrightness(normalized, settings);
					}

					values.push(Math.round(normalized * 255));
				}

				r = values[0] ?? 0;
				g = values[1] ?? 0;
				b = values[2] ?? 0;
			}

			const pixelIndex = i * 4;
			imageDataArray[pixelIndex] = r;
			imageDataArray[pixelIndex + 1] = g;
			imageDataArray[pixelIndex + 2] = b;
			imageDataArray[pixelIndex + 3] = 255; // Alpha
		}

		return imageDataArray;
	}

	/**
	 * Process integer TIFF data
	 * @private
	 */
	_processIntegerTiff(rasters, width, height, normMin, normMax, settings, bitsPerSample) {
		const imageDataArray = new Uint8ClampedArray(width * height * 4);
		const numBands = rasters.length;
		const nanColor = this._getNanColor(settings);

		// Use normalization settings (normMin/normMax are already calculated based on mode)
		const range = normMax - normMin;

		for (let i = 0; i < width * height; i++) {
			let r, g, b;

			// Check if any band has NaN values
			let hasNaN = false;
			for (let band = 0; band < Math.min(3, numBands); band++) {
				if (isNaN(rasters[band][i])) {
					hasNaN = true;
					break;
				}
			}

			if (hasNaN) {
				// Use NaN color for this pixel
				r = nanColor.r;
				g = nanColor.g;
				b = nanColor.b;
			} else if (numBands === 1) {
				let value = rasters[0][i];

				// Apply normalization based on settings (auto/gamma/manual)
				let normalized;
				if (range > 0) {
					normalized = (value - normMin) / range;
				} else {
					normalized = 0; // Handle case where min === max
				}
				normalized = this.clamp(normalized, 0, 1);

				// Apply gamma and brightness corrections
				if (settings.normalization.gammaMode || this._shouldApplyGammaBrightnessToUint(settings)) {
					normalized = this._applyGammaAndBrightness(normalized, settings);
				}

				value = Math.round(normalized * 255); // Convert to 8-bit for display
				r = g = b = this.clamp(value, 0, 255);
			} else if (settings.rgbAs24BitGrayscale && numBands >= 3) {
				// RGB as 24-bit grayscale: Combine RGB channels into single 24-bit value
				// Get raw RGB values (these are already in their native type range, e.g., 0-255 for uint8)
				const values = [];
				for (let band = 0; band < 3; band++) {
					let value = rasters[band][i];
					// Clamp to valid 8-bit range (rasters should already be in native range)
					values.push(this.clamp(Math.round(value), 0, 255));
				}

				// Combine into 24-bit value: (R << 16) | (G << 8) | B
				const combined24bit = (values[0] << 16) | (values[1] << 8) | values[2];
				// Max value is 16777215 (0xFFFFFF)

				// Debug logging for first pixel
				if (i === 0) {
					console.log(`[TiffProcessor] 24-bit mode - First pixel: R=${values[0]}, G=${values[1]}, B=${values[2]}`);
					console.log(`[TiffProcessor] Combined 24-bit value: ${combined24bit}`);
					console.log(`[TiffProcessor] Normalization range: [${normMin}, ${normMax}]`);
				}

				// Now normalize the combined 24-bit value using the normalization settings
				// For 24-bit mode, normMin/normMax should be in the range [0, 16777215]
				let normalized24;
				const norm24Range = normMax - normMin;
				if (norm24Range > 0) {
					normalized24 = (combined24bit - normMin) / norm24Range;
				} else {
					normalized24 = 0;
				}
				normalized24 = this.clamp(normalized24, 0, 1);

				// Apply gamma/brightness to the combined value
				if (settings.normalization.gammaMode || this._shouldApplyGammaBrightnessToUint(settings)) {
					normalized24 = this._applyGammaAndBrightness(normalized24, settings);
				}

				// Display as grayscale
				const displayValue = Math.round(normalized24 * 255);

				// Debug logging for first pixel
				if (i === 0) {
					console.log(`[TiffProcessor] Normalized: ${normalized24}, Display value: ${displayValue}`);
				}

				r = g = b = this.clamp(displayValue, 0, 255);
			} else {
				const values = [];
				for (let band = 0; band < Math.min(3, numBands); band++) {
					let value = rasters[band][i];

					// Apply normalization based on settings
					let normalized;
					if (range > 0) {
						normalized = (value - normMin) / range;
					} else {
						normalized = 0;
					}
					normalized = this.clamp(normalized, 0, 1);

					// Apply gamma/brightness
					if (settings.normalization.gammaMode || this._shouldApplyGammaBrightnessToUint(settings)) {
						normalized = this._applyGammaAndBrightness(normalized, settings);
					}

					value = Math.round(normalized * 255); // Convert to 8-bit for display
					values.push(this.clamp(value, 0, 255));
				}

				r = values[0] ?? 0;
				g = values[1] ?? 0;
				b = values[2] ?? 0;
			}

			const pixelIndex = i * 4;
			imageDataArray[pixelIndex] = r;
			imageDataArray[pixelIndex + 1] = g;
			imageDataArray[pixelIndex + 2] = b;
			imageDataArray[pixelIndex + 3] = 255; // Alpha
		}

		return imageDataArray;
	}

	/**
	 * Apply gamma and brightness corrections
	 * The correct order is: remove input gamma → apply brightness → apply output gamma
	 * @private
	 */
	_applyGammaAndBrightness(normalizedValue, settings) {
		const gammaIn = settings.gamma.in;
		const gammaOut = settings.gamma.out;

		// Step 1: Remove input gamma (linearize) - raise to gammaIn power
		let linear = Math.pow(normalizedValue, gammaIn);

		// Step 2: Apply brightness (exposure compensation) in linear space
		const exposureStops = settings.brightness.offset;
		linear = linear * Math.pow(2, exposureStops);

		// Step 3: Apply output gamma - raise to 1/gammaOut power
		let corrected = Math.pow(linear, 1.0 / gammaOut);

		return this.clamp(corrected, 0, 1);
	}

	/**
	 * Check if gamma/brightness should be applied to uint images
	 * Only apply if gamma mode is enabled OR values are significantly different from defaults
	 * @private
	 */
	_shouldApplyGammaBrightnessToUint(settings) {
		// If gamma mode is explicitly enabled, always apply gamma/brightness
		if (settings.normalization && settings.normalization.gammaMode) {
			return true;
		}

		// Do NOT apply gamma/brightness in auto-normalize mode
		if (settings.normalization && settings.normalization.autoNormalize) {
			return false;
		}

		// Check if gamma is significantly different from 1.0 (no correction)
		const gammaRatio = settings.gamma.in / settings.gamma.out;
		const hasGammaCorrection = Math.abs(gammaRatio - 1.0) > 0.01;

		// Check if brightness is significantly different from 0 (no adjustment)
		const hasBrightnessCorrection = Math.abs(settings.brightness.offset) > 0.01;

		return hasGammaCorrection || hasBrightnessCorrection;
	}

	/**
	 * Load mask image for filtering
	 * @param {string} maskSrc - Mask TIFF file URL
	 * @returns {Promise<Float32Array>}
	 */
	async loadMaskImage(maskSrc) {
		try {
			const response = await fetch(maskSrc);
			const buffer = await response.arrayBuffer();
			const tiff = await GeoTIFF.fromArrayBuffer(buffer);
			const image = await tiff.getImage();
			const rasters = await image.readRasters();
			
			// Return the first band as a Float32Array
			return new Float32Array(rasters[0]);
		} catch (error) {
			console.error('Error loading mask image:', error);
			throw error;
		}
	}

	/**
	 * Apply mask filtering to image data
	 * @param {Float32Array} imageData - Original image data
	 * @param {Float32Array} maskData - Mask data
	 * @param {number} threshold - Threshold value
	 * @param {boolean} filterHigher - Whether to filter higher or lower values
	 * @returns {Float32Array} - Filtered image data
	 */
	applyMaskFilter(imageData, maskData, threshold, filterHigher) {
		const filteredData = new Float32Array(imageData.length);
		
		for (let i = 0; i < imageData.length; i++) {
			const maskValue = maskData[i];
			const imageValue = imageData[i];
			
			let shouldFilter = false;
			if (filterHigher) {
				shouldFilter = maskValue > threshold;
			} else {
				shouldFilter = maskValue < threshold;
			}
			
			if (shouldFilter) {
				filteredData[i] = NaN;
			} else {
				filteredData[i] = imageValue;
			}
		}
		
		return filteredData;
	}

	/**
	 * Get color at specific pixel coordinates
	 * @param {number} x
	 * @param {number} y
	 * @param {number} naturalWidth
	 * @param {number} naturalHeight
	 * @returns {string}
	 */
	getColorAtPixel(x, y, naturalWidth, naturalHeight) {
		if (!this.rawTiffData) {
			return '';
		}

		const ifd = this.rawTiffData.ifd;
		const data = this.rawTiffData.data;
		const pixelIndex = y * naturalWidth + x;
		const format = ifd.t339; // SampleFormat
		const samples = ifd.t277;
		const planarConfig = ifd.t284;
		const bitsPerSample = ifd.t258;
		const settings = this.settingsManager.settings;

		console.log(`[TiffProcessor] getColorAtPixel: rgbAs24BitGrayscale=${settings.rgbAs24BitGrayscale}, normalizedFloatMode=${settings.normalizedFloatMode}, samples=${samples}, format=${format}`);

		if (samples === 1) { // Grayscale
			const value = data[pixelIndex];

			// Check if normalized float mode is enabled for uint images
			if (settings.normalizedFloatMode && format !== 3) {
				// Convert uint to normalized float (0-1)
				const maxValue = bitsPerSample === 16 ? 65535 : 255;
				const normalized = value / maxValue;
				return normalized.toPrecision(4);
			}

			return format === 3 ? value.toPrecision(4) : value.toString();
		} else if (samples >= 3) {
			const values = [];
			if (planarConfig === 2) { // Planar data
				const planeSize = naturalWidth * naturalHeight;
				for (let i = 0; i < samples; i++) {
					const value = data[pixelIndex + i * planeSize];
					values.push(format === 3 ? value.toPrecision(4) : value.toString().padStart(3, '0'));
				}
			} else { // Interleaved data
				for (let i = 0; i < samples; i++) {
					const value = data[pixelIndex * samples + i];
					values.push(format === 3 ? value.toPrecision(4) : value.toString().padStart(3, '0'));
				}
			}

			// If RGB as 24-bit grayscale is enabled, show combined value
			if (settings.rgbAs24BitGrayscale && samples >= 3) {
				// Convert string values back to numbers for calculation
				const r = parseInt(values[0]);
				const g = parseInt(values[1]);
				const b = parseInt(values[2]);
				// Combine into 24-bit value: (R << 16) | (G << 8) | B
				const combined24bit = (r << 16) | (g << 8) | b;

				// Apply scale factor for display
				const scaleFactor = settings.scale24BitFactor || 1000;
				const scaledValue = (combined24bit / scaleFactor).toFixed(3);

				console.log(`[TiffProcessor] getColorAtPixel: R=${r}, G=${g}, B=${b}, combined=${combined24bit}, scaled=${scaledValue}`);
				return scaledValue;
			}

			if (format === 3) {
				return values.join(' ');
			} else {
				return values.slice(0, 3).join(' ');
			}
		}

		return '';
	}

	/**
	 * Fast parameter update - DISABLED to prevent double-correction
	 * We always re-render from raw TIFF data to ensure correct gamma/brightness application
	 * @param {ImageData} existingImageData - Current image data
	 * @returns {Promise<ImageData|null>} - Always returns null to force full re-render
	 */
	async fastParameterUpdate(existingImageData) {
		// Fast update is disabled because it causes double-application of corrections
		// and produces incorrect results (white/black flash, wrong colors).
		// Always return null to force a full re-render from raw TIFF data.
		console.log('Fast update disabled - will re-render from raw TIFF data');
		return null;
	}
} 