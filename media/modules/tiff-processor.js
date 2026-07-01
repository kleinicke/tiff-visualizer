// @ts-check
"use strict";
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';
import { TiffWasmProcessor } from './tiff-wasm-wrapper.js';
import { PerfTrace } from './perf-trace.js';
import { WebGL2FloatRenderer } from './webgl2-float-renderer.js';
import { parseAllTagsJson, buildTagsFromGeotiffImage } from './tiff-tag-utils.js';

/**
 * @typedef {Object} GeoTIFFGlobal
 * @property {function} fromArrayBuffer
 */

/**
 * @type {GeoTIFFGlobal}
 */
// @ts-ignore - GeoTIFF is loaded globally via script tag
const GeoTIFF = window.GeoTIFF;

/** @typedef {import('./settings-manager.js').SettingsManager} SettingsManager */
/** @typedef {import('./settings-manager.js').ImageSettings} ImageSettings */
/** @typedef {{postMessage: (msg: any) => any}} VsCodeApi */

/**
 * TIFF Processor Module
 * Handles TIFF image processing, normalization, and data extraction
 */
export class TiffProcessor {
	/**
	 * @param {SettingsManager} settingsManager
	 * @param {VsCodeApi} vscode
	 */
	constructor(settingsManager, vscode) {
		this.settingsManager = settingsManager;
		this.vscode = vscode;
		this.rawTiffData = null;
		this._pendingRenderData = null; // Store data waiting for format-specific settings
		this._isInitialLoad = true; // Track if this is the first render
		this._lastImageData = null; // Store the last rendered image data for fast parameter updates
		/** @type {{min:number,max:number}|null} */
		this._lastStatistics = null; // Cache min/max statistics
		this._lastStatisticsRgb24Mode = false; // Track whether cached stats were computed in rgb24 mode
		this._lastRenderHistogram = null; // Histogram computed during render when requested
		/** @type {import('./tiff-tag-utils.js').TagEntry[]} */
		this._lastAllTags = []; // Every TIFF/Exif/GPS tag found in the current file, for the Metadata panel
		this._lastRenderUsedWebGL = false; // True when the latest render drew directly to the canvas
		/** @type {{ floatData: Float32Array, width?: number, height?: number, min?: number, max?: number } | null} */
		this._convertedFloatData = null; // Cache converted float data for analysis
		/** @type {AbortSignal|undefined} */
		this.loadSignal = undefined; // Set before each load; aborts the fetch when a newer image switch supersedes it
		/** @type {import('./decode-worker-client.js').DecodeWorkerClient|null} */
		this.decodeWorker = null; // Off-thread decoder, set by imagePreview.js; null falls back to local decoding

		// WASM decoder
		this._wasmProcessor = new TiffWasmProcessor();
		this._webglRenderer = new WebGL2FloatRenderer();
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
	 * @param {any} source
	 * @returns {{rowsPerStrip?: number, stripCount?: number, stripByteCountTotal?: number, stripByteCountMax?: number, tileWidth?: number, tileLength?: number, tileCount?: number, directDecode?: boolean}}
	 */
	_getTiffLayoutInfo(source) {
		if (!source) { return {}; }
		if (source.fileDirectory) {
			const fd = source.fileDirectory;
			const byteCounts = (Array.isArray(fd.StripByteCounts) || ArrayBuffer.isView(fd.StripByteCounts)) ? fd.StripByteCounts : [];
			const tileCounts = (Array.isArray(fd.TileByteCounts) || ArrayBuffer.isView(fd.TileByteCounts)) ? fd.TileByteCounts : [];
			let stripByteCountTotal = 0;
			let stripByteCountMax = 0;
			for (const value of byteCounts) {
				const numeric = Number(value || 0);
				stripByteCountTotal += numeric;
				if (numeric > stripByteCountMax) { stripByteCountMax = numeric; }
			}
			return {
				rowsPerStrip: fd.RowsPerStrip,
				stripCount: byteCounts.length || undefined,
				stripByteCountTotal: byteCounts.length ? stripByteCountTotal : undefined,
				stripByteCountMax: byteCounts.length ? stripByteCountMax : undefined,
				tileWidth: fd.TileWidth,
				tileLength: fd.TileLength,
				tileCount: tileCounts.length || undefined
			};
		}
		return {
			rowsPerStrip: source.rowsPerStrip,
			stripCount: source.stripCount,
			stripByteCountTotal: source.stripByteCountTotal,
			stripByteCountMax: source.stripByteCountMax,
			tileWidth: source.tileWidth,
			tileLength: source.tileLength,
			tileCount: source.tileCount,
			directDecode: source.directDecode
		};
	}

	/** @param {{rowsPerStrip?: number, stripCount?: number, stripByteCountTotal?: number, stripByteCountMax?: number, tileWidth?: number, tileLength?: number, tileCount?: number, directDecode?: boolean}} layout */
	_logTiffLayout(layout) {
		const parts = [];
		if (layout.rowsPerStrip) { parts.push(`rows/strip=${layout.rowsPerStrip}`); }
		if (layout.stripCount) { parts.push(`strips=${layout.stripCount}`); }
		if (layout.stripByteCountMax) { parts.push(`maxStripBytes=${layout.stripByteCountMax}`); }
		if (layout.tileCount) { parts.push(`tiles=${layout.tileCount}`); }
		if (layout.tileWidth && layout.tileLength) { parts.push(`tile=${layout.tileWidth}x${layout.tileLength}`); }
		if (layout.directDecode) { parts.push('direct-uncompressed-path=yes'); }
		if (parts.length) {
			console.log(`[TiffProcessor] TIFF layout: ${parts.join(', ')}`);
		}
	}

	/**
	 * Process TIFF file from URL
	 * @param {string} src - TIFF file URL
	 * @returns {Promise<{canvas: HTMLCanvasElement, imageData: ImageData, tiffData: Object, decodeInfo: {engine: string, durationMs: number}}>}
	 */
	async processTiff(src) {
		const startTime = performance.now();
		this._lastRenderHistogram = null;
		const loadSignal = this.loadSignal;
		/** @type {{engine: string, durationMs: number}|null} */
		let decodeInfo = null;
		try {
			const responseStart = performance.now();
			const response = await fetch(src, { signal: loadSignal });
			PerfTrace.detail('fetch-tiff-response', performance.now() - responseStart);
			const readStart = performance.now();
			const buffer = await response.arrayBuffer();
			const readDuration = performance.now() - readStart;
			PerfTrace.detail('fetch-tiff-arrayBuffer', readDuration);
			const megabytes = buffer.byteLength / (1024 * 1024);
			PerfTrace.note('fetch-tiff-bytes', `${megabytes.toFixed(1)}MB`);
			if (readDuration > 0) {
				PerfTrace.note('fetch-tiff-arrayBuffer-rate', `${(megabytes / (readDuration / 1000)).toFixed(0)}MB/s`);
			}
			if (loadSignal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
			const fetchTime = performance.now() - startTime;
			console.log(`[TiffProcessor] Fetch time: ${fetchTime.toFixed(2)}ms`);
			PerfTrace.mark('fetch');

			// Check if we should use WASM decoder
			const settings = this.settingsManager.settings;
			const use24BitMode = settings.rgbAs24BitGrayscale || false;

			// Try the decode worker first: the same Rust/WASM decoder, but off
			// the UI thread so big decodes don't freeze input handling or
			// painting. On failure the worker transfers the bytes back and we
			// fall straight through to geotiff.js — retrying the identical
			// WASM decoder locally would just fail again.
			// Wait for worker startup so an early load does not take a
			// synchronous main-thread decoder merely because boot is in flight.
			if (this.decodeWorker && !this.decodeWorker.canDecode('tiff')) {
				await Promise.race([
					this.decodeWorker.start(),
					new Promise(resolve => setTimeout(resolve, 500)),
				]);
			}
			if (loadSignal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
			/** @type {any} */
			let wasmResult = null;
			let workerTiffFailed = false;
			/** @type {ArrayBuffer|null} */
			let localBuffer = buffer;
			// 24-bit grayscale is a post-decode reinterpretation (combine R/G/B
			// into one value), handled later in renderTiff/ImageRenderer, so the
			// Rust/WASM decoder can decode these images like any other RGB TIFF.
			if (this.decodeWorker?.canDecode('tiff')) {
				const workerStart = performance.now();
				const workerResponse = await this.decodeWorker.decode('tiff', buffer);
				if (loadSignal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
				if (workerResponse?.ok) {
					wasmResult = workerResponse.result;
					localBuffer = null;
					const decodedWith = wasmResult.decodedWith || 'wasm (worker)';
					decodeInfo = { engine: decodedWith, durationMs: performance.now() - workerStart };
					console.log(`[TiffProcessor] Worker TIFF decode time: ${decodeInfo.durationMs.toFixed(2)}ms (${decodedWith})`);
					if (wasmResult.wasmFallbackReason) {
						console.warn('[TiffProcessor] Worker used geotiff.js because WASM rejected the TIFF:', wasmResult.wasmFallbackReason);
						this.vscode?.postMessage({
							type: 'log',
							value: `[TiffProcessor] WASM rejected TIFF; using geotiff.js worker fallback: ${wasmResult.wasmFallbackReason}`,
						});
					}
					PerfTrace.mark(decodedWith.startsWith('geotiff.js') ? 'decode-geotiff-worker' : 'decode-wasm-worker');
					if (Array.isArray(wasmResult.decodeTimings)) {
						let measuredWorkerTime = 0;
						for (const timing of wasmResult.decodeTimings) {
							const durationMs = Number(timing?.durationMs);
							if (!Number.isFinite(durationMs)) { continue; }
							measuredWorkerTime += durationMs;
							PerfTrace.detail(String(timing.name || 'decode-worker-detail'), durationMs);
						}
						PerfTrace.detail('decode-worker-transfer+overhead', decodeInfo.durationMs - measuredWorkerTime);
					}
				} else {
					workerTiffFailed = true;
					localBuffer = (workerResponse?.buffer && workerResponse.buffer.byteLength > 0) ? workerResponse.buffer : null;
					console.warn('[TiffProcessor] Worker decode failed, falling back to geotiff.js:', workerResponse?.error);
				}
			}

			const useWasm = !wasmResult && !workerTiffFailed && this._wasmAvailable;
			console.log(`[TiffProcessor] Decode decision: worker=${!!wasmResult}, wasmAvailable=${this._wasmAvailable}, 24BitMode=${use24BitMode}, willUseWasm=${useWasm}`);

			// Local WASM decoding when the worker isn't available
			if (useWasm && localBuffer) {
				try {
					const decodeStart = performance.now();
					// Use a copy so a WASM failure/memory-growth cannot invalidate the
					// original buffer that the geotiff.js fallback path needs below.
					wasmResult = await this._wasmProcessor.decode(localBuffer.slice(0));
					const decodeTime = performance.now() - decodeStart;
					decodeInfo = { engine: 'wasm (main thread)', durationMs: decodeTime };
					console.log(`[TiffProcessor] WASM decode time: ${decodeTime.toFixed(2)}ms`);
					PerfTrace.mark('decode-wasm-local');
				} catch (wasmError) {
					console.warn('[TiffProcessor] WASM decoding failed, falling back to geotiff.js:', wasmError);
					// Disable WASM for the rest of the session — a failure can leave
					// the module in an indeterminate state after a panic.
					this._wasmAvailable = false;
					wasmResult = null;
				}
			}

			if (wasmResult) {
				try {

					// Convert WASM result to format compatible with existing code
					const width = wasmResult.width;
					const height = wasmResult.height;
					const samplesPerPixel = wasmResult.channels;
					const bitsPerSample = wasmResult.bitsPerSample;
					const sampleFormat = wasmResult.sampleFormat;

					// Per-channel rasters: the worker already deinterleaved them
					// off-thread; the local WASM path deinterleaves here.
					/** @type {Float32Array[]} */
					let rasters;
					if (wasmResult.rasters) {
						rasters = wasmResult.rasters;
					} else if (samplesPerPixel === 1) {
						rasters = [wasmResult.data];
					} else {
						rasters = [];
						// Deinterleave for compatibility with existing rendering code
						for (let c = 0; c < samplesPerPixel; c++) {
							const channel = new Float32Array(width * height);
							for (let i = 0; i < width * height; i++) {
								channel[i] = wasmResult.data[i * samplesPerPixel + c];
							}
							rasters.push(channel);
						}
						PerfTrace.mark('deinterleave');
					}

					// Store interleaved data
					const data = wasmResult.data;

					// Use metadata from WASM (no need to parse again with geotiff.js!)
					const compression = wasmResult.compression;
					const predictor = wasmResult.predictor;
					const photometricInterpretation = wasmResult.photometricInterpretation;
					const planarConfig = wasmResult.planarConfiguration;
					const layoutInfo = this._getTiffLayoutInfo(wasmResult);
					console.log(`[TiffProcessor] Using metadata from WASM: compression=${compression}, predictor=${predictor}`);
					this._logTiffLayout(layoutInfo);

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
					if (Number.isFinite(wasmResult.min) && Number.isFinite(wasmResult.max)) {
						this._lastStatistics = { min: wasmResult.min, max: wasmResult.max };
						this._lastStatisticsRgb24Mode = false;
					}
					this._lastAllTags = parseAllTagsJson(wasmResult.allTagsJson);

					// Send format information to VS Code
					if (this.vscode && this._isInitialLoad) {
						const showNormTiff = sampleFormat === 3;
						const formatType = showNormTiff ? 'tiff-float' : 'tiff-int';
						this._pendingRenderData = { image, rasters };

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
								...layoutInfo,
								formatType,
								isInitialLoad: true,
								decodedWith: wasmResult.decodedWith || 'wasm'
							}
						});

						const canvas = document.createElement('canvas');
						canvas.width = width;
						canvas.height = height;
						const placeholderImageData = new ImageData(width, height);
						return { canvas, imageData: placeholderImageData, tiffData: this.rawTiffData, decodeInfo: /** @type {{engine: string, durationMs: number}} */ (decodeInfo) };
					}

					const canvas = document.createElement('canvas');
					canvas.width = width;
					canvas.height = height;
					const imageData = await this.renderTiff(image, rasters);
					const totalTime = performance.now() - startTime;
					console.log(`[TiffProcessor] Total WASM processing time: ${totalTime.toFixed(2)}ms`);
					return { canvas, imageData, tiffData: this.rawTiffData, decodeInfo: /** @type {{engine: string, durationMs: number}} */ (decodeInfo) };
				} catch (wasmError) {
					console.warn('[TiffProcessor] WASM decoding failed, falling back to geotiff.js:', wasmError);
					// Disable WASM for the rest of the session — a failure can leave
					// the module in an indeterminate state after a panic.
					this._wasmAvailable = false;
					// Fall through to geotiff.js implementation below
				}
			}

			// Fallback to geotiff.js (or if WASM not available/failed)
			if (!localBuffer || localBuffer.byteLength === 0) {
				// The bytes were transferred to the worker; refetch (rare error path).
				const refetched = await fetch(src, { signal: loadSignal });
				localBuffer = await refetched.arrayBuffer();
			}
			const decodeStart = performance.now();
			const tiff = await GeoTIFF.fromArrayBuffer(localBuffer);
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
			const layoutInfo = this._getTiffLayoutInfo(image);
			this._logTiffLayout(layoutInfo);

			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;

			const rasters = await image.readRasters();
			const decodeTime = performance.now() - decodeStart;
			decodeInfo = {
				engine: use24BitMode ? 'geotiff.js (main thread, 24-bit mode)' : 'geotiff.js (main thread)',
				durationMs: decodeTime,
			};
			console.log(`[TiffProcessor] geotiff.js decode time: ${decodeTime.toFixed(2)}ms`);
			PerfTrace.mark('decode-geotiff');

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
			PerfTrace.mark('interleave-raw');

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
			this._lastAllTags = buildTagsFromGeotiffImage(image);

			// Send format information to VS Code BEFORE rendering
			// This allows the extension to apply format-specific settings first
			if (this.vscode && this._isInitialLoad) {
				// Determine if this is a float TIFF or int TIFF
				const showNormTiff = sampleFormat === 3; // 3 = IEEE floating point
				const formatType = showNormTiff ? 'tiff-float' : 'tiff-int';
				this._pendingRenderData = { image, rasters };

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
						...layoutInfo,
						formatType: formatType, // For per-format settings
						isInitialLoad: true, // Signal that this is the first load
						decodedWith: use24BitMode ? 'geotiff.js (24-bit mode)' : 'geotiff.js'
					}
				});

				// Return placeholder - actual rendering happens when settings update
				const placeholderImageData = new ImageData(width, height);
				return { canvas, imageData: placeholderImageData, tiffData: this.rawTiffData, decodeInfo };
			}

			// Non-initial loads or if no vscode (render immediately)
			const imageData = await this.renderTiff(image, rasters);
			const totalTime = performance.now() - startTime;
			console.log(`[TiffProcessor] Total geotiff.js processing time: ${totalTime.toFixed(2)}ms`);
			return { canvas, imageData, tiffData: this.rawTiffData, decodeInfo };
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
	async renderTiffWithSettings(image, rasters, renderOptions = {}) {
		this._lastRenderHistogram = null;
		this._lastRenderUsedWebGL = false;
		const settings = this.settingsManager.settings;
		const rastersCopy = rasters;
		PerfTrace.mark('raster-copy-skipped');

		const width = image.getWidth();
		const height = image.getHeight();
		const sampleFormat = image.getSampleFormat();
		const bitsPerSample = image.getBitsPerSample();
		const channels = rastersCopy.length;

		const showNorm = Array.isArray(sampleFormat) ? sampleFormat.includes(3) : sampleFormat === 3;
		let isFloat = showNorm;

		// Check if non-float data contains non-finite values (Infinity/-Infinity).
		// If so, force float rendering path which handles them correctly with nanColor.
		if (!isFloat) {
			outer:
			for (let i = 0; i < rastersCopy.length; i++) {
				for (let j = 0; j < rastersCopy[i].length; j++) {
					if (!Number.isFinite(rastersCopy[i][j])) {
						isFloat = true;
						break outer;
					}
				}
			}
			PerfTrace.mark('finite-scan');
		}

		// Calculate stats if needed (for auto-normalize or just to have them)
		const currentRgb24Mode = settings.rgbAs24BitGrayscale || false;
		// Invalidate cached stats if rgb24 mode changed (stats are computed differently per mode)
		if (this._lastStatisticsRgb24Mode !== currentRgb24Mode) {
			this._lastStatistics = null;
		}
		/** @type {{min:number,max:number}|null} */
		let stats = this._lastStatistics;
		const isGammaMode = settings.normalization?.gammaMode || false;

		if (!stats && NormalizationHelper.needsStats(settings)) {
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
					const r0 = rastersCopy[0];
					const r1 = rastersCopy[1];
					const r2 = rastersCopy[2];
					for (let j = 0; j < rastersCopy[0].length; j++) {
						const rv = r0[j], gv = r1[j], bv = r2[j];
						const r = (rv === rv && rv !== Infinity && rv !== -Infinity) ? Math.round(Math.max(0, Math.min(255, rv))) : 0;
						const g = (gv === gv && gv !== Infinity && gv !== -Infinity) ? Math.round(Math.max(0, Math.min(255, gv))) : 0;
						const b = (bv === bv && bv !== Infinity && bv !== -Infinity) ? Math.round(Math.max(0, Math.min(255, bv))) : 0;
						const combined24bit = (r << 16) | (g << 8) | b;
						if (combined24bit < min) min = combined24bit;
						if (combined24bit > max) max = combined24bit;
					}
				} else {
					// Normal mode: use individual channel values
					const scanChannels = Math.min(rastersCopy.length, 3);
					for (let i = 0; i < scanChannels; i++) {
						const raster = rastersCopy[i];
						for (let j = 0; j < raster.length; j++) {
							const value = raster[j];
							if (value === value && value !== Infinity && value !== -Infinity) {
								if (value < min) min = value;
								if (value > max) max = value;
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
					const r0 = rastersCopy[0];
					const r1 = rastersCopy[1];
					const r2 = rastersCopy[2];
					for (let j = 0; j < rastersCopy[0].length; j++) {
						const r = Math.round(Math.max(0, Math.min(255, r0[j])));
						const g = Math.round(Math.max(0, Math.min(255, r1[j])));
						const b = Math.round(Math.max(0, Math.min(255, r2[j])));
						const combined24bit = (r << 16) | (g << 8) | b;
						if (combined24bit < min) min = combined24bit;
						if (combined24bit > max) max = combined24bit;
					}
				} else {
					const scanChannels = Math.min(rastersCopy.length, 3);
					for (let i = 0; i < scanChannels; i++) {
						const raster = rastersCopy[i];
						for (let j = 0; j < raster.length; j++) {
							const value = raster[j];
							if (value === value && value !== Infinity && value !== -Infinity) {
								if (value < min) min = value;
								if (value > max) max = value;
							}
						}
					}
				}
				stats = { min, max };
			}

			this._lastStatistics = stats;
			this._lastStatisticsRgb24Mode = currentRgb24Mode;
			PerfTrace.mark('stats');
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
		const storedData = this.rawTiffData?.data;
		const canUseStoredInterleaved =
			storedData &&
			storedData.length === len * channels &&
			(isFloat ||
				(bitsPerSample === 16 && storedData instanceof Uint16Array) ||
				(bitsPerSample !== 16 && (storedData instanceof Uint8Array || storedData instanceof Uint8ClampedArray)));

		if (canUseStoredInterleaved) {
			interleavedData = storedData;
			PerfTrace.mark('interleave-skipped');
		} else {
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
			PerfTrace.mark('interleave');
		}

		// Create options object
		const options = {
			nanColor: nanColor,
			rgbAs24BitGrayscale: settings.rgbAs24BitGrayscale,
			collectHistogram: renderOptions.collectHistogram === true
		};

		const targetCanvas = renderOptions.targetCanvas;
		const typeMax = isFloat ? 1.0 : (bitsPerSample === 16 ? 65535 : 255);
		if (targetCanvas && this._webglRenderer.canRender({
			data: interleavedData,
			width,
			height,
			channels,
			isFloat,
			settings,
			collectHistogram: renderOptions.collectHistogram === true
		})) {
			const rendered = this._webglRenderer.render(targetCanvas, {
				data: /** @type {Float32Array} */ (interleavedData),
				width,
				height,
				min: (stats && Number.isFinite(stats.min)) ? stats.min : 0,
				max: (stats && Number.isFinite(stats.max)) ? stats.max : typeMax,
				typeMax,
				settings,
				nanColor,
				channels
			});
			if (rendered) {
				this._lastRenderUsedWebGL = true;
				this._lastRenderHistogram = null;
				return renderOptions.placeholderImageData || new ImageData(width, height);
			}
		}

		const imageData = ImageRenderer.render(
			interleavedData,
			width,
			height,
			channels,
			isFloat,
			stats || { min: 0, max: 1 },
			settings,
			options
		);
		this._lastRenderHistogram = options.renderHistogramResult || null;
		return imageData;
	}

	/**
	 * Fast render TIFF data with current settings.
	 * @param {*} image - GeoTIFF image object
	 * @param {*} rasters - Raster data
	 * @returns {Promise<ImageData>}
	 */
	async renderTiffWithSettingsFast(/** @type {any} */ image, /** @type {any} */ rasters, renderOptions = {}) {
		// Redirect to main render method for now to ensure correctness and use centralized ImageRenderer
		return this.renderTiffWithSettings(image, rasters, renderOptions);
	}

	async renderTiff(/** @type {any} */ image, /** @type {any} */ rasters, renderOptions = {}) {
		return this.renderTiffWithSettings(image, rasters, renderOptions);
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
	async performDeferredRender(renderOptions = {}) {
		const perfStart = performance.now();
		if (!this._pendingRenderData) {
			return null;
		}

		const { image, rasters } = this._pendingRenderData;
		this._pendingRenderData = null;
		this._isInitialLoad = false;

		// Now render with the correct format-specific settings
		const imageData = await this.renderTiff(image, rasters, renderOptions);
		console.log(`[TiffProcessor] Deferred render took ${(performance.now() - perfStart).toFixed(2)}ms`);
		return imageData;
	}
}
