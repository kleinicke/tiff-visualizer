"use strict";
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';
import { TiffWasmProcessor, getWasmModule, getWasmModuleSync } from './tiff-wasm-wrapper.js';
import { announceCfaDetection, isDeclaredCfa } from './debayer.js';
import { tryStripParallelDecode } from './strip-parallel-decode.js';
import { PerfTrace } from './perf-trace.js';
import { WebGL2FloatRenderer } from './webgl2-float-renderer.js';
import { parseAllTagsJson, buildTagsFromGeotiffImage, parseGdalNodata, TagEntry } from './tiff-tag-utils.js';
import { parseGeoReference, type GeoReference } from './geo-reference.js';
import { SettingsManager, ImageSettings } from './settings-manager.js';
import { DeferredRenderOptions, RenderOptions, Stats } from './types.js';
import { DecodeWorkerClient } from './decode-worker-client.js';
import { findOmeXmlInTags, OmeBinaryOnly, OmeMetadata, parseOmeBinaryOnly, parseOmeXml } from './ome-tiff.js';
import { loadGeoTiff } from './lazy-vendor-loader.js';
import { tiffFormatTypeFor, tiffNeedsFloatCarrier, tiffTypeMax } from './tiff-format-utils.js';
export { tiffFormatTypeFor, tiffNeedsFloatCarrier, tiffTypeMax } from './tiff-format-utils.js';

interface VsCodeApi {
	postMessage: (msg: any) => any;
}

interface TiffLayoutInfo {
	rowsPerStrip?: number;
	stripCount?: number;
	stripByteCountTotal?: number;
	stripByteCountMax?: number;
	tileWidth?: number;
	tileLength?: number;
	tileCount?: number;
	directDecode?: boolean;
}

/**
 * Typed array used to carry interleaved TIFF pixel data. See
 * `tiffNeedsFloatCarrier` for which sample kinds require a Float32Array
 * carrier. Remaining unsigned integer samples (<=16 bit) use the smallest
 * unsigned array that can hold the full bit depth without truncating (e.g.
 * 12-bit needs Uint16Array, not Uint8Array, or values above 255 wrap mod 256).
 */
function pickTiffArrayCtor(sampleFormat: number | number[], bitsPerSample: number): Float32ArrayConstructor | Uint16ArrayConstructor | Uint8ArrayConstructor {
	if (tiffNeedsFloatCarrier(sampleFormat, bitsPerSample)) { return Float32Array; }
	return bitsPerSample > 8 ? Uint16Array : Uint8Array;
}

/**
 * "Full range" upper bound for a TIFF sample format/bit depth: 1.0 for
 * float, the largest positive value for signed integers (e.g. 32767 for
 * 16-bit — gamma mode's [0, typeMax] full-range convention only covers the
 * positive half of signed data), and 2^bits - 1 for unsigned integers.
 */
/**
 * Per-format settings key (AppStateManager.ImageFormatType) for a TIFF's
 * SampleFormat/bit depth. IEEE float and <=16-bit unsigned integer keep
 * their existing defaults (float range controls / gamma mode over the full
 * type range). Signed integer gets its own key defaulting to data-driven
 * auto-normalize, since signed scientific data (e.g. a depth map around an
 * arbitrary zero) rarely fits gamma mode's [0, typeMax] assumption. Wide
 * (>16-bit) unsigned integer — e.g. uint32 — gets its own key for the same
 * reason from the other direction: gamma mode's full range there is
 * [0, 2^32-1], and typical data (which rarely spans anywhere near that) would
 * render essentially black.
 */
/**
 * TIFF Processor Module
 * Handles TIFF image processing, normalization, and data extraction
 */
export class TiffProcessor {
	settingsManager: SettingsManager;
	vscode: VsCodeApi;
	rawTiffData: any;
	_pendingRenderData: { image: any, rasters: any } | null;
	_isInitialLoad: boolean;
	_lastImageData: ImageData | null;
	_lastStatistics: Stats | null;
	_lastStatisticsRgb24Mode: boolean;
	_lastRenderHistogram: any;
	_lastAllTags: TagEntry[];
	_lastRenderUsedWebGL: boolean;
	_gdalNodata: number | undefined;
	_convertedFloatData: { floatData: Float32Array, width?: number, height?: number, min?: number, max?: number } | null;
	loadSignal: AbortSignal | undefined;
	decodeWorker: DecodeWorkerClient | null;
	_wasmProcessor: TiffWasmProcessor;
	_webglRenderer: WebGL2FloatRenderer;
	_wasmAvailable: boolean;
	_wasmInitPromise: Promise<boolean> | null;
	pageIndex: number;
	pageCount: number;
	_sourceBuffer: ArrayBuffer | null;
	_sourceBufferSrc: string | null;
	/** Why the Rust decoder refused the current file, if it did. */
	_lastWasmFailure = '';
	omeMetadata: OmeMetadata | null;
	omeBinaryOnly: OmeBinaryOnly | null;
	omeXml: string | null;
	/** GeoTIFF georeferencing for the decoded page, or null for a plain TIFF. */
	geoReference: GeoReference | null;

	constructor(settingsManager: SettingsManager, vscode: VsCodeApi) {
		this.settingsManager = settingsManager;
		this.vscode = vscode;
		this.rawTiffData = null;
		this._pendingRenderData = null; // Store data waiting for format-specific settings
		this._isInitialLoad = true; // Track if this is the first render
		this._lastImageData = null; // Store the last rendered image data for fast parameter updates
		this._lastStatistics = null; // Cache min/max statistics
		this._lastStatisticsRgb24Mode = false; // Track whether cached stats were computed in rgb24 mode
		this._lastRenderHistogram = null; // Histogram computed during render when requested
		this._lastAllTags = []; // Every TIFF/Exif/GPS tag found in the current file, for the Metadata panel
		this._lastRenderUsedWebGL = false; // True when the latest render drew directly to the canvas
		this._gdalNodata = undefined; // GDAL_NODATA sentinel (tag 42113), excluded from auto-normalize stats
		this._convertedFloatData = null; // Cache converted float data for analysis
		this.loadSignal = undefined; // Set before each load; aborts the fetch when a newer image switch supersedes it
		this.decodeWorker = null; // Off-thread decoder, set by imagePreview.js; null falls back to local decoding

		// WASM decoder
		this._wasmProcessor = new TiffWasmProcessor();
		this._webglRenderer = new WebGL2FloatRenderer();
		this._wasmAvailable = false;
		this._wasmInitPromise = null;
		this.pageIndex = 0;
		this.pageCount = 1;
		this._sourceBuffer = null;
		this._sourceBufferSrc = null;
		this.omeMetadata = null;
		this.omeBinaryOnly = null;
		this.omeXml = null;
		this.geoReference = null;
	}

	private _ensureLocalWasm(): Promise<boolean> {
		if (!this._wasmInitPromise) {
			this._wasmInitPromise = this._wasmProcessor.init().then(available => {
				this._wasmAvailable = available;
				return available;
			}).catch(err => {
				console.warn('[TiffProcessor] WASM initialization failed:', err);
				this._wasmAvailable = false;
				return false;
			});
		}
		return this._wasmInitPromise;
	}

	/**
	 * Clamp a value between min and max
	 */
	clamp(value: number, min: number, max: number): number {
		return Math.min(Math.max(value, min), max);
	}

	private _setOmeXml(xml: string | undefined | null): void {
		if (!xml) { return; }
		this.omeXml = xml;
		this.omeBinaryOnly = parseOmeBinaryOnly(xml);
		this.omeMetadata = parseOmeXml(xml) || this.omeMetadata;
	}

	/**
	 * Get NaN color from settings
	 */
	_getNanColor(settings: any): { r: number, g: number, b: number } {
		if (settings.nanColor === 'fuchsia') {
			return { r: 255, g: 0, b: 255 }; // Fuchsia
		} else {
			return { r: 0, g: 0, b: 0 }; // Black (default)
		}
	}

	_getTiffLayoutInfo(source: any): TiffLayoutInfo {
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

	_logTiffLayout(layout: TiffLayoutInfo): void {
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
	 * @param src - TIFF file URL
	 */
	async processTiff(src: string, pageIndex = 0): Promise<{ canvas: HTMLCanvasElement, imageData: ImageData, tiffData: any, decodeInfo: { engine: string, durationMs: number } }> {
		const startTime = performance.now();
		this._lastRenderHistogram = null;
		const loadSignal = this.loadSignal;
		let decodeInfo: { engine: string, durationMs: number } | null = null;
		try {
			if (this._sourceBufferSrc !== src) {
				this.omeMetadata = null;
				this.omeBinaryOnly = null;
				this.omeXml = null;
				this.geoReference = null;
			}
			const speculative = pageIndex === 0
				? await DecodeWorkerClient.takeSpeculativeDecode(src, loadSignal, 'tiff')
				: null;
			const deferredToParallel = speculative?.ok && speculative.result?.deferToParallelTiff === true;
			const bootstrapWasmResult: any = speculative?.ok && !deferredToParallel ? speculative.result : null;
			if (deferredToParallel) {
				PerfTrace.note('decode-tiff-bootstrap', `parallel route (${Number(speculative.result?.stripCount || 0)} strips)`);
			}
			let buffer: ArrayBuffer;
			let readDuration = 0;
			const speculativeSource = speculative?.sourceBuffer instanceof ArrayBuffer
				? speculative.sourceBuffer
				: speculative?.buffer instanceof ArrayBuffer ? speculative.buffer : null;
			if (speculativeSource?.byteLength) {
				// The bootstrap kept this copy before transferring its decode copy.
				// Retain it for page changes and fallbacks exactly as the ordinary
				// fetch path does.
				this._sourceBuffer = speculativeSource;
				this._sourceBufferSrc = src;
				buffer = speculativeSource.slice(0);
			} else if (this._sourceBufferSrc === src && this._sourceBuffer) {
				buffer = this._sourceBuffer.slice(0);
				PerfTrace.mark('tiff-source-cache-hit');
			} else {
				const readStart = performance.now();
				const sourceBuffer = await DecodeWorkerClient.fetchArrayBuffer(src, loadSignal, 'tiff');
				readDuration = performance.now() - readStart;
				// Keep one immutable source copy so changing pages never refetches the
				// whole TIFF. The per-decode slice can safely be transferred to the worker.
				this._sourceBuffer = sourceBuffer;
				this._sourceBufferSrc = src;
				buffer = sourceBuffer.slice(0);
			}
			const megabytes = buffer.byteLength / (1024 * 1024);
			PerfTrace.note('fetch-tiff-bytes', `${megabytes.toFixed(1)}MB`);
			if (readDuration > 0) {
				PerfTrace.note('fetch-tiff-arrayBuffer-rate', `${(megabytes / (readDuration / 1000)).toFixed(0)}MB/s`);
			}
			if (loadSignal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
			const fetchTime = performance.now() - startTime;
			console.log(`[TiffProcessor] Fetch time: ${fetchTime.toFixed(2)}ms`);
			if (!speculative) { PerfTrace.mark('fetch'); }

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
			if (!bootstrapWasmResult && this.decodeWorker && !this.decodeWorker.canDecode('tiff')) {
				await Promise.race([
					this.decodeWorker.start(),
					new Promise(resolve => setTimeout(resolve, 500)),
				]);
			}
			if (loadSignal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
			let wasmResult: any = bootstrapWasmResult;
			let workerTiffFailed = false;
			/** The worker refused only because the core module lacks a codec. */
			let workerNeedsCodecModule = false;
			if (wasmResult) {
				const decodedWith = wasmResult.decodedWith || 'wasm (bootstrap worker)';
				decodeInfo = {
					engine: decodedWith,
					durationMs: Number(speculative?.bootstrapDecodeDurationMs || 0),
				};
				if (Array.isArray(wasmResult.decodeTimings)) {
					for (const timing of wasmResult.decodeTimings) {
						const durationMs = Number(timing?.durationMs);
						if (Number.isFinite(durationMs)) {
							PerfTrace.detail(String(timing.name || 'decode-worker-detail'), durationMs);
						}
					}
				}
			}

			// Strip-parallel path: for large, byte-aligned strip/tile TIFFs
			// (predictor 1/2/3, including separate planes and orientation)
			// the strips are independently compressed, so a pool of workers can
			// decode disjoint ranges concurrently. Rust decides eligibility --
			// tiff_float_strip_plan returns nothing for any other shape -- and
			// this returns null whenever the pool is unavailable or the file is
			// too small to be worth it, leaving the normal route untouched.
			// Only a trivially small file is rejected on size: a well-compressed
			// TIFF can be 2MB and still hold 10M pixels, which is exactly the
			// case the pool helps most. The real gates (strip count, pixel
			// count) are applied against the plan inside tryStripParallelDecode.
			if (!wasmResult && pageIndex === 0 && buffer.byteLength >= 512 * 1024) {
				try {
					const mainWasm = getWasmModuleSync() || await getWasmModule();
					if (mainWasm) {
						const parallelStart = performance.now();
						const parallel = await tryStripParallelDecode(buffer, mainWasm);
						if (loadSignal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
						if (parallel) {
							// renderTiff still needs per-channel planes: it takes the
							// channel count from rasters.length and scans them for
							// non-finite samples. The planes use the SAME carrier type
							// as the interleaved buffer so that
							// `canUseStoredInterleaved` holds and the interleaved copy
							// is used directly rather than rebuilt (~213ms on a
							// 5120x5120 RGB8 image).
							const pixelCount = parallel.width * parallel.height;
							const Carrier = (parallel.data as any).constructor as
								{ new(length: number): Float32Array | Uint16Array | Uint8Array };
							const rasters: any[] = [];
							if (parallel.channels === 1) {
								rasters.push(parallel.data);
							} else {
								for (let c = 0; c < parallel.channels; c++) {
									const channel = new Carrier(pixelCount);
									for (let i = 0; i < pixelCount; i++) {
										channel[i] = parallel.data[i * parallel.channels + c];
									}
									rasters.push(channel);
								}
							}
							wasmResult = {
								pageIndex: 0,
								pageCount: parallel.pageCount,
								width: parallel.width,
								height: parallel.height,
								channels: parallel.channels,
								bitsPerSample: parallel.bitsPerSample,
								sampleFormat: parallel.sampleFormat,
								compression: parallel.compression,
								predictor: parallel.predictor,
								photometricInterpretation: parallel.photometricInterpretation,
								planarConfiguration: parallel.planarConfiguration,
								// A tiled file decodes a tile ROW per unit, so report
								// the real layout rather than the unit geometry.
								rowsPerStrip: parallel.tileLength ? undefined : parallel.rowsPerStrip,
								stripCount: parallel.tileLength ? undefined : parallel.stripCount,
								tileWidth: parallel.tileWidth,
								tileLength: parallel.tileLength,
								tileCount: parallel.tileCount,
								directDecode: true,
								data: parallel.data,
								rasters,
								min: parallel.min,
								max: parallel.max,
								allTagsJson: parallel.allTagsJson,
								omeXml: parallel.omeXml,
								geoJson: parallel.geoJson,
								decodedWith: `wasm (${parallel.workers} ${parallel.tileLength ? 'tile-row' : 'strip'} workers)`,
								decodeTimings: parallel.timings,
							};
							// localBuffer is cleared after its declaration below.
							decodeInfo = { engine: wasmResult.decodedWith, durationMs: performance.now() - parallelStart };
							PerfTrace.mark('decode-wasm-strip-pool');
							for (const timing of parallel.timings) {
								PerfTrace.detail(String(timing.name), Number(timing.durationMs) || 0);
							}
							console.log(`[TiffProcessor] Strip-parallel decode: ${decodeInfo.durationMs.toFixed(2)}ms across ${parallel.workers} workers`);
						}
					}
				} catch (error) {
					if ((error as any)?.name === 'AbortError') { throw error; }
					console.warn('[TiffProcessor] Strip-parallel decode failed, using the normal path:', error);
					wasmResult = null;
				}
			}
			let localBuffer: ArrayBuffer | null = buffer;
			// The strip pool already produced the pixels; drop the retained copy
			// so the geotiff.js fallback path below is not entered with stale bytes.
			if (wasmResult) { localBuffer = null; }
			// 24-bit grayscale is a post-decode reinterpretation (combine R/G/B
			// into one value), handled later in renderTiff/ImageRenderer, so the
			// Rust/WASM decoder can decode these images like any other RGB TIFF.
			if (!wasmResult && this.decodeWorker?.canDecode('tiff')) {
				const workerStart = performance.now();
				const workerResponse = await this.decodeWorker.decode('tiff', buffer, { pageIndex });
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
					// A codec the core module does not carry is NOT a reason to
					// reach for geotiff.js. Its decoder registry is a strict
					// subset of the Rust decoder's: for JPEG 2000, JPEG XR or
					// LZMA it would fail too, and for LERC it would quietly
					// decode through a second implementation this project does
					// not treat as authoritative. Take the local WASM path
					// instead — `TiffWasmProcessor.decode` retries in the
					// heavy-codec module itself.
					workerNeedsCodecModule = /\[external-codec:/.test(String(workerResponse?.error ?? ''));
					console.warn(
						workerNeedsCodecModule
							? '[TiffProcessor] Worker decode needs the heavy-codec module:'
							: '[TiffProcessor] Worker decode failed, falling back to geotiff.js:',
						workerResponse?.error);
				}
			}

			if (!wasmResult && (!workerTiffFailed || workerNeedsCodecModule) && !this.decodeWorker?.canDecode('tiff')) {
				await this._ensureLocalWasm();
			}
			if (workerNeedsCodecModule) { await this._ensureLocalWasm(); }
			const useWasm = !wasmResult && (!workerTiffFailed || workerNeedsCodecModule) && this._wasmAvailable;
			console.log(`[TiffProcessor] Decode decision: worker=${!!wasmResult}, wasmAvailable=${this._wasmAvailable}, 24BitMode=${use24BitMode}, willUseWasm=${useWasm}`);

			// Local WASM decoding when the worker isn't available
			if (useWasm && localBuffer) {
				try {
					const decodeStart = performance.now();
					// Use a copy so a WASM failure/memory-growth cannot invalidate the
					// original buffer that the geotiff.js fallback path needs below.
					wasmResult = await this._wasmProcessor.decode(localBuffer.slice(0), pageIndex);
					const decodeTime = performance.now() - decodeStart;
					decodeInfo = { engine: 'wasm (main thread)', durationMs: decodeTime };
					console.log(`[TiffProcessor] WASM decode time: ${decodeTime.toFixed(2)}ms`);
					PerfTrace.mark('decode-wasm-local');
				} catch (wasmError) {
					console.warn('[TiffProcessor] WASM decoding failed, falling back to geotiff.js:', wasmError);
					// Disable WASM for the rest of the session — a failure can leave
					// the module in an indeterminate state after a panic. A missing
					// codec is the exception: nothing is wrong with the module, the
					// file simply needs one this build does not have, and the next
					// file may well decode fine.
					if (!/\[external-codec:/.test(String((wasmError as any)?.message ?? wasmError))) {
						this._wasmAvailable = false;
					}
					wasmResult = null;
				}
			}

			if (wasmResult) {
				try {
					this.pageIndex = Number(wasmResult.pageIndex ?? pageIndex);
					this.pageCount = Math.max(1, Number(wasmResult.pageCount ?? 1));

					// Convert WASM result to format compatible with existing code
					const width = wasmResult.width;
					const height = wasmResult.height;
					const samplesPerPixel = wasmResult.channels;
					const bitsPerSample = wasmResult.bitsPerSample;
					const sampleFormat = wasmResult.sampleFormat;

					// Per-channel rasters: the worker already deinterleaved them
					// off-thread; the local WASM path deinterleaves here.
					let rasters: Array<Float32Array | Uint16Array | Uint8Array>;
					if (wasmResult.rasters) {
						rasters = wasmResult.rasters;
					} else if (samplesPerPixel === 1) {
						rasters = [wasmResult.data];
					} else {
						rasters = [];
						const Carrier = wasmResult.data.constructor as
							{ new(length: number): Float32Array | Uint16Array | Uint8Array };
						// Deinterleave for compatibility with existing rendering code
						for (let c = 0; c < samplesPerPixel; c++) {
							const channel = new Carrier(width * height);
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
					// PhotometricInterpretation 32803 means the file declares itself
					// a CFA mosaic, so the debayer panel can offer itself. Most
					// machine-vision TIFFs are untagged grayscale, so a negative
					// here proves nothing -- the user picks the pattern manually.
					announceCfaDetection(isDeclaredCfa(photometricInterpretation));
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
							t258: bitsPerSample,
							pageIndex: this.pageIndex,
							pageCount: this.pageCount
						},
						data: data
					};
					if (Number.isFinite(wasmResult.min) && Number.isFinite(wasmResult.max)) {
						this._lastStatistics = { min: wasmResult.min, max: wasmResult.max };
						this._lastStatisticsRgb24Mode = false;
					}
					this._lastAllTags = parseAllTagsJson(wasmResult.allTagsJson);
					this._setOmeXml(wasmResult.omeXml || findOmeXmlInTags(this._lastAllTags));
					this.geoReference = parseGeoReference((wasmResult as any).geoJson);
					this.rawTiffData.ome = this.omeMetadata;
					this._gdalNodata = parseGdalNodata(this._lastAllTags);
					if (this._gdalNodata !== undefined && this._lastStatistics &&
						(this._lastStatistics.min === this._gdalNodata || this._lastStatistics.max === this._gdalNodata)) {
						// WASM's fast min/max scan doesn't know about GDAL_NODATA, so the
						// sentinel can end up reported as the image's min or max. Drop the
						// cached stats so renderTiffWithSettings recomputes them below with
						// the nodata value excluded.
						this._lastStatistics = null;
					}

					// Send format information to VS Code
					if (this.vscode && this._isInitialLoad) {
						const formatType = tiffFormatTypeFor(sampleFormat, bitsPerSample);
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
								decodedWith: wasmResult.decodedWith || 'wasm',
								pageIndex: this.pageIndex,
								pageCount: this.pageCount,
								...this._omeFormatInfo()
							}
						});

						const canvas = document.createElement('canvas');
						canvas.width = width;
						canvas.height = height;
						const placeholderImageData = new ImageData(width, height);
						return { canvas, imageData: placeholderImageData, tiffData: this.rawTiffData, decodeInfo: decodeInfo as { engine: string, durationMs: number } };
					}

					const canvas = document.createElement('canvas');
					canvas.width = width;
					canvas.height = height;
					const imageData = await this.renderTiff(image, rasters);
					const totalTime = performance.now() - startTime;
					console.log(`[TiffProcessor] Total WASM processing time: ${totalTime.toFixed(2)}ms`);
					return { canvas, imageData, tiffData: this.rawTiffData, decodeInfo: decodeInfo as { engine: string, durationMs: number } };
				} catch (wasmError) {
					console.warn('[TiffProcessor] WASM decoding failed, falling back to geotiff.js:', wasmError);
					// Keep WHY the real decoder refused the file. If geotiff.js
					// then fails too, the Rust message is the one that actually
					// explains the file ("invalid code in LZW stream"), while
					// geotiff.js tends to fail later and less informatively —
					// reporting only the fallback's error told the user nothing.
					this._lastWasmFailure = String(wasmError instanceof Error ? wasmError.message : wasmError);
					// Disable WASM for the rest of the session — a failure can leave
					// the module in an indeterminate state after a panic.
					this._wasmAvailable = false;
					// Fall through to geotiff.js implementation below
				}
			}

			// Fallback to geotiff.js (or if WASM not available/failed)
			if (!localBuffer || localBuffer.byteLength === 0) {
				// The bytes were transferred to the worker. Reuse the immutable source
				// cache; refetch only if it was cleared (rare error path).
				if (this._sourceBufferSrc === src && this._sourceBuffer) {
					localBuffer = this._sourceBuffer.slice(0);
				} else {
					const refetched = await fetch(src, { signal: loadSignal });
					localBuffer = await refetched.arrayBuffer();
				}
			}
			const decodeStart = performance.now();
			let tiff;
			try {
				const GeoTIFF = await loadGeoTiff();
				tiff = await GeoTIFF.fromArrayBuffer(localBuffer);
			} catch (fallbackError) {
				throw new Error(this._lastWasmFailure
					? `${this._lastWasmFailure} (the geotiff.js fallback also failed: ${fallbackError instanceof Error ? fallbackError.message : fallbackError})`
					: String(fallbackError instanceof Error ? fallbackError.message : fallbackError));
			}
			this.pageCount = Math.max(1, await tiff.getImageCount());
			if (pageIndex < 0 || pageIndex >= this.pageCount) {
				throw new Error(`TIFF page index ${pageIndex} is out of range (page count: ${this.pageCount})`);
			}
			this.pageIndex = pageIndex;
			const image = await tiff.getImage(pageIndex);
			const firstImage = pageIndex === 0 ? image : await tiff.getImage(0);
			const firstDescription = String(firstImage?.fileDirectory?.ImageDescription || '');
			this._setOmeXml(firstDescription);
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
			const ArrayCtor = pickTiffArrayCtor(sampleFormat, bitsPerSample);
			const data = new ArrayCtor(width * height * samplesPerPixel);

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
					t258: bitsPerSample, // BitsPerSample
					pageIndex: this.pageIndex,
					pageCount: this.pageCount
				},
				data: data
			};
			this._lastAllTags = buildTagsFromGeotiffImage(image);
			this._setOmeXml(findOmeXmlInTags(this._lastAllTags));
			this.rawTiffData.ome = this.omeMetadata;
			this._gdalNodata = parseGdalNodata(this._lastAllTags);

			// Send format information to VS Code BEFORE rendering
			// This allows the extension to apply format-specific settings first
			if (this.vscode && this._isInitialLoad) {
				const formatType = tiffFormatTypeFor(sampleFormat, bitsPerSample);
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
						decodedWith: use24BitMode ? 'geotiff.js (24-bit mode)' : 'geotiff.js',
						pageIndex: this.pageIndex,
						pageCount: this.pageCount,
						...this._omeFormatInfo()
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

	_omeFormatInfo(): Record<string, any> {
		const ome = this.omeMetadata;
		if (!ome) { return {}; }
		return {
			isOmeTiff: true,
			formatLabel: 'OME-TIFF',
			omeSizeC: ome.planeSizeC,
			omeSizeZ: ome.sizeZ,
			omeSizeT: ome.sizeT,
			dimensionOrder: ome.dimensionOrder,
			channelNames: ome.channels.map(channel => channel.name),
			physicalSizeX: ome.physicalSizeX,
			physicalSizeXUnit: ome.physicalSizeXUnit,
			physicalSizeY: ome.physicalSizeY,
			physicalSizeYUnit: ome.physicalSizeYUnit,
			physicalSizeZ: ome.physicalSizeZ,
			physicalSizeZUnit: ome.physicalSizeZUnit,
		};
	}

	/**
	 * Render TIFF data to ImageData with current settings
	 * @param image - GeoTIFF image object
	 * @param rasters - Raster data
	 */
	async renderTiffWithSettings(image: any, rasters: any, renderOptions: DeferredRenderOptions = {}): Promise<ImageData> {
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
		// Signed integer samples and wide (>16-bit) unsigned integer samples are
		// both carried in a Float32Array (see tiffNeedsFloatCarrier/pickTiffArrayCtor)
		// — an unsigned Uint16/Uint8 carrier can't represent negative values, and
		// there's no unsigned carrier wider than Uint16Array in use here — so they
		// route through the same float rendering path as true IEEE float data.
		let isFloat = showNorm || tiffNeedsFloatCarrier(sampleFormat, bitsPerSample);

		// Integer samples can still arrive in a Float32Array carrier — geotiff.js
		// hands back floats, and signed/wide integers need one (see
		// tiffNeedsFloatCarrier) — and such a carrier CAN hold Infinity. When it
		// does, rendering must take the float path so nanColor applies. But when
		// every plane is a genuine integer typed array, no element can be
		// non-finite, so the scan is guaranteed to find nothing: skip it rather
		// than walk every sample (54ms on a 5120x5120 RGB8 image).
		const allIntegerCarriers = rastersCopy.length > 0 && rastersCopy.every(
			(plane: any) => ArrayBuffer.isView(plane)
				&& !(plane instanceof Float32Array)
				&& !(plane instanceof Float64Array));
		if (!isFloat && allIntegerCarriers) {
			PerfTrace.mark('finite-scan-skipped');
		} else if (!isFloat) {
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
		let stats: Stats | null = this._lastStatistics;
		const isGammaMode = settings.normalization?.gammaMode || false;
		// GDAL_NODATA sentinel (e.g. -32768), if the file declares one — excluded
		// from auto-normalize stats below so it can't drag the visible range down
		// to a value that never actually appears in the rendered image.
		const nodata = this._gdalNodata;

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
					// Normal mode: use individual channel values. channels === 2
					// is gray+alpha: scan only the gray raster (index 0), not
					// alpha, so it doesn't skew the normalization range.
					const scanChannels = rastersCopy.length === 2 ? 1 : Math.min(rastersCopy.length, 3);
					for (let i = 0; i < scanChannels; i++) {
						const raster = rastersCopy[i];
						for (let j = 0; j < raster.length; j++) {
							const value = raster[j];
							if (value === value && value !== Infinity && value !== -Infinity && value !== nodata) {
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
					// channels === 2 is gray+alpha: scan only the gray raster.
					const scanChannels = rastersCopy.length === 2 ? 1 : Math.min(rastersCopy.length, 3);
					for (let i = 0; i < scanChannels; i++) {
						const raster = rastersCopy[i];
						for (let j = 0; j < raster.length; j++) {
							const value = raster[j];
							if (value === value && value !== Infinity && value !== -Infinity && value !== nodata) {
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

		let interleavedData: Float32Array | Uint16Array | Uint8Array;
		const len = width * height;
		const storedData = this.rawTiffData?.data;
		// Unsigned integer carriers use Uint16Array for any bit depth above 8 (not
		// just exactly 16) so 9-15 bit samples (e.g. 12-bit) don't truncate — see
		// pickTiffArrayCtor.
		const canUseStoredInterleaved =
			storedData &&
			storedData.length === len * channels &&
			(isFloat
				? storedData instanceof Float32Array
				: (bitsPerSample > 8
					? storedData instanceof Uint16Array
					: (storedData instanceof Uint8Array || storedData instanceof Uint8ClampedArray)));

		if (canUseStoredInterleaved) {
			interleavedData = storedData;
			PerfTrace.mark('interleave-skipped');
		} else {
			if (isFloat) {
				interleavedData = new Float32Array(len * channels);
			} else if (bitsPerSample > 8) {
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

		// Create options object. typeMax must be passed explicitly: the carrier
		// array alone would make ImageRenderer assume 65535 for any Uint16Array,
		// but a 12-bit image's full range is 4095 (and signed data rides in a
		// Float32Array with an integer typeMax).
		const typeMax = tiffTypeMax(sampleFormat, bitsPerSample);
		const options: RenderOptions = {
			nanColor: nanColor,
			rgbAs24BitGrayscale: settings.rgbAs24BitGrayscale,
			typeMax: typeMax,
			collectHistogram: renderOptions.collectHistogram === true
		};

		const targetCanvas = renderOptions.targetCanvas;
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
				data: interleavedData as Float32Array,
				width,
				height,
				// Must be forwarded: _getTextureFormat treats a MISSING isFloat as
				// float (`isFloat !== false`), so omitting it gave integer data an
				// r32f texture, failed the upload and silently fell back to the CPU
				// renderer -- ~190ms on a 5120x5120 uint16 image.
				isFloat,
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
	 * @param image - GeoTIFF image object
	 * @param rasters - Raster data
	 */
	async renderTiffWithSettingsFast(image: any, rasters: any, renderOptions: DeferredRenderOptions = {}): Promise<ImageData> {
		// Redirect to main render method for now to ensure correctness and use centralized ImageRenderer
		return this.renderTiffWithSettings(image, rasters, renderOptions);
	}

	async renderTiff(image: any, rasters: any, renderOptions: DeferredRenderOptions = {}): Promise<ImageData> {
		return this.renderTiffWithSettings(image, rasters, renderOptions);
	}

	/**
	 * Get color at specific pixel coordinates
	 */
	getColorAtPixel(x: number, y: number, naturalWidth: number, naturalHeight: number): string {
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
				const maxValue = tiffTypeMax(format, bitsPerSample);
				const normalized = value / maxValue;
				return normalized.toPrecision(4);
			}

			return format === 3 ? value.toPrecision(4) : value.toString();
		} else if (samples === 2) { // Gray + alpha
			const formatSample = (value: number) =>
				format === 3 ? value.toPrecision(4) : value.toString();
			let gray, alpha;
			if (planarConfig === 2) { // Planar data
				const planeSize = naturalWidth * naturalHeight;
				gray = data[pixelIndex];
				alpha = data[pixelIndex + planeSize];
			} else { // Interleaved data
				gray = data[pixelIndex * 2];
				alpha = data[pixelIndex * 2 + 1];
			}

			if (settings.normalizedFloatMode && format !== 3) {
				const maxValue = tiffTypeMax(format, bitsPerSample);
				return `${(gray / maxValue).toPrecision(4)} ${(alpha / maxValue).toPrecision(4)}`;
			}

			return `${formatSample(gray)} ${formatSample(alpha)}`;
		} else if (samples >= 3) {
			// Integers stay plain integer strings; zero-padding is only safe for
			// unsigned values (padStart would mangle a negative like -5 to "0-5").
			const formatSample = (value: number) =>
				format === 3 ? value.toPrecision(4) : (format === 2 ? value.toString() : value.toString().padStart(3, '0'));
			const values = [];
			if (planarConfig === 2) { // Planar data
				const planeSize = naturalWidth * naturalHeight;
				for (let i = 0; i < samples; i++) {
					values.push(formatSample(data[pixelIndex + i * planeSize]));
				}
			} else { // Interleaved data
				for (let i = 0; i < samples; i++) {
					values.push(formatSample(data[pixelIndex * samples + i]));
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
	 * @param existingImageData - Current image data
	 * @returns Always returns null to force full re-render
	 */
	async fastParameterUpdate(existingImageData: ImageData): Promise<ImageData | null> {
		// Fast update is disabled because it causes double-application of corrections
		// and produces incorrect results (white/black flash, wrong colors).
		// Always return null to force a full re-render from raw TIFF data.
		return null;
	}

	/**
	 * Perform the initial render if it was deferred
	 * Called when format-specific settings have been applied
	 * @returns The rendered image data, or null if no pending render
	 */
	async performDeferredRender(renderOptions: DeferredRenderOptions = {}): Promise<ImageData | null> {
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
