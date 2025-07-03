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
						bitsPerSample: image.getBitsPerSample()
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
			const isFloatFormat = Array.isArray(sampleFormat) ? sampleFormat.includes(3) : sampleFormat === 3;
			if (isFloatFormat) {
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
		for (let i = 0; i < Math.min(rastersCopy.length, 3); i++) {
			for (let j = 0; j < rastersCopy[i].length; j++) {
				const value = rastersCopy[i][j];
				if (!isNaN(value) && isFinite(value)) {
					min = Math.min(min, value);
					max = Math.max(max, value);
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
			// Gamma mode: always normalize to fixed 0-1 range
			normMin = 0;
			normMax = 1;
		} else {
			// Manual mode: use user-specified range
			normMin = settings.normalization.min;
			normMax = settings.normalization.max;
		}

		// Normalize and create image data
		const isFloat = Array.isArray(sampleFormat) ? sampleFormat.includes(3) : sampleFormat === 3;
		console.log(`[TiffProcessor] Detected float: ${isFloat}, sampleFormat:`, sampleFormat);
		if (isFloat) { // Float data
			if (this.vscode) {
				console.log(`[TiffProcessor] Sending isFloat: true message`);
				this.vscode.postMessage({ type: 'isFloat', value: true });
			}
			imageDataArray = this._processFloatTiff(displayRasters, width, height, normMin, normMax, settings);
		} else {
			if (this.vscode) {
				console.log(`[TiffProcessor] Sending isFloat: false message`);
				this.vscode.postMessage({ type: 'isFloat', value: false });
			}
			imageDataArray = this._processIntegerTiff(displayRasters, width, height, settings, bitsPerSample);
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
		for (let i = 0; i < Math.min(rasters.length, 3); i++) {
			for (let j = 0; j < rasters[i].length; j++) {
				const value = rasters[i][j];
				if (!isNaN(value) && isFinite(value)) {
					min = Math.min(min, value);
					max = Math.max(max, value);
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
			// Gamma mode: always normalize to fixed 0-1 range
			normMin = 0;
			normMax = 1;
		} else {
			// Manual mode: use user-specified range
			normMin = settings.normalization.min;
			normMax = settings.normalization.max;
		}

		// Normalize and create image data
		const isFloat = Array.isArray(sampleFormat) ? sampleFormat.includes(3) : sampleFormat === 3;
		console.log(`[TiffProcessor] Detected float: ${isFloat}, sampleFormat:`, sampleFormat);
		if (isFloat) { // Float data
			if (this.vscode) {
				console.log(`[TiffProcessor] Sending isFloat: true message`);
				this.vscode.postMessage({ type: 'isFloat', value: true });
			}
			imageDataArray = this._processFloatTiff(displayRasters, width, height, normMin, normMax, settings);
		} else {
			if (this.vscode) {
				console.log(`[TiffProcessor] Sending isFloat: false message`);
				this.vscode.postMessage({ type: 'isFloat', value: false });
			}
			imageDataArray = this._processIntegerTiff(displayRasters, width, height, settings, bitsPerSample);
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
			} else {
				// RGB or multi-band
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
	_processIntegerTiff(rasters, width, height, settings, bitsPerSample) {
		const imageDataArray = new Uint8ClampedArray(width * height * 4);
		const numBands = rasters.length;
		const nanColor = this._getNanColor(settings);
		
		// For uint images: always use traditional bit-depth normalization
		// Normalization settings are ignored - they only apply to float images
		const maxVal = Math.pow(2, bitsPerSample) - 1;

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
				
				// For uint images: always use traditional bit-depth normalization
				value = value / maxVal; // Normalize to 0-1
				
				// Only apply gamma/brightness to uint images if values are non-default
				if (this._shouldApplyGammaBrightnessToUint(settings)) {
					value = this._applyGammaAndBrightness(value, settings);
				}
				
				value = Math.round(value * 255); // Convert to 8-bit for display
				r = g = b = this.clamp(value, 0, 255);
			} else {
				const values = [];
				for (let band = 0; band < Math.min(3, numBands); band++) {
					let value = rasters[band][i];
					
					// For uint images: always use traditional bit-depth normalization
					value = value / maxVal; // Normalize to 0-1
					
					// Only apply gamma/brightness to uint images if values are non-default
					if (this._shouldApplyGammaBrightnessToUint(settings)) {
						value = this._applyGammaAndBrightness(value, settings);
					}
					
					value = Math.round(value * 255); // Convert to 8-bit for display
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
	 * @private
	 */
	_applyGammaAndBrightness(normalizedValue, settings) {
		// Apply gamma correction
		const gammaIn = settings.gamma.in;
		const gammaOut = settings.gamma.out;
		let corrected = Math.pow(normalizedValue, gammaIn / gammaOut);
		
		// Apply brightness (exposure compensation)
		const exposureStops = settings.brightness.offset;
		corrected = corrected * Math.pow(2, exposureStops);
		
		return this.clamp(corrected, 0, 1);
	}

	/**
	 * Check if gamma/brightness should be applied to uint images
	 * Only apply if values are significantly different from defaults
	 * @private
	 */
	_shouldApplyGammaBrightnessToUint(settings) {
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

		if (samples === 1) { // Grayscale
			const value = data[pixelIndex];
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
			
			if (format === 3) {
				return values.join(' ');
			} else {
				return values.slice(0, 3).join(' ');
			}
		}

		return '';
	}
} 