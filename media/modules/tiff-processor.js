// @ts-check
"use strict";
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';
import { TiffWasmProcessor } from './tiff-wasm-wrapper.js';

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

		// WASM decoder
		this._wasmProcessor = new TiffWasmProcessor();
		this._wasmAvailable = false;
		this._wasmProcessor.init().then(available => {
			this._wasmAvailable = available;
			if (available) {
				console.log('[TiffProcessor] WASM decoder initialized successfully');
			} else {
				console.log('[TiffProcessor] Using geotiff.js fallback');
			}
		}).catch(err => {
			console.warn('[TiffProcessor] WASM initialization failed:', err);
			this._wasmAvailable = false;
		});
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
		const startTime = performance.now();
		try {
			const response = await fetch(src);
			const buffer = await response.arrayBuffer();
			const fetchTime = performance.now() - startTime;
			console.log(`[TiffProcessor] Fetch time: ${fetchTime.toFixed(2)}ms`);

			// Wait for WASM initialization if it's in progress
			if (!this._wasmAvailable && this._wasmProcessor) {
				await this._wasmProcessor.init();
				this._wasmAvailable = this._wasmProcessor.isAvailable();
			}

			// Check if we should use WASM decoder
			const settings = this.settingsManager.settings;
			const use24BitMode = settings.rgbAs24BitGrayscale || false;

			let useWasm = this._wasmAvailable && !use24BitMode;
			console.log(`[TiffProcessor] Decode decision: wasmAvailable=${this._wasmAvailable}, 24BitMode=${use24BitMode}, willUseWasm=${useWasm}`);

			// Try WASM decoding first if available
			if (useWasm) {
				try {
					const decodeStart = performance.now();
					const wasmResult = await this._wasmProcessor.decode(buffer);
					const decodeTime = performance.now() - decodeStart;
					console.log(`[TiffProcessor] WASM decode time: ${decodeTime.toFixed(2)}ms`);

					// Convert WASM result to format compatible with existing code
					const width = wasmResult.width;
					const height = wasmResult.height;
					const samplesPerPixel = wasmResult.channels;
					const bitsPerSample = wasmResult.bitsPerSample;
					const sampleFormat = wasmResult.sampleFormat;

					// Create rasters from WASM data (deinterleave if needed)
					const rasters = [];
					if (samplesPerPixel === 1) {
						rasters.push(wasmResult.data);
					} else {
						// Deinterleave for compatibility with existing rendering code
						for (let c = 0; c < samplesPerPixel; c++) {
							const channel = new Float32Array(width * height);
							for (let i = 0; i < width * height; i++) {
								channel[i] = wasmResult.data[i * samplesPerPixel + c];
							}
							rasters.push(channel);
						}
					}

					// Store interleaved data
					const data = wasmResult.data;

					// Use metadata from WASM (no need to parse again with geotiff.js!)
					const compression = wasmResult.compression;
					const predictor = wasmResult.predictor;
					const photometricInterpretation = wasmResult.photometricInterpretation;
					const planarConfig = wasmResult.planarConfiguration;
					console.log(`[TiffProcessor] Using metadata from WASM: compression=${compression}, predictor=${predictor}`);

					// Store TIFF data for pixel inspection and re-rendering
					// Create a minimal image-like object for compatibility
					const image = {
						getWidth: () => width,
						getHeight: () => height,
						getSamplesPerPixel: () => samplesPerPixel,
						getBitsPerSample: () => bitsPerSample,
						getSampleFormat: () => sampleFormat
					};

					this.rawTiffData = {
						image: image,
						rasters: rasters,
						ifd: {
							width,
							height,
							t339: sampleFormat,
							t277: samplesPerPixel,
							t284: 1, // Planar config (chunky)
							t258: bitsPerSample
						},
						data: data
					};

					// Send format information to VS Code
					if (this.vscode && this._isInitialLoad) {
						const showNormTiff = sampleFormat === 3;
						const formatType = showNormTiff ? 'tiff-float' : 'tiff-int';

						this.vscode.postMessage({
							type: 'formatInfo',
							value: {
								width,
								height,
								sampleFormat,
								compression,
								predictor,
								photometricInterpretation,
								planarConfig,
								samplesPerPixel,
								bitsPerSample,
								formatType,
								isInitialLoad: true,
								decodedWith: 'wasm'
							}
						});

						this._pendingRenderData = { image, rasters };

						const canvas = document.createElement('canvas');
						canvas.width = width;
						canvas.height = height;
						const placeholderImageData = new ImageData(width, height);
						return { canvas, imageData: placeholderImageData, tiffData: this.rawTiffData };
					}

					const canvas = document.createElement('canvas');
					canvas.width = width;
					canvas.height = height;
					const imageData = await this.renderTiff(image, rasters);
					const totalTime = performance.now() - startTime;
					console.log(`[TiffProcessor] Total WASM processing time: ${totalTime.toFixed(2)}ms`);
					return { canvas, imageData, tiffData: this.rawTiffData };
				} catch (wasmError) {
					console.warn('[TiffProcessor] WASM decoding failed, falling back to geotiff.js:', wasmError);
					// Fall through to geotiff.js implementation below
				}
			}

			// Fallback to geotiff.js (or if WASM not available/failed)
			const decodeStart = performance.now();
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
			const decodeTime = performance.now() - decodeStart;
			console.log(`[TiffProcessor] geotiff.js decode time: ${decodeTime.toFixed(2)}ms`);

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
						isInitialLoad: true, // Signal that this is the first load
						decodedWith: use24BitMode ? 'geotiff.js (24-bit mode)' : 'geotiff.js'
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
			const totalTime = performance.now() - startTime;
			console.log(`[TiffProcessor] Total geotiff.js processing time: ${totalTime.toFixed(2)}ms`);
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
		const channels = rastersCopy.length;

		const showNorm = Array.isArray(sampleFormat) ? sampleFormat.includes(3) : sampleFormat === 3;
		const isFloat = showNorm;

		// Calculate stats if needed (for auto-normalize or just to have them)
		let stats = this._lastStatistics;
		const isGammaMode = settings.normalization?.gammaMode || false;

		if (!stats && !isGammaMode) {
			if (isFloat) {
				// Use centralized float stats calculator
				// We need to interleave data for the calculator if it's planar
				// But ImageStatsCalculator expects interleaved data or we can pass rasters?
				// ImageStatsCalculator expects a single data array (interleaved).
				// TIFF rasters are separate arrays (planar).
				// We need to combine them or update ImageStatsCalculator to handle planar.
				// Actually, let's just use the existing logic for now but simplified, OR
				// create a temporary interleaved buffer? That's expensive.
				// Better: Use a helper that handles planar data or just loop here.

				// Wait, ImageStatsCalculator.calculateFloatStats takes (data, width, height, channels).
				// If data is planar (array of arrays), it won't work.
				// Let's check ImageStatsCalculator implementation.

				// It assumes interleaved.
				// For TIFF, we might want to keep the local stats calculation for now to avoid copying data,
				// OR update ImageStatsCalculator to support planar data.
				// Given the performance focus, let's keep local stats calculation for TIFF planar data
				// but use the same logic structure.

				let min = Infinity;
				let max = -Infinity;

				// Use the first 3 channels to determine the image stats
				if (settings.rgbAs24BitGrayscale && rastersCopy.length >= 3) {
					// Calculate min/max of combined 24-bit values
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
				stats = { min, max };
			} else {
				// Integer stats
				// Similar logic for integer
				let min = Infinity;
				let max = -Infinity;

				if (settings.rgbAs24BitGrayscale && rastersCopy.length >= 3) {
					// Same 24-bit logic
					for (let j = 0; j < rastersCopy[0].length; j++) {
						const values = [];
						for (let i = 0; i < 3; i++) {
							const value = rastersCopy[i][j];
							values.push(Math.round(Math.max(0, Math.min(255, value))));
						}
						const combined24bit = (values[0] << 16) | (values[1] << 8) | values[2];
						min = Math.min(min, combined24bit);
						max = Math.max(max, combined24bit);
					}
				} else {
					for (let i = 0; i < Math.min(rastersCopy.length, 3); i++) {
						for (let j = 0; j < rastersCopy[i].length; j++) {
							const value = rastersCopy[i][j];
							min = Math.min(min, value);
							max = Math.max(max, value);
						}
					}
				}
				stats = { min, max };
			}

			this._lastStatistics = stats;
		}

		// Send stats to VS Code
		if (this.vscode && stats) {
			this.vscode.postMessage({ type: 'stats', value: stats });
		}

		const nanColor = this._getNanColor(settings);

		// Prepare data for ImageRenderer
		// ImageRenderer expects interleaved data. TIFF rasters are planar.
		// We MUST interleave the data before passing to ImageRenderer.
		// This is a necessary step for centralization.

		let interleavedData;
		const len = width * height;

		if (isFloat) {
			interleavedData = new Float32Array(len * channels);
		} else if (bitsPerSample === 16) {
			interleavedData = new Uint16Array(len * channels);
		} else {
			interleavedData = new Uint8Array(len * channels);
		}

		// Interleave
		if (channels === 1) {
			interleavedData.set(rastersCopy[0]);
		} else {
			for (let i = 0; i < len; i++) {
				for (let c = 0; c < channels; c++) {
					interleavedData[i * channels + c] = rastersCopy[c][i];
				}
			}
		}

		// Create options object
		const options = {
			nanColor: nanColor,
			rgbAs24BitGrayscale: settings.rgbAs24BitGrayscale
		};

		return ImageRenderer.render(
			interleavedData,
			width,
			height,
			channels,
			isFloat,
			stats || { min: 0, max: 1 },
			settings,
			options
		);
	}

	/**
	 * Fast render TIFF data with current settings (skips mask loading and uses cached statistics)
	 * @param {*} image - GeoTIFF image object
	 * @param {*} rasters - Raster data
	 * @param {boolean} skipMasks - Whether to skip mask filtering
	 * @returns {Promise<ImageData>}
	 */
	async renderTiffWithSettingsFast(image, rasters, skipMasks = true) {
		// Redirect to main render method for now to ensure correctness and use centralized ImageRenderer
		// TODO: Re-implement optimization for skipMasks if needed
		return this.renderTiffWithSettings(image, rasters);
	}

	async renderTiff(image, rasters) {
		return this.renderTiffWithSettings(image, rasters);
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