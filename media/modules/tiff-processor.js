// @ts-check
"use strict";
import { NormalizationHelper } from './normalization-helper.js';

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
		this._pendingRenderData = null; // Store data waiting for format-specific settings
		this._isInitialLoad = true; // Track if this is the first render
		this._maskCache = new Map(); // Cache loaded mask images by URI
		this._lastImageData = null; // Store the last rendered image data for fast parameter updates
		this._lastStatistics = null; // Cache min/max statistics
		/** @type {{ floatData: Float32Array } | null} */
		this._convertedFloatData = null; // Cache converted float data for analysis
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
	/**
	 * Get NaN color from settings
	 * @param {any} settings - Settings object
	 * @returns {{r: number, g: number, b: number}}
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

			// Send format information to VS Code BEFORE rendering
			// This allows the extension to apply format-specific settings first
			if (this.vscode && this._isInitialLoad) {
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
						formatType: formatType, // For per-format settings
						isInitialLoad: true // Signal that this is the first load
					}
				});

				// Store pending render data - will render when settings are updated
				this._pendingRenderData = { image, rasters };

				// Return placeholder - actual rendering happens when settings update
				const placeholderImageData = new ImageData(width, height);
				return { canvas, imageData: placeholderImageData, tiffData: this.rawTiffData };
			}

			// Non-initial loads or if no vscode (render immediately)
			const imageData = await this.renderTiff(image, rasters);
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

		let min, max;

		// Lazy stats calculation: skip in gamma mode, use cache or compute
		if (settings.normalization.gammaMode === true) {
			// Gamma mode: use fixed range based on bit depth
			const showNorm = Array.isArray(sampleFormat) ? sampleFormat.includes(3) : sampleFormat === 3;
			min = 0;
			if (showNorm) {
				max = 1.0; // Float TIFFs
			} else if (bitsPerSample === 16) {
				max = 65535;
			} else {
				max = 255;
			}
		} else if (this._lastStatistics) {
			// Reuse cached statistics if available
			min = this._lastStatistics.min;
			max = this._lastStatistics.max;
		} else {
			// Compute min/max for the first time
			min = Infinity;
			max = -Infinity;

			// Use the first 3 channels to determine the image stats
			// For RGB-as-24bit mode, calculate stats from combined 24-bit values
			if (settings.rgbAs24BitGrayscale && rastersCopy.length >= 3) {
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
					min = Math.min(min, combined24bit);
					max = Math.max(max, combined24bit);
				}
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

			// Cache the statistics
			this._lastStatistics = { min, max };
		}

		// Send stats to VS Code
		if (this.vscode) {
			this.vscode.postMessage({ type: 'stats', value: { min, max } });
		}

		// Get normalization settings using NormalizationHelper
		const showNorm = Array.isArray(sampleFormat) ? sampleFormat.includes(3) : sampleFormat === 3;
		const typeMax = showNorm ? 1.0 : (bitsPerSample === 16 ? 65535 : 255);

		const { min: normMin, max: normMax } = NormalizationHelper.getNormalizationRange(
			settings,
			{ min, max },
			typeMax,
			showNorm
		);

		// Normalize and create image data
		let imageDataArray;

		if (showNorm) { // Float data
			imageDataArray = this._processFloatTiff(rastersCopy, width, height, normMin, normMax, settings);
		} else {
			// Pass normalization parameters to integer TIFF processing too
			imageDataArray = this._processIntegerTiff(rastersCopy, width, height, normMin, normMax, settings, bitsPerSample);
		}

		return new ImageData(imageDataArray, width, height);
	}

	/**
	 * Fast render TIFF data with current settings (skips mask loading and uses cached statistics)
	 * @param {*} image - GeoTIFF image object
	 * @param {*} rasters - Raster data
	 * @param {boolean} skipMasks - Whether to skip mask filtering
	 * @returns {Promise<ImageData>}
	 */
	async renderTiffWithSettingsFast(image, rasters, skipMasks = true) {
		// Create copies of rasters to avoid modifying the original data
		const rastersCopy = [];
		for (let i = 0; i < rasters.length; i++) {
			rastersCopy.push(new Float32Array(rasters[i]));
		}

		const settings = this.settingsManager.settings;
		const width = image.getWidth();
		const height = image.getHeight();
		const sampleFormat = image.getSampleFormat();
		const bitsPerSample = image.getBitsPerSample();

		let min, max;

		// Use cached statistics if available, otherwise recalculate
		if (this._lastStatistics && !settings.normalization.autoNormalize) {
			min = this._lastStatistics.min;
			max = this._lastStatistics.max;
		} else {
			// Recalculate statistics (needed for auto-normalize)
			min = Infinity;
			max = -Infinity;

			const displayRasters = [];
			for (let i = 0; i < rastersCopy.length; i++) {
				displayRasters.push(new Float32Array(rastersCopy[i]));
			}

			// Calculate min/max from the first 3 channels only
			if (settings.rgbAs24BitGrayscale && rastersCopy.length >= 3) {
				for (let j = 0; j < rastersCopy[0].length; j++) {
					const values = [];
					for (let i = 0; i < 3; i++) {
						const value = rastersCopy[i][j];
						if (!isNaN(value) && isFinite(value)) {
							values.push(Math.round(Math.max(0, Math.min(255, value))));
						} else {
							values.push(0);
						}
					}
					const combined24bit = (values[0] << 16) | (values[1] << 8) | values[2];
					min = Math.min(min, combined24bit);
					max = Math.max(max, combined24bit);
				}
			} else {
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

			// Cache the statistics
			this._lastStatistics = { min, max };

			// Send stats to VS Code
			if (this.vscode) {
				this.vscode.postMessage({ type: 'stats', value: { min, max } });
			}
		}

		// Get normalization settings
		let normMin, normMax;

		if (settings.normalization.autoNormalize) {
			normMin = min;
			normMax = max;
		} else if (settings.normalization.gammaMode) {
			const showNorm = Array.isArray(sampleFormat) ? sampleFormat.includes(3) : sampleFormat === 3;
			if (showNorm) {
				normMin = 0;
				normMax = 1;
			} else {
				normMin = 0;
				if (bitsPerSample === 16) {
					normMax = 65535;
				} else {
					normMax = 255;
				}
			}
		} else {
			normMin = settings.normalization.min;
			normMax = settings.normalization.max;

			const showNorm = Array.isArray(sampleFormat) ? sampleFormat.includes(3) : sampleFormat === 3;
			if (settings.normalizedFloatMode && !showNorm) {
				const typeMax = bitsPerSample === 16 ? 65535 : 255;
				normMin = normMin * typeMax;
				normMax = normMax * typeMax;
			}
		}

		// Create display rasters
		const displayRasters = [];
		for (let i = 0; i < rastersCopy.length; i++) {
			displayRasters.push(new Float32Array(rastersCopy[i]));
		}

		// Normalize and create image data
		const showNorm = Array.isArray(sampleFormat) ? sampleFormat.includes(3) : sampleFormat === 3;

		let imageDataArray;
		if (showNorm) {
			imageDataArray = this._processFloatTiff(displayRasters, width, height, normMin, normMax, settings);
		} else {
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
		const showNorm = Array.isArray(sampleFormat) ? sampleFormat.includes(3) : sampleFormat === 3;
		const typeMax = bitsPerSample === 16 ? 65535 : 255;

		// Use NormalizationHelper to calculate range
		// For float images (showNorm=true), typeMax is 1.0
		const { min: normMin, max: normMax } = NormalizationHelper.getNormalizationRange(
			settings,
			{ min, max },
			showNorm ? 1.0 : typeMax,
			showNorm
		);

		// Normalize and create image data
		// showNorm is already defined above

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
	 * @param {any[]} rasters - Raster data
	 * @param {number} width - Image width
	 * @param {number} height - Image height
	 * @param {number} normMin - Normalization minimum
	 * @param {number} normMax - Normalization maximum
	 * @param {any} settings - Settings object
	 * @returns {Uint8ClampedArray}
	 */
	_processFloatTiff(rasters, width, height, normMin, normMax, settings) {
		const imageDataArray = new Uint8ClampedArray(width * height * 4);
		const numBands = rasters.length;
		const range = normMax - normMin;
		const nanColor = this._getNanColor(settings);

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

				// Apply gamma and brightness corrections (may result in values outside [0,1])
				if (settings.normalization.gammaMode) {
					normalized = NormalizationHelper.applyGammaAndBrightness(normalized, settings);
				}

				// Clamp only for display conversion to 0-255 range
				const displayValue = Math.round(Math.max(0, Math.min(1, normalized)) * 255);
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
					values.push(Math.round(Math.max(0, Math.min(1, normalized)) * 255));
				}

				// Combine into 24-bit value: (R << 16) | (G << 8) | B
				const combined24bit = (values[0] << 16) | (values[1] << 8) | values[2];
				// Max value is 16777215 (0xFFFFFF)

				// Normalize 24-bit value to 0-1 range for display
				// NOTE: For gamma mode, this should use 0-16777215 as the expected range
				// For auto-normalize, it should use the actual min/max of combined values
				let normalized24 = combined24bit / 16777215.0;

				// Apply gamma and brightness to the combined value (may result in values outside [0,1])
				if (settings.normalization.gammaMode) {
					normalized24 = NormalizationHelper.applyGammaAndBrightness(normalized24, settings);
				}

				// Display as grayscale (clamp only for display conversion)
				const displayValue = Math.round(Math.max(0, Math.min(1, normalized24)) * 255);
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

					// Apply gamma and brightness corrections (may result in values outside [0,1])
					// Only if gamma mode is enabled (and not auto-normalize, though helper handles that check if we pass settings correctly)
					// Actually, NormalizationHelper.applyGammaAndBrightness just applies the math.
					// We need to check if we SHOULD apply it.
					// In the previous code: if (settings.normalization.gammaMode)

					if (settings.normalization.gammaMode) {
						normalized = NormalizationHelper.applyGammaAndBrightness(normalized, settings);
					}

					// Clamp only for display conversion to 0-255 range
					values.push(Math.round(Math.max(0, Math.min(1, normalized)) * 255));
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
	 * @param {any[]} rasters - Raster data
	 * @param {number} width - Image width
	 * @param {number} height - Image height
	 * @param {number} normMin - Normalization minimum
	 * @param {number} normMax - Normalization maximum
	 * @param {any} settings - Settings object
	 * @param {number} bitsPerSample - Bits per sample
	 * @returns {Uint8ClampedArray}
	 */
	_processIntegerTiff(rasters, width, height, normMin, normMax, settings, bitsPerSample) {
		const imageDataArray = new Uint8ClampedArray(width * height * 4);
		const numBands = rasters.length;
		const typeMax = bitsPerSample === 16 ? 65535 : 255;

		// Generate LUT using NormalizationHelper
		const lut = NormalizationHelper.generateLut(settings, bitsPerSample, typeMax, normMin, normMax);

		// Optimization: Check for identity transform
		// If LUT is identity (0->0, 255->255 etc) and we have 8-bit data, we can use fast path
		const isIdentityGamma = NormalizationHelper.isIdentityTransformation(settings);
		const isFullRange = normMin === 0 && normMax === typeMax;

		// Fast path for 8-bit integer data with identity transform
		if (isIdentityGamma && isFullRange && !settings.rgbAs24BitGrayscale && bitsPerSample === 8 && rasters[0] instanceof Uint8Array) {
			console.log('TIFF: Identity transform detected (8-bit), using fast interleave loop');

			if (numBands >= 3) {
				// RGB(A) -> RGBA
				const rBand = rasters[0];
				const gBand = rasters[1];
				const bBand = rasters[2];
				const aBand = numBands > 3 ? rasters[3] : null;

				for (let i = 0; i < width * height; i++) {
					const outIdx = i * 4;
					imageDataArray[outIdx] = rBand[i];
					imageDataArray[outIdx + 1] = gBand[i];
					imageDataArray[outIdx + 2] = bBand[i];
					imageDataArray[outIdx + 3] = aBand ? aBand[i] : 255;
				}
			} else if (numBands === 1) {
				// Gray -> RGBA
				const grayBand = rasters[0];
				for (let i = 0; i < width * height; i++) {
					const val = grayBand[i];
					const outIdx = i * 4;
					imageDataArray[outIdx] = val;
					imageDataArray[outIdx + 1] = val;
					imageDataArray[outIdx + 2] = val;
					imageDataArray[outIdx + 3] = 255;
				}
			} else if (numBands === 2) {
				// Gray + Alpha -> RGBA
				const grayBand = rasters[0];
				const alphaBand = rasters[1];
				for (let i = 0; i < width * height; i++) {
					const val = grayBand[i];
					const outIdx = i * 4;
					imageDataArray[outIdx] = val;
					imageDataArray[outIdx + 1] = val;
					imageDataArray[outIdx + 2] = val;
					imageDataArray[outIdx + 3] = alphaBand[i];
				}
			}
			return imageDataArray;
		}

		// LUT-based processing
		const nanColor = this._getNanColor(settings);

		for (let i = 0; i < width * height; i++) {
			let r, g, b;

			// Check if any band has NaN values (unlikely for integer, but possible if converted)
			let hasNaN = false;
			// Only check first 3 bands for NaN
			for (let band = 0; band < Math.min(3, numBands); band++) {
				// For integer arrays, isNaN check might be redundant but safe
				if (Number.isNaN(rasters[band][i])) {
					hasNaN = true;
					break;
				}
			}

			if (hasNaN) {
				r = nanColor.r;
				g = nanColor.g;
				b = nanColor.b;
			} else if (numBands === 1) {
				// Grayscale
				const val = rasters[0][i];
				// Clamp to LUT size
				const lutIdx = Math.min(Math.max(0, Math.round(val)), typeMax);
				const displayVal = lut[lutIdx];
				r = g = b = displayVal;
			} else if (settings.rgbAs24BitGrayscale && numBands >= 3) {
				// RGB as 24-bit grayscale
				// This is a special case where we combine 3 channels into one value
				// LUT approach is tricky here because the value range is huge (24-bit)
				// So we might need to stick to manual calculation or use a different approach
				// But wait, the previous logic normalized each channel then combined? 
				// No, previous logic:
				// 1. Get RGB values (clamped 0-255)
				// 2. Combine to 24-bit
				// 3. Normalize 24-bit value using normMin/normMax
				// 4. Apply gamma

				// Since 24-bit LUT is too big, we'll do manual calculation for this specific mode
				// Re-implementing the manual logic from before, but using NormalizationHelper for gamma

				const v0 = Math.min(255, Math.max(0, rasters[0][i]));
				const v1 = Math.min(255, Math.max(0, rasters[1][i]));
				const v2 = Math.min(255, Math.max(0, rasters[2][i]));

				const combined24bit = (v0 << 16) | (v1 << 8) | v2;

				let normalized24;
				const norm24Range = normMax - normMin;
				if (norm24Range > 0) {
					normalized24 = (combined24bit - normMin) / norm24Range;
				} else {
					normalized24 = 0;
				}

				if (settings.normalization.gammaMode) {
					normalized24 = NormalizationHelper.applyGammaAndBrightness(normalized24, settings);
				}

				const displayVal = Math.round(Math.max(0, Math.min(1, normalized24)) * 255);
				r = g = b = displayVal;

			} else {
				// RGB
				const vals = [];
				for (let band = 0; band < Math.min(3, numBands); band++) {
					const val = rasters[band][i];
					const lutIdx = Math.min(Math.max(0, Math.round(val)), typeMax);
					vals.push(lut[lutIdx]);
				}
				r = vals[0];
				g = vals[1];
				b = vals[2];
			}

			const outIdx = i * 4;
			imageDataArray[outIdx] = r;
			imageDataArray[outIdx + 1] = g;
			imageDataArray[outIdx + 2] = b;
			imageDataArray[outIdx + 3] = 255;
		}

		return imageDataArray;
	}

	/**
	 * Load mask image for filtering
	 * @param {string} maskSrc - Mask TIFF file URL
	 * @returns {Promise<Float32Array>}
	 */
	async loadMaskImage(maskSrc) {
		// Check cache first
		if (this._maskCache.has(maskSrc)) {
			return this._maskCache.get(maskSrc);
		}

		try {
			const response = await fetch(maskSrc);
			const buffer = await response.arrayBuffer();
			const tiff = await GeoTIFF.fromArrayBuffer(buffer);
			const image = await tiff.getImage();
			const rasters = await image.readRasters();

			// Return the first band as a Float32Array
			const maskData = new Float32Array(rasters[0]);

			// Cache the mask data
			this._maskCache.set(maskSrc, maskData);

			return maskData;
		} catch (error) {
			console.error('Error loading mask image:', error);
			throw error;
		}
	}

	/**
	 * Clear the mask cache (call when mask URIs change)
	 */
	clearMaskCache() {
		this._maskCache.clear();
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
		// Check for converted colormap data first
		if (this._convertedFloatData) {
			const pixelIndex = y * naturalWidth + x;
			const floatValue = this._convertedFloatData.floatData[pixelIndex];
			return floatValue.toPrecision(6);
		}

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
		return null;
	}

	/**
	 * Perform the initial render if it was deferred
	 * Called when format-specific settings have been applied
	 * @returns {Promise<ImageData|null>} - The rendered image data, or null if no pending render
	 */
	async performDeferredRender() {
		if (!this._pendingRenderData) {
			return null;
		}

		const { image, rasters } = this._pendingRenderData;
		this._pendingRenderData = null;
		this._isInitialLoad = false;

		// Now render with the correct format-specific settings
		const imageData = await this.renderTiff(image, rasters);
		return imageData;
	}
} 