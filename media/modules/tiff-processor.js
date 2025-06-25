// @ts-check
"use strict";

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
			
			// Store TIFF data for pixel inspection
			this.rawTiffData = {
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
	 * Render TIFF data to ImageData
	 * @param {*} image - GeoTIFF image object
	 * @param {*} rasters - Raster data
	 * @returns {Promise<ImageData>}
	 */
	async renderTiff(image, rasters) {
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

		// Get normalization settings
		const settings = this.settingsManager.settings;
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

		for (let i = 0; i < width * height; i++) {
			let r, g, b;

			if (numBands === 1) {
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
				
				r = values[0] || 0;
				g = values[1] || values[0] || 0;
				b = values[2] || values[0] || 0;
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
		
		// For integer TIFFs, we need to handle normalization differently based on settings
		const maxVal = Math.pow(2, bitsPerSample) - 1;
		let useImageStats = false;
		let normMin = 0;
		let normMax = maxVal;
		
		// Check if we should use image statistics for normalization
		if (settings.normalization && settings.normalization.autoNormalize) {
			// Auto-normalization: always use image statistics
			useImageStats = true;
			
			// Calculate min/max from actual data (same as float processing)
			let min = Infinity;
			let max = -Infinity;
			for (let i = 0; i < Math.min(rasters.length, 3); i++) {
				for (let j = 0; j < rasters[i].length; j++) {
					const value = rasters[i][j];
					if (!isNaN(value) && isFinite(value)) {
						min = Math.min(min, value);
						max = Math.max(max, value);
					}
				}
			}
			normMin = min;
			normMax = max;
		} else if (settings.normalization && 
				   (settings.normalization.min !== 0.0 || settings.normalization.max !== 1.0)) {
			// Manual normalization with custom values (not the default 0.0-1.0)
			useImageStats = true;
			normMin = settings.normalization.min;
			normMax = settings.normalization.max;
		}
		// Otherwise: use traditional bit-depth normalization (useImageStats remains false)

		for (let i = 0; i < width * height; i++) {
			let r, g, b;

			if (numBands === 1) {
				let value = rasters[0][i];
				
				if (useImageStats) {
					// Normalize using image statistics (like float processing)
					const range = normMax - normMin;
					if (range > 0) {
						value = (value - normMin) / range;
					} else {
						value = 0;
					}
					value = this.clamp(value, 0, 1);
					
					// Apply gamma and brightness corrections
					if (settings.normalization.gammaMode) {
						value = this._applyGammaAndBrightness(value, settings);
					}
					
					value = Math.round(value * 255);
				} else {
					// Traditional bit-depth normalization
					value = value / maxVal; // Normalize to 0-1
					value = this._applyGammaAndBrightness(value, settings);
					value = Math.round(value * 255); // Convert to 8-bit for display
				}
				
				r = g = b = this.clamp(value, 0, 255);
			} else {
				const values = [];
				for (let band = 0; band < Math.min(3, numBands); band++) {
					let value = rasters[band][i];
					
					if (useImageStats) {
						// Normalize using image statistics (like float processing)
						const range = normMax - normMin;
						if (range > 0) {
							value = (value - normMin) / range;
						} else {
							value = 0;
						}
						value = this.clamp(value, 0, 1);
						
						// Apply gamma and brightness corrections
						if (settings.normalization.gammaMode) {
							value = this._applyGammaAndBrightness(value, settings);
						}
						
						value = Math.round(value * 255);
					} else {
						// Traditional bit-depth normalization
						value = value / maxVal; // Normalize to 0-1
						value = this._applyGammaAndBrightness(value, settings);
						value = Math.round(value * 255); // Convert to 8-bit for display
					}
					
					values.push(this.clamp(value, 0, 255));
				}
				
				r = values[0] || 0;
				g = values[1] || values[0] || 0;
				b = values[2] || values[0] || 0;
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