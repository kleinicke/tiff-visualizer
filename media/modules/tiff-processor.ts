"use strict";
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';
import { resolveNanColor } from './nan-color.js';
import { TiffWasmProcessor, getWasmModule, getWasmModuleSync } from './tiff-wasm-wrapper.js';
import { announceCfaDetection, isDeclaredCfa } from './debayer.js';
import { tryStripParallelDecode } from './strip-parallel-decode.js';
import { PerfTrace } from './perf-trace.js';
import { WebGL2FloatRenderer } from './webgl2-float-renderer.js';
import { parseAllTagsJson, buildTagsFromGeotiffImage, parseGdalNodata, parseExtraSamplesAreAlpha, TagEntry } from './tiff-tag-utils.js';
import { chooseOpenLevel, chooseRemoteOpenLevel, levelsForPage, pageOwningIfd, parsePageDirectory, TiffPageEntry } from './tiff-pages.js';
import type { TiffLevelHint } from './tiff-pages.js';
import { applyBandScaling, bandDescription, hasBandScaling, parseGdalMetadata, GdalMetadata } from './gdal-metadata.js';
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

interface CachedRegionSamples {
	pageIndex: number;
	x: number;
	y: number;
	width: number;
	height: number;
	channels: number;
	sampleFormat: number;
	/** Interleaved float carrier used by the local WASM decoder. */
	data?: Float32Array;
	/** Native planar arrays returned by geotiff.js for remote COG regions. */
	planes?: ArrayLike<number>[];
	bytes: number;
}

// A 50 MP single-band uint16 overview is ~96 MiB. The pyramid scene can retain
// another 32 MP of visible detail, which is ~61 MiB in the same source format.
// This fits both while remaining bounded for multi-band or exceptional scenes.
const REGION_SAMPLE_CACHE_MAX_BYTES = 160 * 1024 * 1024;

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
	_pendingRenderData: { image: any, rasters: any, progressiveRemote?: boolean } | null;
	_isInitialLoad: boolean;
	_lastImageData: ImageData | null;
	_lastStatistics: Stats | null;
	_lastStatisticsRgb24Mode: boolean;
	_lastRenderHistogram: any;
	_lastAllTags: TagEntry[];
	_lastRenderUsedWebGL: boolean;
	_gdalNodata: number | undefined;
	_extraSamplesAreAlpha: boolean | undefined;
	/** Zero-based data band shown for non-colour, multi-sample TIFFs. */
	displayBand: number;
	/**
	 * Every image in the file, classified. `pageCount` counts IFDs; this says
	 * which of them are pages and which are pyramid levels of an earlier one.
	 */
	pageDirectory: TiffPageEntry[];
	/**
	 * GDAL's per-band scale, offset, description and unit (tag 42112). Applied
	 * to REPORTED values only; the render pipeline stays in file units.
	 */
	gdalMetadata: GdalMetadata | null;
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
	_remoteTiff: any = null;
	_remoteTiffUrl: string | null = null;
	_remoteDecodePool: any = null;
	/** Worker-side source residency for repeated viewport/pixel region reads. */
	_regionSourceGeneration = 0;
	_regionWorkerPrimed = false;
	_regionDecodeQueue: Promise<void> = Promise.resolve();
	/** Raw values for recently rendered regions, used by the exact color picker. */
	private _regionSampleCache = new Map<string, CachedRegionSamples>();
	private _regionSampleCacheBytes = 0;
	private _regionSampleCacheMaxBytes = REGION_SAMPLE_CACHE_MAX_BYTES;
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
		// ExtraSamples (tag 338): whether the samples past the colour samples
		// are alpha. undefined = the file did not say.
		this._extraSamplesAreAlpha = undefined;
		this.displayBand = 0;
		this.pageDirectory = [];
		this.gdalMetadata = null;
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

	/** True when pixels are fetched lazily from an HTTP Range-backed COG. */
	get isRemoteSource(): boolean {
		return !!this._remoteTiff && !!this._remoteTiffUrl;
	}

	/** The initial remote overview is being filled block-by-block by the view. */
	get isProgressiveRemoteBase(): boolean {
		return !!this.rawTiffData?.progressiveRemote;
	}

	get hasGeneratedPreview(): boolean {
		return this.pageDirectory.some(entry => entry.generated === true);
	}

	/**
	 * Number of independently viewable data bands in the current TIFF.
	 * RGB/RGBA and genuine gray+alpha images are colour layouts, not band
	 * stacks. TIFF/GDAL writes ExtraSamples=0 for additional data samples;
	 * named GDAL samples are also strong evidence when that tag is absent.
	 */
	get selectableBandCount(): number {
		const ifd = this.rawTiffData?.ifd;
		const samples = Math.max(1, Number(ifd?.t277 || 1));
		if (samples < 2) { return 0; }
		const photometric = Number(ifd?.t262);
		const grayscale = photometric === 0 || photometric === 1;
		const hasNamedExtraBand = !!this.gdalMetadata?.bands.some(band => band.sample > 0);
		if (!grayscale || this._extraSamplesAreAlpha === true) { return 0; }
		return this._extraSamplesAreAlpha === false || hasNamedExtraBand ? samples : 0;
	}

	/** Select a data band without modifying or discarding decoded samples. */
	setDisplayBand(index: number): boolean {
		const count = this.selectableBandCount;
		if (count < 2 || !Number.isFinite(index)) { return false; }
		const next = Math.min(count - 1, Math.max(0, Math.floor(index)));
		if (next === this.displayBand) { return false; }
		this.displayBand = next;
		// Auto-normalization is per displayed band. Keeping the previous band's
		// range would make the switch misleading even though the pixels are right.
		this._lastStatistics = null;
		this._lastRenderHistogram = null;
		return true;
	}

	private _clearRegionSampleCache(): void {
		this._regionSampleCache.clear();
		this._regionSampleCacheBytes = 0;
	}

	private _cacheRegionSamples(pageIndex: number, x: number, y: number, region: any): void {
		const data = region?.data;
		const width = Number(region?.width);
		const height = Number(region?.height);
		const channels = Number(region?.channels);
		if (!(data instanceof Float32Array) || !(width > 0) || !(height > 0) || !(channels > 0)) { return; }
		const sourceRasters = Array.from(region?.sourceRasters || []) as ArrayLike<number>[];
		const nativePlanes = sourceRasters.length === channels
			&& sourceRasters.every(plane => ArrayBuffer.isView(plane));
		const planes = nativePlanes ? sourceRasters : undefined;
		const bytes = planes
			? planes.reduce((total, plane) => total + (plane as ArrayBufferView).byteLength, 0)
			: data.byteLength;
		if (!(bytes > 0) || bytes > this._regionSampleCacheMaxBytes) { return; }
		const key = `${pageIndex}:${x}:${y}:${width}:${height}`;
		const previous = this._regionSampleCache.get(key);
		if (previous) { this._regionSampleCacheBytes -= previous.bytes; }
		this._regionSampleCache.delete(key);
		this._regionSampleCache.set(key, {
			pageIndex, x, y, width, height, channels,
			sampleFormat: Number(region.sampleFormat),
			data: planes ? undefined : data,
			planes,
			bytes,
		});
		this._regionSampleCacheBytes += bytes;
		while (this._regionSampleCacheBytes > this._regionSampleCacheMaxBytes) {
			// The base canvas remains visible around finer tiles throughout a zoom
			// transition, so its raw samples must have the same lifetime. Evict old
			// detail first; only evict base samples if the base itself exceeds the
			// hard cache budget.
			const oldest = [...this._regionSampleCache.entries()]
				.find(([, cached]) => cached.pageIndex !== this.pageIndex)
				|| this._regionSampleCache.entries().next().value as [string, CachedRegionSamples] | undefined;
			if (!oldest) { break; }
			this._regionSampleCache.delete(oldest[0]);
			this._regionSampleCacheBytes -= oldest[1].bytes;
		}
	}

	private _readCachedPagePixel(pageIndex: number, x: number, y: number): string | null {
		const storedX = Math.floor(x);
		const storedY = Math.floor(y);
		let match: { key: string, region: CachedRegionSamples } | null = null;
		for (const [key, region] of this._regionSampleCache) {
			if (region.pageIndex !== pageIndex || storedX < region.x || storedY < region.y
				|| storedX >= region.x + region.width || storedY >= region.y + region.height) { continue; }
			match = { key, region };
		}
		if (!match) { return null; }
		// Reading is use: keep a tile under the cursor at the MRU end.
		this._regionSampleCache.delete(match.key);
		this._regionSampleCache.set(match.key, match.region);
		const localX = storedX - match.region.x;
		const localY = storedY - match.region.y;
		const pixelOffset = localY * match.region.width + localX;
		const samples: number[] = [];
		for (let channel = 0; channel < match.region.channels; channel++) {
			const value = match.region.planes
				? match.region.planes[channel]?.[pixelOffset]
				: match.region.data?.[pixelOffset * match.region.channels + channel];
			samples.push(Number(value));
		}
		const declared = this._formatDeclaredSamples(samples);
		if (declared !== null) { return declared; }
		return samples
			.map(value => match!.region.sampleFormat === 3 ? value.toPrecision(4) : String(value))
			.join(' ');
	}

	/** Return an exact stored value synchronously when its rendered full tile is resident. */
	readCachedFullResolutionPixel(x: number, y: number): string | null {
		const current = this.pageDirectory.find(entry => entry.index === this.pageIndex);
		const pageIndex = current?.parent ?? this.pageIndex;
		return this._readCachedPagePixel(pageIndex, x, y);
	}

	/**
	 * Best already-rendered value at a full-scene coordinate, finest level first.
	 * This never performs IO: cursor motion reports the finest source sample that
	 * viewport streaming has already made resident.
	 */
	readCachedScenePixel(x: number, y: number): { value: string, exact: boolean, note?: string } | null {
		const page = pageOwningIfd(this.pageDirectory, this.pageIndex);
		const levels = levelsForPage(this.pageDirectory, page);
		for (const level of levels) {
			const reduction = Math.max(1, level.reduction);
			const value = this._readCachedPagePixel(
				level.index,
				Math.floor(x / reduction),
				Math.floor(y / reduction),
			);
			if (value === null) { continue; }
			return {
				value,
				exact: reduction === 1,
				note: reduction > 1 ? `1/${reduction} overview` : '',
			};
		}
		// Whole-decoded local TIFF levels already have their native samples in
		// rawTiffData. Preserve the old picker's zero-IO path for those images.
		const current = this.pageDirectory.find(entry => entry.index === this.pageIndex);
		const raw = this.rawTiffData?.data;
		if (current && raw?.length) {
			const reduction = Math.max(1, current.reduction);
			const levelX = Math.floor(x / reduction);
			const levelY = Math.floor(y / reduction);
			if (levelX >= 0 && levelY >= 0 && levelX < current.width && levelY < current.height) {
				const value = this.getColorAtPixel(levelX, levelY, current.width, current.height);
				if (value) {
					return {
						value,
						exact: reduction === 1,
						note: reduction > 1 ? `1/${reduction} overview` : '',
					};
				}
			}
		}
		return null;
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
	_getNanColor(settings: any): { r: number, g: number, b: number, a: number } {
		// One resolver for every format; see nan-color.ts.
		return resolveNanColor(settings);
	}

	/**
	 * How a pixel reads when the FILE says something about its samples: a
	 * nodata sentinel, or a per-band scale and offset. Returns null when the
	 * file declares neither and the caller should fall back to its own
	 * type-based formatting.
	 *
	 * Shared by the ordinary readout and by the exact region read, so a value
	 * cannot mean one thing when it comes from the displayed level and another
	 * when it comes from the file.
	 */
	_formatDeclaredSamples(values: number[]): string | null {
		// A pixel holding the nodata sentinel has no measurement to report.
		// Printing the sentinel scaled ("-32.768") reads as a real reading; the
		// render already draws these in the nodata/NaN colour.
		if (this._gdalNodata !== undefined && values[0] === this._gdalNodata) {
			return 'nodata';
		}
		if (!hasBandScaling(this.gdalMetadata)) { return null; }
		return values
			.map((value, sample) => applyBandScaling(this.gdalMetadata, sample, value))
			.map(value => Number(value.toPrecision(6)).toString())
			.join(' ');
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
	/**
	 * How the caller wants a pyramidal file opened. The processor cannot know
	 * how big the window is or what this browser will put on a canvas, so the
	 * display side supplies both as NUMBERS — the decision is made in the decode
	 * worker, and a predicate cannot cross that boundary.
	 */
	async processTiff(
		src: string,
		pageIndex = 0,
		levelHint?: TiffLevelHint,
	): Promise<{ canvas: HTMLCanvasElement, imageData: ImageData, tiffData: any, decodeInfo: { engine: string, durationMs: number } }> {
		const startTime = performance.now();
		this._lastRenderHistogram = null;
		const loadSignal = this.loadSignal;
		const remoteUrl = this.settingsManager.settings.remoteTiffUrl;
		if (remoteUrl) {
			return this._processRemoteTiff(remoteUrl, pageIndex, levelHint, startTime);
		}
		this._remoteDecodePool?.destroy?.();
		this._remoteDecodePool = null;
		this._remoteTiff = null;
		this._remoteTiffUrl = null;
		let decodeInfo: { engine: string, durationMs: number } | null = null;
		try {
			if (this._sourceBufferSrc !== src) {
				this.displayBand = 0;
				this._clearRegionSampleCache();
				this._regionSourceGeneration++;
				this._regionWorkerPrimed = false;
				this.omeMetadata = null;
				this.omeBinaryOnly = null;
				this.omeXml = null;
				this.geoReference = null;
				// Whole-file facts: a new file has a different pyramid, or none.
				this.pageDirectory = [];
				this.gdalMetadata = null;
			}
			const speculative = pageIndex === 0
				? await DecodeWorkerClient.takeSpeculativeDecode(src, loadSignal, 'tiff')
				: null;
			const deferredToParallel = speculative?.ok && speculative.result?.deferToParallelTiff === true;
			let bootstrapWasmResult: any = speculative?.ok && !deferredToParallel ? speculative.result : null;
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

			const withinDisplayLimits = (width: number, height: number) => !levelHint
				|| (width <= levelHint.maxAxis && height <= levelHint.maxAxis
					&& width * height <= levelHint.maxArea
					&& width * height * 4 <= levelHint.maxBytes);
			if (levelHint && bootstrapWasmResult && pageIndex === 0
				&& !withinDisplayLimits(Number(bootstrapWasmResult.width), Number(bootstrapWasmResult.height))) {
				const directory = parsePageDirectory(bootstrapWasmResult.pageDirectoryJson);
				const chosen = chooseOpenLevel(directory, 0, levelHint.displayWidth, withinDisplayLimits,
					1, levelHint.pixelBudget);
				if (chosen && chosen.index !== 0) {
					console.log(`[TiffProcessor] Bootstrap decode is not displayable; reopening at level `
						+ `1/${chosen.reduction} (${chosen.width}x${chosen.height})`);
					PerfTrace.note('tiff-open-level', `1/${chosen.reduction} ${chosen.width}x${chosen.height}`);
					pageIndex = chosen.index;
					this.pageIndex = chosen.index;
					bootstrapWasmResult = null;
				}
			}

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
					if (mainWasm && levelHint) {
						// The plan below describes PAGE 0, so a pyramidal file
						// whose best level is an overview must not take this
						// path — it would decode the full-resolution page in
						// parallel, which is the work being avoided. Deciding
						// here costs an IFD walk (about 2 ms on a 40 MB file) on
						// a module this branch has already loaded; a file with
						// no pyramid falls straight through.
						const chosen = this._chooseOpenLevel(mainWasm, buffer, levelHint);
						if (chosen > 0) {
							pageIndex = chosen;
							this.pageIndex = chosen;
						}
					}
					if (mainWasm && pageIndex === 0 && !(mainWasm.tiff_preview_reduction?.(new Uint8Array(buffer)) > 0)) {
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
								pageDirectoryJson: parallel.pageDirectoryJson,
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
					// A level hint lets the worker pick a page; adopt what it
					// decoded so the UI and every later navigation agree with it.
					const decodedPage = Number(wasmResult.pageIndex);
					if (Number.isFinite(decodedPage) && decodedPage !== pageIndex) {
						console.log(`[TiffProcessor] Opened at level index ${decodedPage}: full resolution `
							+ `is either not displayable or larger than is worth decoding for this window`);
						PerfTrace.note('tiff-open-level', `page ${decodedPage}`);
						pageIndex = decodedPage;
						this.pageIndex = decodedPage;
					}
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
							? '[TiffProcessor] Worker decode needs an external codec module:'
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
							t262: photometricInterpretation,
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
					this._extraSamplesAreAlpha = parseExtraSamplesAreAlpha(this._lastAllTags);
					this.pageDirectory = parsePageDirectory((wasmResult as any).pageDirectoryJson);
					this.gdalMetadata = parseGdalMetadata(this._lastAllTags);
					if (this.selectableBandCount > 1) { this._lastStatistics = null; }
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
					t262: photometricInterpretation,
					pageIndex: this.pageIndex,
					pageCount: this.pageCount
				},
				data: data
			};
			this._lastAllTags = buildTagsFromGeotiffImage(image);
			this._setOmeXml(findOmeXmlInTags(this._lastAllTags));
			this.rawTiffData.ome = this.omeMetadata;
			this._gdalNodata = parseGdalNodata(this._lastAllTags);
			this._extraSamplesAreAlpha = parseExtraSamplesAreAlpha(this._lastAllTags);
			// geotiff.js exposes no NewSubfileType walk, so it cannot BUILD a page
			// directory — but a directory describes the FILE, not the decode
			// that produced it, and this path can be reached for one level of a
			// file whose other levels went through Rust. Clearing it there
			// turned the Level control into a page selector mid-session, which
			// is exactly the confusion the classification exists to prevent.
			// Any directory already read for this file is therefore kept; the
			// source check at the top of processTiff clears it when the file
			// actually changes.
			this.gdalMetadata = parseGdalMetadata(this._lastAllTags);
			if (this.selectableBandCount > 1) { this._lastStatistics = null; }

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

	/**
	 * Open an HTTP COG through geotiff.js's blocked Range source. Unlike the
	 * ordinary/local path, this never materializes the complete file: directory
	 * blocks and the selected overview are fetched independently and cached.
	 */
	private async _processRemoteTiff(
		url: string,
		pageIndex: number,
		levelHint: TiffLevelHint | undefined,
		startTime: number,
	): Promise<{ canvas: HTMLCanvasElement, imageData: ImageData, tiffData: any, decodeInfo: { engine: string, durationMs: number } }> {
		const GeoTIFF = await loadGeoTiff();
		if (this._remoteTiffUrl !== url || !this._remoteTiff) {
			this.displayBand = 0;
			this._clearRegionSampleCache();
			this._remoteDecodePool?.destroy?.();
			this._remoteTiff = await GeoTIFF.fromUrl(url, {
				blockSize: 64 * 1024,
				cacheSize: 256,
				allowFullFile: false,
			}, this.loadSignal);
			this._remoteTiffUrl = url;
			// geotiff.js's browser bundle creates blob-backed decoder workers;
			// network stays range-backed while decompression stays off the UI.
			this._remoteDecodePool = typeof GeoTIFF.Pool === 'function'
				? new GeoTIFF.Pool(Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2)))
				: null;
			this._sourceBuffer = null;
			this._sourceBufferSrc = null;
			this._regionSourceGeneration++;
			this._regionWorkerPrimed = false;
			this.pageDirectory = await this._buildRemotePageDirectory(this._remoteTiff);
		}

		const tiff = this._remoteTiff;
		this.pageCount = Math.max(1, await tiff.getImageCount());
		if (levelHint && pageIndex === 0 && this.pageDirectory.length > 1) {
			const canDisplay = (width: number, height: number) =>
				width <= levelHint.maxAxis && height <= levelHint.maxAxis
					&& width * height <= levelHint.maxArea
					&& width * height * 4 <= levelHint.maxBytes;
			const chosen = chooseRemoteOpenLevel(this.pageDirectory, 0, levelHint.displayWidth,
				canDisplay, levelHint.pixelBudget);
			if (chosen) { pageIndex = chosen.index; }
		}
		if (pageIndex < 0 || pageIndex >= this.pageCount) {
			throw new Error(`TIFF page index ${pageIndex} is out of range (page count: ${this.pageCount})`);
		}

		this.pageIndex = pageIndex;
		const decodeStart = performance.now();
		const image = await tiff.getImage(pageIndex);
		const firstImage = pageIndex === 0 ? image : await tiff.getImage(0);
		this._setOmeXml(String(firstImage?.fileDirectory?.ImageDescription || ''));
		const width = image.getWidth();
		const height = image.getHeight();
		// A very large lowest overview is not a useful atomic unit. Mount its
		// correctly sized canvas from metadata and let the view request its stored
		// blocks. Ordinary remote TIFFs keep the existing whole-image fast path.
		const progressiveRemote = !!levelHint && width * height > levelHint.pixelBudget;
		const rasters = progressiveRemote
			? null
			: await this._readRemoteRasters(image, { signal: this.loadSignal });
		const decodeInfo = {
			engine: 'geotiff.js (HTTP ranges)',
			durationMs: performance.now() - decodeStart,
		};
		PerfTrace.mark('decode-geotiff-ranges');
		PerfTrace.note('tiff-byte-source', 'HTTP Range');

		const sampleFormat = image.getSampleFormat();
		const samplesPerPixel = image.getSamplesPerPixel();
		const bitsPerSample = image.getBitsPerSample();
		const ArrayCtor = pickTiffArrayCtor(sampleFormat, bitsPerSample);
		const data = progressiveRemote ? new ArrayCtor(0) : new ArrayCtor(width * height * samplesPerPixel);
		if (!progressiveRemote && samplesPerPixel === 1) {
			data.set(rasters[0]);
		} else if (!progressiveRemote) {
			for (let i = 0; i < rasters[0].length; i++) {
				for (let sample = 0; sample < samplesPerPixel; sample++) {
					data[i * samplesPerPixel + sample] = rasters[sample][i];
				}
			}
		}

		const fileDir = image.fileDirectory || {};
		this.rawTiffData = {
			image,
			rasters,
			ifd: {
				width, height,
				t339: Array.isArray(sampleFormat) ? sampleFormat[0] : sampleFormat,
				t277: samplesPerPixel,
				t284: 1,
				t258: bitsPerSample,
				t262: fileDir.PhotometricInterpretation,
				pageIndex,
				pageCount: this.pageCount,
			},
			data,
			progressiveRemote,
		};
		this._lastAllTags = buildTagsFromGeotiffImage(image);
		this._setOmeXml(findOmeXmlInTags(this._lastAllTags));
		this.rawTiffData.ome = this.omeMetadata;
		this._gdalNodata = parseGdalNodata(this._lastAllTags);
		this._extraSamplesAreAlpha = parseExtraSamplesAreAlpha(this._lastAllTags);
		this.gdalMetadata = parseGdalMetadata(this._lastAllTags);
		if (this.selectableBandCount > 1) { this._lastStatistics = null; }
		// Build the affine from the FULL page. The displayed overview has a
		// coarser pixel scale, while scene/picker coordinates are full-resolution.
		try {
			const origin = firstImage.getOrigin();
			const resolution = firstImage.getResolution();
			const keys = firstImage.getGeoKeys?.() || {};
			const projected = Number(keys.ProjectedCSTypeGeoKey || 0);
			const geographic = Number(keys.GeographicTypeGeoKey || 0);
			this.geoReference = {
				crs: projected ? `EPSG:${projected}` : geographic ? `EPSG:${geographic}` : undefined,
				isGeographic: !projected && !!geographic,
				pixelIsPoint: Number(keys.GTRasterTypeGeoKey || 1) === 2,
				unit: !projected && geographic ? 'degree' : 'metre',
				transform: [Number(resolution[0]), 0, Number(origin[0]), 0, Number(resolution[1]), Number(origin[1])],
			};
		} catch {
			this.geoReference = null;
		}
		const layoutInfo = this._getTiffLayoutInfo(image);
		this._logTiffLayout(layoutInfo);

		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		if (this.vscode && this._isInitialLoad) {
			this._pendingRenderData = { image, rasters, progressiveRemote };
			this.vscode.postMessage({
				type: 'formatInfo',
				value: {
					width, height, sampleFormat,
					compression: fileDir.Compression || 'Unknown',
					predictor: fileDir.Predictor,
					photometricInterpretation: fileDir.PhotometricInterpretation,
					planarConfig: fileDir.PlanarConfiguration,
					samplesPerPixel, bitsPerSample,
					...layoutInfo,
					formatType: tiffFormatTypeFor(sampleFormat, bitsPerSample),
					isInitialLoad: true,
					decodedWith: decodeInfo.engine,
					pageIndex,
					pageCount: this.pageCount,
					...this._omeFormatInfo(),
				},
			});
			return {
				canvas,
				// Do not allocate a second full-overview RGBA placeholder while the
				// canvas itself is waiting for its first progressively decoded block.
				imageData: progressiveRemote ? new ImageData(1, 1) : new ImageData(width, height),
				tiffData: this.rawTiffData,
				decodeInfo,
			};
		}

		if (progressiveRemote) {
			this._isInitialLoad = false;
			return { canvas, imageData: new ImageData(1, 1), tiffData: this.rawTiffData, decodeInfo };
		}
		const imageData = await this.renderTiff(image, rasters);
		console.log(`[TiffProcessor] HTTP-range TIFF ready in ${(performance.now() - startTime).toFixed(2)}ms`);
		return { canvas, imageData, tiffData: this.rawTiffData, decodeInfo };
	}

	private async _buildRemotePageDirectory(tiff: any): Promise<TiffPageEntry[]> {
		const count = Math.max(1, await tiff.getImageCount());
		const entries: TiffPageEntry[] = [];
		let parent: TiffPageEntry | null = null;
		for (let index = 0; index < count; index++) {
			const image = await tiff.getImage(index);
			const width = Number(image.getWidth());
			const height = Number(image.getHeight());
			const fd = image.fileDirectory || {};
			const subfileType = Number(fd.NewSubfileType || 0);
			const reduced = !!(subfileType & 1)
				|| (!!parent && width < parent.width && height < parent.height);
			const mask = !!(subfileType & 4);
			if (!parent || (!reduced && !mask)) {
				parent = {
					index, width, height,
					samplesPerPixel: Number(image.getSamplesPerPixel()) || 1,
					subfileType,
					kind: 'image', parent: null, reduction: 1,
					subIfdCount: Number(fd.SubIFDs?.length || 0),
					blockWidth: Number(fd.TileWidth || width),
					blockHeight: Number(fd.TileLength || fd.RowsPerStrip || height),
				};
				entries.push(parent);
				continue;
			}
			entries.push({
				index, width, height,
				samplesPerPixel: Number(image.getSamplesPerPixel()) || 1,
				subfileType,
				kind: mask ? 'mask' : 'overview',
				parent: parent.index,
				reduction: Math.max(1, Math.round(parent.width / Math.max(1, width))),
				subIfdCount: Number(fd.SubIFDs?.length || 0),
				blockWidth: Number(fd.TileWidth || width),
				blockHeight: Number(fd.TileLength || fd.RowsPerStrip || height),
			});
		}
		return entries;
	}

	private async _readRemoteRasters(image: any, options: Record<string, any>): Promise<any> {
		if (this._remoteDecodePool) {
			try {
				return await image.readRasters({ ...options, pool: this._remoteDecodePool });
			} catch (error) {
				if ((error as any)?.name === 'AbortError') { throw error; }
				console.warn('[TiffProcessor] Remote decode pool unavailable; decoding fetched blocks locally:', error);
				this._remoteDecodePool.destroy?.();
				this._remoteDecodePool = null;
			}
		}
		return image.readRasters(options);
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
		const width = image.getWidth();
		const height = image.getHeight();
		const sampleFormat = image.getSampleFormat();
		const bitsPerSample = image.getBitsPerSample();
		const bandCount = this.selectableBandCount;
		const selectedBand = bandCount > 1
			? Math.min(bandCount - 1, Math.max(0, this.displayBand))
			: 0;
		// Rasters are already planar. Selecting a scientific band is therefore a
		// zero-copy view of one decoded plane; the original multi-band buffer stays
		// intact for the picker, measurement tools, and another band switch.
		const rastersCopy = bandCount > 1 && rasters?.[selectedBand]
			? [rasters[selectedBand]]
			: rasters;
		const renderSampleFormat = bandCount > 1 && Array.isArray(sampleFormat)
			? (sampleFormat[selectedBand] ?? sampleFormat[0])
			: sampleFormat;
		PerfTrace.mark('raster-copy-skipped');
		const channels = rastersCopy.length;

		const showNorm = Array.isArray(renderSampleFormat) ? renderSampleFormat.includes(3) : renderSampleFormat === 3;
		// Signed integer samples and wide (>16-bit) unsigned integer samples are
		// both carried in a Float32Array (see tiffNeedsFloatCarrier/pickTiffArrayCtor)
		// — an unsigned Uint16/Uint8 carrier can't represent negative values, and
		// there's no unsigned carrier wider than Uint16Array in use here — so they
		// route through the same float rendering path as true IEEE float data.
		let isFloat = showNorm || tiffNeedsFloatCarrier(renderSampleFormat, bitsPerSample);

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
		const storedData = bandCount > 1 ? rastersCopy[0] : this.rawTiffData?.data;
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
		const typeMax = tiffTypeMax(renderSampleFormat, bitsPerSample);
		const options: RenderOptions = {
			nanColor: nanColor,
			rgbAs24BitGrayscale: settings.rgbAs24BitGrayscale,
			typeMax: typeMax,
			collectHistogram: renderOptions.collectHistogram === true,
			extraSamplesAreAlpha: bandCount > 1 ? false : this._extraSamplesAreAlpha,
			nodataValue: this._gdalNodata
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
				// Same rule as the CPU path: a nodata sentinel is absence, not a
				// dark measurement. Without this the GPU and CPU renderers would
				// disagree on the same file.
				nodataValue: this._gdalNodata,
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
	 * The page index to open at, from a directory read through an
	 * already-initialized module. 0 means "the file as it is" — no pyramid, or
	 * one whose full resolution is the right thing to show.
	 */
	_chooseOpenLevel(wasm: any, buffer: ArrayBuffer, hint: TiffLevelHint): number {
		if (typeof wasm?.tiff_page_directory !== 'function') { return 0; }
		let directory: TiffPageEntry[] = [];
		try {
			directory = parsePageDirectory(wasm.tiff_page_directory(new Uint8Array(buffer)));
		} catch {
			return 0;
		}
		if (directory.length < 2) { return 0; }
		const canDisplay = (width: number, height: number) =>
			width <= hint.maxAxis && height <= hint.maxAxis
			&& width * height <= hint.maxArea
			&& width * height * 4 <= hint.maxBytes;
		const chosen = chooseOpenLevel(directory, 0, hint.displayWidth, canDisplay, 1, hint.pixelBudget);
		if (!chosen || chosen.index === 0) { return 0; }
		console.log(`[TiffProcessor] Opening at level 1/${chosen.reduction} (${chosen.width}x${chosen.height}): `
			+ `full resolution is either not displayable or larger than is worth decoding for this window`);
		PerfTrace.note('tiff-open-level', `1/${chosen.reduction} ${chosen.width}x${chosen.height}`);
		return chosen.index;
	}

	/**
	 * The value stored at one pixel of the FULL-resolution page, read directly
	 * from the file.
	 *
	 * While a pyramid's reduced level is on screen, every value the viewer can
	 * show comes from that level — an average of several stored pixels. That is
	 * fine for finding your way around and wrong for reading a measurement off
	 * the screen, which is why the readout says `1/8 overview` when it happens.
	 * A rectangle read makes the true value affordable: one block, a couple of
	 * milliseconds, however large the page is.
	 *
	 * `x`/`y` are in the coordinates of the level currently displayed; they are
	 * scaled up by that level's reduction. Returns null when the file's layout
	 * is not one that can be read a region at a time, or when anything fails —
	 * a caveated value is better than a wrong one, and the caller keeps what it
	 * already had.
	 */
	async readStoredPixel(x: number, y: number): Promise<string | null> {
		if (!this._sourceBuffer && !this._remoteTiff) { return null; }
		const current = this.pageDirectory.find(entry => entry.index === this.pageIndex);
		const reduction = current && current.reduction > 1 ? current.reduction : 1;
		if (reduction === 1) { return null; }
		const page = current?.parent ?? 0;

		try {
			// The centre of the block of stored pixels this display pixel
			// stands for, rather than its corner: at 1/8 the corner is one of
			// 64 stored values, and the middle is the least arbitrary of them.
			const storedX = Math.floor(x * reduction + reduction / 2);
			const storedY = Math.floor(y * reduction + reduction / 2);
			const region = await this._decodeRegionRaw(page, {
				x: storedX, y: storedY, width: 1, height: 1,
			});
			if (!region) { return null; }
			const samples = Array.from(region.data as Float32Array) as number[];
			if (!samples.length) { return null; }
			const declared = this._formatDeclaredSamples(samples);
			if (declared !== null) { return declared; }
			const sampleFormat = Number(region.sampleFormat ?? this.rawTiffData?.ifd?.t339);
			return samples
				.map(value => sampleFormat === 3 ? value.toPrecision(4) : String(value))
				.join(' ');
		} catch {
			// Includes the deliberate "this layout is decoded whole" refusal.
			return null;
		}
	}

	/** Exact full-resolution value for a stable pyramid-scene coordinate. */
	async readFullResolutionPixel(x: number, y: number): Promise<string | null> {
		const current = this.pageDirectory.find(entry => entry.index === this.pageIndex);
		const page = current?.parent ?? this.pageIndex;
		const storedX = Math.floor(x);
		const storedY = Math.floor(y);
		const cached = this.readCachedFullResolutionPixel(storedX, storedY);
		if (cached !== null) { return cached; }
		try {
			// TIFF decoders pay for an entire stored block even when asked for one
			// pixel. Keep that work: one first read can then serve every following
			// mouse position in the same tile synchronously. Very wide strips stay
			// on the 1x1 path so inspection cannot allocate an enormous band.
			const full = this.pageDirectory.find(entry => entry.index === page);
			const blockWidth = Math.max(1, Number(full?.blockWidth || 1));
			const blockHeight = Math.max(1, Number(full?.blockHeight || 1));
			const cacheWholeBlock = blockWidth * blockHeight * Math.max(1, Number(full?.samplesPerPixel || 1)) <= 2_000_000;
			const rect = cacheWholeBlock ? {
				x: Math.floor(storedX / blockWidth) * blockWidth,
				y: Math.floor(storedY / blockHeight) * blockHeight,
				width: Math.min(blockWidth, Math.max(1, Number(full?.width || storedX + 1) - Math.floor(storedX / blockWidth) * blockWidth)),
				height: Math.min(blockHeight, Math.max(1, Number(full?.height || storedY + 1) - Math.floor(storedY / blockHeight) * blockHeight)),
			} : { x: storedX, y: storedY, width: 1, height: 1 };
			const region = await this._decodeRegionRaw(page, rect);
			if (!region?.data?.length) { return null; }
			this._cacheRegionSamples(page, rect.x, rect.y, region);
			const retained = this.readCachedFullResolutionPixel(storedX, storedY);
			if (retained !== null) { return retained; }
			const samples = Array.from(region.data as Float32Array) as number[];
			const declared = this._formatDeclaredSamples(samples);
			if (declared !== null) { return declared; }
			const sampleFormat = Number(region.sampleFormat ?? this.rawTiffData?.ifd?.t339);
			return samples
				.map(value => sampleFormat === 3 ? value.toPrecision(4) : String(value))
				.join(' ');
		} catch {
			return null;
		}
	}

	/**
	 * Serialize region work through one worker. The source is transferred once
	 * and retained there; later tile and picker requests send only coordinates.
	 */
	private _decodeRegionRaw(
		pageIndex: number,
		rect: { x: number, y: number, width: number, height: number },
		signal?: AbortSignal,
	): Promise<any | null> {
		if (this._remoteTiff && this._remoteTiffUrl) {
			return this._decodeRemoteRegionRaw(pageIndex, rect, signal);
		}
		const requestedBuffer = this._sourceBuffer;
		const requestedGeneration = this._regionSourceGeneration;
		let resolveResult: (value: any | null) => void = () => {};
		const result = new Promise<any | null>(resolve => { resolveResult = resolve; });
		this._regionDecodeQueue = this._regionDecodeQueue.then(async () => {
			const buffer = requestedBuffer;
			if (!buffer || requestedGeneration !== this._regionSourceGeneration
				|| buffer !== this._sourceBuffer) {
				resolveResult(null);
				return;
			}
			const sourceKey = `${this._sourceBufferSrc || 'tiff'}#regions-${this._regionSourceGeneration}`;

			if (this.decodeWorker && !this.decodeWorker.canDecode('tiff-region')) {
				await Promise.race([
					this.decodeWorker.start(),
					new Promise(resolve => setTimeout(resolve, 750)),
				]);
			}
			if (this.decodeWorker?.canDecode('tiff-region')) {
				const request = async (includeSource: boolean) => this.decodeWorker!.decode(
					'tiff-region',
					includeSource ? buffer.slice(0) : new ArrayBuffer(0),
					{ pageIndex, rect, sourceCacheKey: sourceKey },
				);
				let response = await request(!this._regionWorkerPrimed);
				// A worker can have restarted, or its single source cache can have
				// been replaced by another format between requests.
				if (!response?.ok && this._regionWorkerPrimed) {
					this._regionWorkerPrimed = false;
					response = await request(true);
				}
				if (response?.ok) {
					this._regionWorkerPrimed = true;
					resolveResult(response.result);
					return;
				}
			}

			// Compatibility fallback for webviews where workers cannot start.
			try {
				const wasm = getWasmModuleSync() || await getWasmModule();
				if (!wasm || typeof wasm.decode_tiff_region !== 'function') {
					resolveResult(null);
					return;
				}
				const region = wasm.decode_tiff_region(
					new Uint8Array(buffer), pageIndex, rect.x, rect.y, rect.width, rect.height);
				resolveResult({
					width: Number(region.width),
					height: Number(region.height),
					channels: Number(region.channels),
					bitsPerSample: Number(region.bits_per_sample),
					sampleFormat: Number(region.sample_format),
					blocksDecoded: Number(region.blocks_decoded),
					data: region.take_data_as_f32() as Float32Array,
				});
			} catch {
				resolveResult(null);
			}
		}).catch(() => { resolveResult(null); });
		return result;
	}

	/** Read and decode only the remote blocks intersecting one rectangle. */
	private async _decodeRemoteRegionRaw(
		pageIndex: number,
		rect: { x: number, y: number, width: number, height: number },
		signal?: AbortSignal,
	): Promise<any | null> {
		try {
			const image = await this._remoteTiff.getImage(pageIndex);
			const x = Math.max(0, Math.min(Math.floor(rect.x), image.getWidth() - 1));
			const y = Math.max(0, Math.min(Math.floor(rect.y), image.getHeight() - 1));
			const width = Math.max(1, Math.min(Math.ceil(rect.width), image.getWidth() - x));
			const height = Math.max(1, Math.min(Math.ceil(rect.height), image.getHeight() - y));
			const rasters = await this._readRemoteRasters(image, {
				window: [x, y, x + width, y + height],
				signal: signal || this.loadSignal,
			});
			const channels = rasters.length;
			const data = new Float32Array(width * height * channels);
			for (let pixel = 0; pixel < width * height; pixel++) {
				for (let channel = 0; channel < channels; channel++) {
					data[pixel * channels + channel] = Number(rasters[channel][pixel]);
				}
			}
			const sampleFormat = image.getSampleFormat();
			return {
				width, height, channels, data,
				sourceRasters: rasters,
				bitsPerSample: Number(image.getBitsPerSample()),
				sampleFormat: Number(Array.isArray(sampleFormat) ? sampleFormat[0] : sampleFormat),
				blocksDecoded: undefined,
			};
		} catch {
			return null;
		}
	}

	/**
	 * Decode one rectangle of one level and render it with the CURRENT display
	 * settings, so it can be laid over the coarse image without a visible seam.
	 *
	 * The same normalization, gamma and statistics as the main render: a patch
	 * that normalized itself would be a different picture of the same data,
	 * brighter or darker than what surrounds it, which is worse than no patch.
	 */
	async renderRegion(
		pageIndex: number,
		rect: { x: number, y: number, width: number, height: number },
		signal?: AbortSignal,
	): Promise<ImageData | null> {
		if (!this._sourceBuffer && !this._remoteTiff) { return null; }
		try {
			const region = await this._decodeRegionRaw(pageIndex, rect, signal);
			if (!region) { return null; }
			const width = Number(region.width);
			const height = Number(region.height);
			const channels = Number(region.channels);
			const data = region.data as Float32Array;
			if (!data.length) { return null; }
			this._cacheRegionSamples(pageIndex, Math.floor(rect.x), Math.floor(rect.y), region);

			const settings = this.settingsManager.settings;
			const bitsPerSample = this.rawTiffData?.ifd?.t258 ?? region.bitsPerSample;
			const sampleFormat = this.rawTiffData?.ifd?.t339 ?? region.sampleFormat;
			const bandCount = this.selectableBandCount;
			const selectedBand = bandCount > 1
				? Math.min(channels - 1, Math.max(0, this.displayBand))
				: 0;
			let renderChannels = channels;
			let renderData = data;
			if (bandCount > 1 && channels > 1) {
				// Region decoders return an interleaved Float32 carrier. Extract only
				// the selected plane for display, while the all-band native planes stay
				// resident in the picker cache above.
				renderChannels = 1;
				renderData = new Float32Array(width * height);
				for (let pixel = 0; pixel < renderData.length; pixel++) {
					renderData[pixel] = data[pixel * channels + selectedBand];
				}
			}
			if (!this._lastStatistics && NormalizationHelper.needsStats(settings)) {
				// Freeze a representative viewport block as the provisional range.
				// All later tiles use it, avoiding seams without a whole-scene stats
				// pass before the first visible pixels.
				const scanChannels = renderChannels === 2 ? 1 : Math.min(renderChannels, 3);
				let min = Infinity;
				let max = -Infinity;
				for (let pixel = 0; pixel < width * height; pixel++) {
					for (let channel = 0; channel < scanChannels; channel++) {
						const value = renderData[pixel * renderChannels + channel];
						if (!Number.isFinite(value) || value === this._gdalNodata) { continue; }
						if (value < min) { min = value; }
						if (value > max) { max = value; }
					}
				}
				if (Number.isFinite(min) && Number.isFinite(max)) {
					this._lastStatistics = { min, max };
					this.vscode?.postMessage?.({ type: 'stats', value: this._lastStatistics });
				}
			}
			return ImageRenderer.render(
				renderData, width, height, renderChannels,
				sampleFormat === 3 || (bandCount > 1 && tiffNeedsFloatCarrier(sampleFormat, bitsPerSample)),
				// The whole image's statistics, not this rectangle's: auto-
				// normalizing a patch to its own range would make it disagree
				// with the image it sits on.
				this._lastStatistics || { min: 0, max: 1 },
				settings,
				{
					nanColor: this._getNanColor(settings),
					typeMax: tiffTypeMax(sampleFormat, bitsPerSample),
					extraSamplesAreAlpha: bandCount > 1 ? false : this._extraSamplesAreAlpha,
					nodataValue: this._gdalNodata,
				},
			);
		} catch {
			return null;
		}
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
			return floatValue === undefined ? '' : floatValue.toPrecision(6);
		}

		if (!this.rawTiffData || !Number.isFinite(x) || !Number.isFinite(y)
			|| x < 0 || y < 0 || x >= naturalWidth || y >= naturalHeight) {
			return '';
		}

		const ifd = this.rawTiffData.ifd;
		const data = this.rawTiffData.data;
		if (!ifd || !data?.length) { return ''; }
		const pixelIndex = y * naturalWidth + x;
		const format = ifd.t339; // SampleFormat
		const samples = ifd.t277;
		const planarConfig = ifd.t284;
		const bitsPerSample = ifd.t258;
		const settings = this.settingsManager.settings;

		// GDAL's per-band scale/offset (tag 42112) is what makes a stored 1234
		// mean 1.234. Reporting the raw number here would put this viewer at
		// odds with every other reader of the same file, so the readout — and
		// only the readout — is in the file's declared units.
		const rawSamples: number[] = [];
		if (planarConfig === 2) {
			const planeSize = naturalWidth * naturalHeight;
			for (let i = 0; i < samples; i++) { rawSamples.push(data[pixelIndex + i * planeSize]); }
		} else {
			for (let i = 0; i < samples; i++) { rawSamples.push(data[pixelIndex * samples + i]); }
		}
		if (rawSamples.some(value => value === undefined)) { return ''; }
		const declared = this._formatDeclaredSamples(rawSamples);
		if (declared !== null) { return declared; }

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

		const { image, rasters, progressiveRemote } = this._pendingRenderData;
		this._pendingRenderData = null;
		this._isInitialLoad = false;
		if (progressiveRemote) {
			// The view owns the block stream. The tiny placeholder exists only to
			// complete the settings handshake; no full-size empty RGBA copy is made.
			return renderOptions.placeholderImageData || new ImageData(1, 1);
		}

		// Now render with the correct format-specific settings
		const imageData = await this.renderTiff(image, rasters, renderOptions);
		console.log(`[TiffProcessor] Deferred render took ${(performance.now() - perfStart).toFixed(2)}ms`);
		return imageData;
	}
}
