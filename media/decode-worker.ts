"use strict";

/**
 * Decode Web Worker for TIFF Visualizer.
 *
 * Runs the CPU-heavy format decoders off the webview UI thread so pixel
 * decoding never blocks input handling or painting. The main thread sends a
 * file's bytes with ownership transferred; the worker decodes them and
 * transfers the decoded typed arrays back — zero copies in either direction.
 *
 * Only pure-data decoders live here. Formats whose decode path needs DOM APIs
 * (8-bit PNG/JPEG and WebP/AVIF/BMP/ICO via the native Image element, TGA,
 * JXL) or that already decode off-thread
 * keep their existing processors. Every format handled here also keeps its
 * local decoder as a fallback: on any worker error the input bytes are
 * transferred back so the caller can decode locally without refetching.
 */

import './modules/worker-shims.js';
import parseHdr from 'parse-hdr';
import initTiffWasm, { decode_sgi_fast, decode_czi_fast, decode_nd2_ranged, decode_lif_ranged, czi_layout, czi_region_plan, decode_czi_region, decode_lif_fast, decode_nd2_fast, decode_sdt_fast, decode_dicom_fast, decode_exr_fast, exr_zip_f32_plan, decode_fits_fast, decode_hdr_fast, decode_netcdf_fast, decode_npy_display_fast, decode_pfm_display_fast, decode_png16_fast, decode_ppm_display_fast, decode_tiff, decode_tiff_fast, decode_tiff_page, decode_tiff_page_fast, decode_tiff_region, decode_tiff_preview, tiff_preview_reduction, TiffRegionDecoder, NumpyDataset, tiff_float_strip_plan, tiff_page_count, tiff_page_directory } from './wasm/tiff-wasm.js';
// The JPEG XL decoder is its own wasm-pack module. Importing the glue costs a
// few KB of bundle; the ~2.2 MB payload is fetched by `initJxlWasm` below only
// for standalone JXL worker jobs. Embedded JXL takes the main-thread module
// retry path after the core container parser identifies it.
import initJxlWasm, { decode_jxl_fast } from './wasm/jxl-wasm.js';
import initCodecWasm, { czi_layout as codec_czi_layout, czi_region_plan as codec_czi_region_plan, decode_czi_region as codec_decode_czi_region } from './wasm/codec-wasm.js';
import { buildTagsFromGeotiffImage } from './modules/tiff-tag-utils.js';
import { decodeSgiWithWasm, decodeCziWithWasm, decodeCziRegionWithWasm, decodeRangedWithWasm, decodeLifWithWasm, decodeNd2WithWasm, decodeSdtWithWasm, decodeDicomWithWasm, decodeFitsWithWasm, decodeJxlWithWasm, decodeNetcdfWithWasm, decodeNpyWithWasm, decodeNumpySelectedWithWasm, decodePfmWithWasm, decodePpmWithWasm } from './modules/wasm-decoders.js';
import { MIN_PARALLEL_TIFF_PIXELS, MIN_PARALLEL_TIFF_STRIPS, shouldUseParallelTiffPlan } from './modules/tiff-parallel-policy.js';
import { chooseOpenLevel, parsePageDirectory } from './modules/tiff-pages.js';

// This file runs as a Web Worker entry point. The "dom" lib (see
// media/tsconfig.json) types `self` as `Window & typeof globalThis`, which
// doesn't match the DedicatedWorkerGlobalScope API used here (e.g. the
// two-argument `postMessage(message, transferList)` overload, or assigning
// `onmessage` directly). Adding the `webworker` lib would conflict with
// `dom`, so `self` is pragmatically typed as `any` instead.
declare const self: any;
// Referenced only by dead compatibility helpers retained temporarily for
// source-level decoder tests. Production routing never calls them; fallbacks
// are loaded by the webview after a Rust failure.
declare const WorkerGeoTIFF: any;
declare const UPNG: any;

// Parser-only instances: the constructors just assign fields, and the
// _parse* methods used here touch no DOM or vscode APIs.

let tiffWasmReady = false;
let tiffWasmInitPromise: Promise<void> | null = null;
const TIFF_WASM_INIT_TIMEOUT_MS = 3000;

/**
 * JPEG XL lives in a separate module, so unlike the TIFF one it is NOT
 * initialized when the worker starts. The main thread compiles it — blob
 * workers cannot fetch webview-resource URLs — and sends it in a `jxl-module`
 * message immediately before the first standalone JXL decode. Embedded JXL
 * uses the whole-container main-thread retry, so an ordinary worker never
 * receives this module.
 */
let jxlWasmModule: WebAssembly.Module | null = null;
let jxlWasmInitPromise: Promise<void> | null = null;
const JXL_WASM_INIT_TIMEOUT_MS = 15000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
	]);
}

/**
 * @param buffer - Bytes fetched by the webview
 * @param urls - Candidate URLs for ordinary browser workers
 */
async function initTiffDecoder(moduleOrBuffer: WebAssembly.Module | ArrayBuffer | null | undefined, urls: string[]) {
	if (moduleOrBuffer instanceof WebAssembly.Module || moduleOrBuffer?.byteLength) {
		try {
			await withTimeout(
				initTiffWasm({ module_or_path: moduleOrBuffer }),
				TIFF_WASM_INIT_TIMEOUT_MS,
				'TIFF WASM byte initialization timed out',
			);
			tiffWasmReady = true;
			return;
		} catch (error) {
			console.warn('[DecodeWorker] TIFF WASM byte initialization failed', error);
		}
	}
	for (const url of urls || []) {
		try {
			await withTimeout(
				initTiffWasm({ module_or_path: url }),
				TIFF_WASM_INIT_TIMEOUT_MS,
				'TIFF WASM URL initialization timed out',
			);
			tiffWasmReady = true;
			return;
		} catch (error) {
			console.warn('[DecodeWorker] TIFF WASM init failed for', url, error);
		}
	}
}

/**
 * Instantiate the JPEG XL module the main thread handed over. Failing here is
 * not fatal: `decodeWithFallback` runs the same decoder on the main thread,
 * where the payload can be fetched directly.
 */
async function requireJxlWasm(): Promise<void> {
	if (!jxlWasmModule) {
		throw new Error(
			'Cannot decode JPEG XL: its WASM module was not delivered to the decode worker.');
	}
	if (!jxlWasmInitPromise) {
		jxlWasmInitPromise = (async (): Promise<void> => {
			try {
				await withTimeout(
					initJxlWasm({ module_or_path: jxlWasmModule }),
					JXL_WASM_INIT_TIMEOUT_MS,
					'JPEG XL WASM initialization timed out',
				);
			} catch (error) {
				// Clear the promise so a later open retries instead of being
				// stuck with one rejected attempt for the life of the worker.
				jxlWasmInitPromise = null;
				throw error;
			}
		})();
	}
	await jxlWasmInitPromise;
}

/**
 * Decode a TIFF with the Rust/WASM decoder, mirroring TiffWasmProcessor.decode
 * and additionally deinterleaving the per-channel rasters off-thread. Preserve
 * compact unsigned carriers: widening uint8/uint16 to f32 makes later feature
 * scans and rendering rebuild the integer buffer we started with.
 */
/**
 * Which page to decode when the caller asked for a pyramidal file's best level
 * rather than a specific page.
 *
 * Decided HERE, in the worker that already holds the bytes and the decoder,
 * rather than on the main thread: reading the IFD chain there would mean
 * instantiating the wasm module for files that have no pyramid at all, so every
 * ordinary TIFF would pay for a feature only large multi-resolution ones use.
 * Here it is one IFD walk in a worker that is about to parse the file anyway.
 *
 * `hint` carries the display constraints as plain numbers, because the
 * "can this be drawn?" test involves a canvas the worker does not have.
 */
function chooseLevelForHint(bytes: Uint8Array, hint: TiffLevelHint | undefined): number {
	if (!hint || typeof tiff_page_directory !== 'function') { return 0; }
	let directory;
	try {
		directory = parsePageDirectory(tiff_page_directory(bytes));
	} catch {
		return 0;
	}
	// Not a pyramid: nothing to choose, and nothing has been spent but an
	// IFD walk.
	if (directory.length < 2) { return 0; }
	const canDisplay = (width: number, height: number) =>
		width <= hint.maxAxis && height <= hint.maxAxis
		&& width * height <= hint.maxArea
		&& width * height * 4 <= hint.maxBytes;
	const chosen = chooseOpenLevel(directory, 0, hint.displayWidth, canDisplay, 1, hint.pixelBudget);
	return chosen ? chosen.index : 0;
}

interface TiffLevelHint {
	displayWidth: number;
	maxAxis: number;
	maxArea: number;
	maxBytes: number;
	pixelBudget: number;
}

function decodeTiffWasm(buffer: ArrayBuffer, pageIndex = 0, levelHint?: TiffLevelHint) {
	if (!tiffWasmReady) {
		throw new Error('TIFF WASM decoder not initialized');
	}
	const tiffPageCount = tiff_page_count;
	const tiffPageFast = decode_tiff_page_fast;
	const tiffPage = decode_tiff_page;
	const tiffFast = decode_tiff_fast;
	const tiffPlain = decode_tiff;
	const timings = [];
	let phaseStart = performance.now();
	const bytes = new Uint8Array(buffer);
	// A level hint only applies to an unqualified open; an explicit page is a
	// request for THAT page.
	if (pageIndex === 0 && levelHint) { pageIndex = chooseLevelForHint(bytes, levelHint); }
	const generatedPreview = (pageIndex === 0 || pageIndex === 1) && tiff_preview_reduction(bytes) > 0;
	const pageCount = generatedPreview ? 2 : (typeof tiffPageCount === 'function' ? tiffPageCount(bytes) : 1);
	if (pageIndex < 0 || pageIndex >= pageCount) {
		throw new Error(`TIFF page index ${pageIndex} is out of range (page count: ${pageCount})`);
	}
	if (generatedPreview) { pageIndex = 1; }
	const result = generatedPreview ? decode_tiff_preview(bytes) : pageIndex > 0 && typeof tiffPageFast === 'function'
		? tiffPageFast(bytes, pageIndex)
		: pageIndex > 0 && typeof tiffPage === 'function'
			? tiffPage(bytes, pageIndex)
			: typeof tiffFast === 'function'
				? tiffFast(bytes)
				: tiffPlain(bytes);
	let now = performance.now();
	timings.push({ name: 'decode-wasm-rust', durationMs: now - phaseStart });
	if (Number.isFinite(result.timing_metadata_ms)) {
		timings.push({ name: 'decode-rust-metadata', durationMs: result.timing_metadata_ms });
	}
	if (Number.isFinite(result.timing_decode_ms)) {
		timings.push({ name: 'decode-rust-read-image', durationMs: result.timing_decode_ms });
	}
	if (Number.isFinite(result.timing_convert_ms)) {
		timings.push({ name: 'decode-rust-convert-pack', durationMs: result.timing_convert_ms });
	}
	if (Number.isFinite(result.timing_stats_ms)) {
		timings.push({ name: 'decode-rust-stats', durationMs: result.timing_stats_ms });
	}
	if (Number.isFinite(result.timing_pack_ms)) {
		timings.push({ name: 'decode-rust-pack', durationMs: result.timing_pack_ms });
	}
	if (result.direct_decode) {
		timings.push({ name: 'decode-rust-direct', durationMs: 1 });
	}

	phaseStart = now;
	const width = result.width;
	const height = result.height;
	const channels = result.channels;
	const sampleKind = Number(result.sample_kind ?? 0);
	// Channel planes are split in Rust, before the data is moved out: the
	// JavaScript loop below took ~450 ms on a 100M-pixel RGB image.
	let planeStore: Uint8Array | Float32Array | null = null;
	if (channels > 1) {
		if ((sampleKind === 1 || sampleKind === 3) && typeof result.planes_u8 === 'function') {
			planeStore = result.planes_u8();
		} else if (sampleKind === 0 && typeof result.planes_f32 === 'function') {
			planeStore = result.planes_f32();
		}
		if (planeStore && planeStore.length === 0) { planeStore = null; }
	}
	let data: Float32Array | Uint16Array | Uint8Array;
	if ((sampleKind === 1 || sampleKind === 3) && typeof result.take_data_as_u8 === 'function') {
		const bytes = result.take_data_as_u8() as Uint8Array;
		data = sampleKind === 3
			? new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
			: bytes;
	} else {
		data = typeof result.take_data_as_f32 === 'function'
			? result.take_data_as_f32()
			: result.get_data_as_f32();
	}
	now = performance.now();
	timings.push({ name: `decode-wasm-take-${sampleKind === 1 ? 'u8' : sampleKind === 3 ? 'u16' : 'f32'}`, durationMs: now - phaseStart });

	phaseStart = now;
	const rasters: Array<Float32Array | Uint16Array | Uint8Array> = [];
	const pixelCount = width * height;
	const planeCarrier = planeStore && (sampleKind === 3
		? new Uint16Array(planeStore.buffer, planeStore.byteOffset, planeStore.byteLength / 2)
		: planeStore);
	if (channels === 1) {
		rasters.push(data);
	} else if (planeCarrier && planeCarrier.length === pixelCount * channels) {
		for (let c = 0; c < channels; c++) {
			rasters.push(planeCarrier.subarray(c * pixelCount, (c + 1) * pixelCount));
		}
	} else {
		const Carrier = data.constructor as { new(length: number): Float32Array | Uint16Array | Uint8Array };
		for (let c = 0; c < channels; c++) {
			const channel = new Carrier(pixelCount);
			for (let i = 0; i < pixelCount; i++) {
				channel[i] = data[i * channels + c];
			}
			rasters.push(channel);
		}
	}
	now = performance.now();
	timings.push({ name: 'decode-wasm-deinterleave', durationMs: now - phaseStart });

	return {
		pageIndex,
		pageCount,
		width,
		height,
		channels,
		bitsPerSample: result.bits_per_sample,
		sampleFormat: result.sample_format,
		sampleKind,
		compression: result.compression,
		predictor: result.predictor,
		photometricInterpretation: result.photometric_interpretation,
		planarConfiguration: result.planar_configuration,
		rowsPerStrip: result.rows_per_strip,
		stripCount: result.strip_count,
		stripByteCountTotal: Number(result.strip_byte_count_total || 0),
		stripByteCountMax: Number(result.strip_byte_count_max || 0),
		tileWidth: result.tile_width,
		tileLength: result.tile_length,
		tileCount: result.tile_count,
		directDecode: result.direct_decode,
		data,
		rasters,
		min: result.min_value,
		max: result.max_value,
		allTagsJson: result.all_tags_json,
		omeXml: result.ome_xml || undefined,
		geoJson: result.geo_json || undefined,
		pageDirectoryJson: result.page_directory_json || undefined,
		decodedWith: generatedPreview ? 'wasm (bounded preview)' : 'wasm (worker)',
		decodeTimings: timings,
	};
}

/**
 * Decode TIFF variants unsupported by the Rust decoder without blocking the
 * webview thread.
 */
async function decodeTiffGeotiff(buffer: ArrayBuffer, wasmError: string, pageIndex = 0) {
	const timings = [];
	let phaseStart = performance.now();
	const tiff = await WorkerGeoTIFF.fromArrayBuffer(buffer);
	let now = performance.now();
	timings.push({ name: 'decode-geotiff-open', durationMs: now - phaseStart });

	phaseStart = now;
	const pageCount = await tiff.getImageCount();
	const image = await tiff.getImage(pageIndex);
	const firstImage = pageIndex === 0 ? image : await tiff.getImage(0);
	const firstDescription = String(firstImage?.fileDirectory?.ImageDescription || '').trim();
	const omeXml = /<(?:[\w.-]+:)?OME\b/i.test(firstDescription) ? firstDescription : undefined;
	now = performance.now();
	timings.push({ name: 'decode-geotiff-ifd', durationMs: now - phaseStart });

	const width = image.getWidth();
	const height = image.getHeight();
	const samplesPerPixel = image.getSamplesPerPixel();
	const rawBitsPerSample = image.getBitsPerSample();
	const rawSampleFormat = image.getSampleFormat();
	const bitsPerSample = Array.isArray(rawBitsPerSample) ? rawBitsPerSample[0] : rawBitsPerSample;
	const sampleFormat = Array.isArray(rawSampleFormat) ? rawSampleFormat[0] : rawSampleFormat;
	phaseStart = performance.now();
	const decodedRasters = await image.readRasters();
	now = performance.now();
	timings.push({ name: 'decode-geotiff-rasters', durationMs: now - phaseStart });
	const fileDirectory = image.fileDirectory || {};

	let data: Float32Array;
	let rasters: Float32Array[] | any[];
	if (samplesPerPixel === 1) {
		phaseStart = performance.now();
		data = new Float32Array(decodedRasters[0]);
		rasters = [data];
		now = performance.now();
		timings.push({ name: 'decode-geotiff-copy', durationMs: now - phaseStart });
	} else {
		phaseStart = performance.now();
		const pixelCount = width * height;
		data = new Float32Array(pixelCount * samplesPerPixel);
		for (let i = 0; i < pixelCount; i++) {
			for (let c = 0; c < samplesPerPixel; c++) {
				data[i * samplesPerPixel + c] = decodedRasters[c][i];
			}
		}
		rasters = decodedRasters;
		now = performance.now();
		timings.push({ name: 'decode-geotiff-interleave', durationMs: now - phaseStart });
	}

	return {
		pageIndex,
		pageCount,
		width,
		height,
		channels: samplesPerPixel,
		bitsPerSample,
		sampleFormat,
		compression: fileDirectory.Compression || 1,
		predictor: fileDirectory.Predictor || 1,
		photometricInterpretation: fileDirectory.PhotometricInterpretation || 1,
		planarConfiguration: fileDirectory.PlanarConfiguration || 1,
		data,
		rasters,
		allTagsJson: JSON.stringify(buildTagsFromGeotiffImage(image)),
		omeXml,
		decodedWith: 'geotiff.js (worker)',
		wasmFallbackReason: wasmError,
		decodeTimings: timings,
	};
}

async function decodeTiff(buffer: ArrayBuffer, pageIndex = 0, levelHint?: TiffLevelHint) {
	if (tiffWasmInitPromise) {
		// WASM is preferred, but a slow or wedged initialization must never
		// prevent the worker's GeoTIFF compatibility decoder from running.
		await withTimeout(tiffWasmInitPromise, TIFF_WASM_INIT_TIMEOUT_MS, 'TIFF WASM init wait timed out')
			.catch(error => console.warn('[DecodeWorker]', error));
	}
	try {
		return decodeTiffWasm(buffer, pageIndex, levelHint);
	} catch (error) {
		const message = String((error instanceof Error ? error.message : error) || 'WASM decode failed');
		throw new Error(message);
	}
}

/**
 * Decode a viewport rectangle while the source stays resident in this worker.
 * The client supplies `sourceCacheKey`, so only the first request transfers the
 * file. The returned samples are raw and exact; display normalization remains
 * on the main thread beside the ordinary TIFF renderer.
 */
async function decodeTiffRegion(buffer: ArrayBuffer, options: Record<string, any>) {
	await requireWasm('TIFF region');
	const rect = options.rect || {};
	const cacheKey = options.sourceCacheKey ? String(options.sourceCacheKey) : '';
	let decoder: TiffRegionDecoder | null = null;
	if (cacheKey) {
		if (tiffRegionDecoder?.key !== cacheKey) {
			tiffRegionDecoder?.decoder.free();
			tiffRegionDecoder = null;
			if (!buffer.byteLength) {
				throw new Error('TIFF region source is not cached in the decode worker');
			}
			tiffRegionDecoder = {
				key: cacheKey,
				decoder: new TiffRegionDecoder(new Uint8Array(buffer)),
			};
		}
		decoder = tiffRegionDecoder.decoder;
	}
	const region = decoder
		? decoder.decode(
			Number(options.pageIndex || 0),
			Number(rect.x || 0),
			Number(rect.y || 0),
			Number(rect.width || 0),
			Number(rect.height || 0),
		)
		: decode_tiff_region(
			new Uint8Array(buffer),
			Number(options.pageIndex || 0),
			Number(rect.x || 0),
			Number(rect.y || 0),
			Number(rect.width || 0),
			Number(rect.height || 0),
		);
	return {
		width: Number(region.width),
		height: Number(region.height),
		channels: Number(region.channels),
		bitsPerSample: Number(region.bits_per_sample),
		sampleFormat: Number(region.sample_format),
		blocksDecoded: Number(region.blocks_decoded),
		data: region.take_data_as_f32() as Float32Array,
	};
}

/**
 * Let the tiny bootstrap worker decide only the route for pool-worthy TIFFs.
 * Parsing the IFD takes a few milliseconds and prevents an early whole-image
 * decode from preempting the much faster strip pool. Files below the shared
 * pool thresholds continue directly into the ordinary worker decoder.
 */
/**
 * Whether an HDR is large enough for the page's scanline pool, by the same
 * gates the pool applies, read off the resolution line of the text header.
 */
function hdrWorthParallel(buffer: ArrayBuffer): boolean {
	const head = new TextDecoder('latin1').decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 8192)));
	const match = /^-Y (\d+) \+X (\d+)\s*$/m.exec(head);
	if (!match) { return false; }
	const height = Number(match[1]), width = Number(match[2]);
	return height >= MIN_PARALLEL_TIFF_STRIPS && width * height >= MIN_PARALLEL_TIFF_PIXELS;
}

async function decodeTiffSpeculatively(buffer: ArrayBuffer, pageIndex = 0) {
	if (pageIndex === 0) {
		if (tiffWasmInitPromise) {
			await withTimeout(tiffWasmInitPromise, TIFF_WASM_INIT_TIMEOUT_MS, 'TIFF WASM init wait timed out')
				.catch(error => console.warn('[DecodeWorker]', error));
		}
		if (tiffWasmReady && typeof tiff_float_strip_plan === 'function') {
			const started = performance.now();
			try {
				const plan = tiff_float_strip_plan(new Uint8Array(buffer));
				if (shouldUseParallelTiffPlan(plan) || tiff_preview_reduction(new Uint8Array(buffer)) > 0) {
					return {
						deferToParallelTiff: true,
						width: Number(plan.width || 0),
						height: Number(plan.height || 0),
						stripCount: Number(plan.strip_count || 0),
						decodeTimings: [{ name: 'decode-tiff-route-plan', durationMs: performance.now() - started }],
					};
				}
			} catch { /* the normal decoder retains all compatibility fallbacks */ }
		}
	}
	return decodeTiff(buffer, pageIndex);
}

/**
 * Decode an EXR with the Rust/WASM decoder, returning a parse-exr-compatible
 * shape for the existing EXR processor.
 */
function decodeExrWasm(buffer: ArrayBuffer) {
	if (!tiffWasmReady || typeof decode_exr_fast !== 'function') {
		throw new Error('EXR WASM decoder not initialized');
	}
	const timings = [];
	let phaseStart = performance.now();
	const result = decode_exr_fast(new Uint8Array(buffer));
	let now = performance.now();
	timings.push({ name: 'decode-exr-rust', durationMs: now - phaseStart });
	if (Number.isFinite(result.timing_read_ms)) {
		timings.push({ name: 'decode-exr-read-image', durationMs: result.timing_read_ms });
	}
	if (Number.isFinite(result.timing_pack_ms)) {
		timings.push({ name: 'decode-exr-pack', durationMs: result.timing_pack_ms });
	}

	phaseStart = now;
	const data = result.take_data_as_f32();
	now = performance.now();
	timings.push({ name: 'decode-exr-to-f32', durationMs: now - phaseStart });

	const channelNames = String(result.channel_names_csv || '').split(',').filter(Boolean);
	const displayedChannels = String(result.displayed_channels_csv || '').split(',').filter(Boolean);
	return {
		width: result.width,
		height: result.height,
		data,
		format: result.format,
		type: result.data_type,
		channelNames,
		displayedChannels,
		shape: [result.width, result.height],
		flipY: false,
		allTagsJson: result.all_tags_json,
		// Range computed by the Rust pack pass; the processor uses it instead of
		// re-scanning every sample in JavaScript.
		stats: { min: result.data_min, max: result.data_max },
		channels: result.channels,
		decodedWith: 'rust-exr-wasm (worker)',
		decodeTimings: timings,
	};
}

function decodeExrParseExr(buffer: ArrayBuffer, wasmError = '') {
	const phaseStart = performance.now();
	// FloatType (1015): decoded Float32Array values, matching exr-processor.
	// @ts-ignore — parseExr is attached to the (shimmed) window by parse-exr.js
	const result = globalThis.parseExr(buffer, 1015);
	result.decodedWith = 'parse-exr.js (worker)';
	result.flipY = true;
	if (wasmError) {
		result.wasmFallbackReason = wasmError;
	}
	result.decodeTimings = [{ name: 'decode-exr-parse-exr', durationMs: performance.now() - phaseStart }];
	return result;
}

async function decodeExr(buffer: ArrayBuffer) {
	if (tiffWasmInitPromise) {
		await withTimeout(tiffWasmInitPromise, TIFF_WASM_INIT_TIMEOUT_MS, 'WASM init wait timed out')
			.catch(error => console.warn('[DecodeWorker]', error));
	}
	try {
		return decodeExrWasm(buffer);
	} catch (error) {
		const message = String((error instanceof Error ? error.message : error) || 'WASM EXR decode failed');
		throw new Error(message);
	}
}

function planExrZip(buffer: ArrayBuffer) {
	if (!tiffWasmReady || typeof exr_zip_f32_plan !== 'function') {
		throw new Error('EXR ZIP planner is not initialized');
	}
	const started = performance.now();
	const plan = exr_zip_f32_plan(new Uint8Array(buffer));
	if (!plan) {
		return { supported: false, source: buffer };
	}
	return {
		supported: true,
		source: buffer,
		width: plan.width,
		height: plan.height,
		dataY: plan.data_y,
		channelName: plan.channel_name,
		channelNames: Array.from(plan.channel_names as string[]),
		channelKinds: plan.channel_kinds,
		selection: plan.selection,
		displayedChannels: Array.from(plan.displayed_names as string[]),
		counts: plan.counts,
		yCoordinates: plan.y_coordinates,
		allTagsJson: plan.all_tags_json,
		compressed: plan.take_compressed(),
		planMs: performance.now() - started,
	};
}

function decodeHdrWasm(buffer: ArrayBuffer) {
	if (!tiffWasmReady || typeof decode_hdr_fast !== 'function') {
		throw new Error('HDR WASM decoder not initialized');
	}
	const timings = [];
	let phaseStart = performance.now();
	const result = decode_hdr_fast(new Uint8Array(buffer));
	let now = performance.now();
	timings.push({ name: 'decode-hdr-rust', durationMs: now - phaseStart });

	phaseStart = now;
	const data = result.take_data_as_f32();
	const metadata = result.take_metadata_as_f64();
	now = performance.now();
	timings.push({ name: 'decode-hdr-transfer-f32', durationMs: now - phaseStart });
	const [
		width = 0,
		height = 0,
		exposure = 1,
		gamma = 1,
		timingHeader = NaN,
		timingDecode = NaN,
		timingConvert = NaN,
	] = metadata;
	if (Number.isFinite(timingHeader)) {
		timings.push({ name: 'decode-hdr-header', durationMs: timingHeader });
	}
	if (Number.isFinite(timingDecode)) {
		timings.push({ name: 'decode-hdr-rle', durationMs: timingDecode });
	}
	if (Number.isFinite(timingConvert)) {
		timings.push({ name: 'decode-hdr-to-f32', durationMs: timingConvert });
	}
	return {
		shape: [width, height],
		channels: result.channels,
		exposure,
		gamma,
		data,
		allTagsJson: result.all_tags_json,
		decodedWith: 'rust-hdr-wasm (worker)',
		decodeTimings: timings,
	};
}

function decodeHdrParseHdr(buffer: ArrayBuffer, wasmError = '') {
	const phaseStart = performance.now();
	// Cast to any: HdrResult (media/types/parse-hdr.d.ts) only describes the
	// library's own output shape, not the decodedWith/wasmFallbackReason/
	// decodeTimings fields this worker layers on top of it.
	const result: any = parseHdr(buffer);
	result.decodedWith = 'parse-hdr (worker)';
	if (wasmError) {
		result.wasmFallbackReason = wasmError;
	}
	result.decodeTimings = [{ name: 'decode-hdr-parse-hdr', durationMs: performance.now() - phaseStart }];
	return result;
}

async function decodeHdr(buffer: ArrayBuffer) {
	if (tiffWasmInitPromise) {
		await withTimeout(tiffWasmInitPromise, TIFF_WASM_INIT_TIMEOUT_MS, 'WASM init wait timed out')
			.catch(error => console.warn('[DecodeWorker]', error));
	}
	try {
		return decodeHdrWasm(buffer);
	} catch (error) {
		const message = String((error instanceof Error ? error.message : error) || 'WASM HDR decode failed');
		console.warn('[DecodeWorker] HDR WASM decode failed, using parse-hdr in worker:', message);
		return decodeHdrParseHdr(buffer, message);
	}
}

function decodePng16Wasm(buffer: ArrayBuffer) {
	if (!tiffWasmReady || typeof decode_png16_fast !== 'function') {
		throw new Error('PNG WASM decoder not initialized');
	}
	const timings = [];
	let phaseStart = performance.now();
	const result = decode_png16_fast(new Uint8Array(buffer));
	let now = performance.now();
	timings.push({ name: 'decode-png16-rust', durationMs: now - phaseStart });
	if (Number.isFinite(result.timing_read_info_ms)) {
		timings.push({ name: 'decode-png16-rust-info', durationMs: result.timing_read_info_ms });
	}
	if (Number.isFinite(result.timing_decode_ms)) {
		timings.push({ name: 'decode-png16-rust-frame', durationMs: result.timing_decode_ms });
	}
	if (Number.isFinite(result.timing_convert_ms)) {
		timings.push({ name: 'decode-png16-rust-to-u16', durationMs: result.timing_convert_ms });
	}

	phaseStart = now;
	const decodedData = result.take_data_as_u16();
	now = performance.now();
	timings.push({ name: 'decode-png16-rust-transfer-u16', durationMs: now - phaseStart });
	return {
		width: result.width,
		height: result.height,
		depth: result.bit_depth,
		ctype: result.color_type,
		decodedData,
		decodedWith: 'rust-png-wasm (worker)',
		decodeTimings: timings
	};
}

function decodePng16Upng(buffer: ArrayBuffer, wasmError = '') {
	const timings = [];
	let phaseStart = performance.now();
	const png = UPNG.decode(buffer);
	let now = performance.now();
	timings.push({ name: 'decode-png16-upng', durationMs: now - phaseStart });
	if (png.depth === 16 && png.data) {
		phaseStart = now;
		const uint8Data = new Uint8Array(png.data);
		const uint16Data = new Uint16Array(uint8Data.length / 2);
		let src = 0;
		for (let i = 0; i < uint16Data.length; i++, src += 2) {
			uint16Data[i] = (uint8Data[src] << 8) | uint8Data[src + 1];
		}
		png.decodedData = uint16Data;
		png.data = null;
		now = performance.now();
		timings.push({ name: 'decode-png16-byte-swap', durationMs: now - phaseStart });
	}
	png.decodeTimings = timings;
	png.decodedWith = 'upng-js (worker)';
	if (wasmError) {
		png.wasmFallbackReason = wasmError;
	}
	return png;
}

async function decodePng16(buffer: ArrayBuffer) {
	if (tiffWasmInitPromise) {
		await withTimeout(tiffWasmInitPromise, TIFF_WASM_INIT_TIMEOUT_MS, 'WASM init wait timed out')
			.catch(error => console.warn('[DecodeWorker]', error));
	}
	try {
		return decodePng16Wasm(buffer);
	} catch (error) {
		const message = String((error instanceof Error ? error.message : error) || 'WASM PNG decode failed');
		throw new Error(message);
	}
}

/**
 * This is the complete Rust/WASM path for PFM, NetPBM, NPY/NPZ, FITS, NetCDF,
 * DICOM and CZI. A small outer worker accelerates only the common raw-memory
 * layouts of the first three and returns unsupported inputs here untouched.
 * There is no second general TypeScript parser, so a WASM failure after that
 * dispatch is a hard error rather than a silent compatibility downgrade.
 *
 * The result assembly lives in `modules/wasm-decoders.ts` and is shared with
 * the main-thread path in the format processors, so neither side can drift.
 */
async function requireWasm(format: string): Promise<void> {
	if (tiffWasmInitPromise) {
		await withTimeout(tiffWasmInitPromise, TIFF_WASM_INIT_TIMEOUT_MS, 'WASM init wait timed out')
			.catch(error => console.warn('[DecodeWorker]', error));
	}
	if (!tiffWasmReady) {
		throw new Error(
			`Cannot decode ${format}: the Rust/WASM decoder failed to initialize. ` +
			`${format} is decoded exclusively by WebAssembly in this extension.`);
	}
}

async function decodePfm(buffer: ArrayBuffer) {
	await requireWasm('PFM');
	return decodePfmWithWasm(decode_pfm_display_fast, buffer, 'worker');
}

async function decodePpm(buffer: ArrayBuffer) {
	await requireWasm('NetPBM');
	return decodePpmWithWasm(decode_ppm_display_fast, buffer, 'worker');
}

async function decodeNpy(buffer: ArrayBuffer) {
	await requireWasm('NPY');
	return decodeNpyWithWasm(decode_npy_display_fast, buffer, 'worker');
}

async function decodeJxl(buffer: ArrayBuffer) {
	await requireJxlWasm();
	return decodeJxlWithWasm(decode_jxl_fast, buffer, 'worker');
}

/**
 * Standalone JPEG XR. Its decoder lives ONLY in the heavy-codec module — a
 * `.jxr` file is a JPEG XR codestream and nothing else — so this always
 * reports the codec rather than attempting a decode the core cannot do. The
 * client sees the request, delivers the module and re-issues.
 */
async function decodeJxr(_buffer: ArrayBuffer): Promise<never> {
	throw new Error(
		'[external-codec:JPEG XR] a .jxr file needs the JPEG XR decoder, which is not in this build');
}

/**
 * Standalone JPEG 2000, for the same reason as `decodeJxr` above: a `.jp2` is
 * a JPEG 2000 codestream, whose decoder is only in the heavy-codec module.
 */
async function decodeJp2(_buffer: ArrayBuffer): Promise<never> {
	throw new Error(
		'[external-codec:JPEG 2000] a .jp2 file needs the JPEG 2000 decoder, which is not in this build');
}

async function decodeFits(buffer: ArrayBuffer) {
	await requireWasm('FITS');
	return decodeFitsWithWasm(decode_fits_fast, buffer, 'worker');
}

async function decodeNetcdf(buffer: ArrayBuffer, options: Record<string, any>) {
	await requireWasm('NetCDF');
	return decodeNetcdfWithWasm(decode_netcdf_fast, buffer, options, 'worker');
}

async function decodeDicom(buffer: ArrayBuffer, frameIndex: number) {
	await requireWasm('DICOM');
	// `decode_dicom_fast` now decodes JPEG Baseline and RLE Lossless Pixel
	// Data natively (JPEG Baseline through the shared zune-jpeg), so the TS-side
	// codestream extraction + shared zune-jpeg fallback that used to catch
	// the `requires codec: jpeg-baseline` error here is gone.
	return decodeDicomWithWasm(decode_dicom_fast, buffer, frameIndex, 'worker');
}

async function decodeNd2(buffer: ArrayBuffer, options: Record<string, any>) {
	await requireWasm('ND2');
	return decodeNd2WithWasm(decode_nd2_fast, buffer, options, 'worker');
}

async function decodeLif(buffer: ArrayBuffer, options: Record<string, any>) {
	await requireWasm('LIF');
	return decodeLifWithWasm(decode_lif_fast, buffer, options, 'worker');
}

async function decodeSdt(buffer: ArrayBuffer, options: Record<string, any>) {
	await requireWasm('SDT');
	return decodeSdtWithWasm(decode_sdt_fast, buffer, options, 'worker');
}

async function decodeCzi(buffer: ArrayBuffer, options: Record<string, any>) {
	await requireWasm('CZI');
	return decodeCziWithWasm(decode_czi_fast, buffer, options, 'worker');
}

/**
 * Ranged CZI access (media/modules/czi-source.ts). The page reads the
 * directory once and only the subblocks each view needs; the worker keeps the
 * directory per file and answers the layout, the byte plan and the region
 * decode. JPEG XR subblocks need the heavy-codec module, which the page sends
 * as `codec-module` before the first such request.
 */
let codecWasmCompiled: WebAssembly.Module | null = null;
let codecWasmInitPromise: Promise<void> | null = null;
const cziDirectories = new Map<string, { directory: Uint8Array, metadata: Uint8Array }>();

async function requireCodecWasm(): Promise<void> {
	if (!codecWasmInitPromise) {
		if (!codecWasmCompiled) { throw new Error('The heavy-codec module was not provided to the decode worker'); }
		codecWasmInitPromise = initCodecWasm({ module_or_path: codecWasmCompiled }).then((): void => undefined);
		codecWasmInitPromise.catch((): void => { codecWasmInitPromise = null; });
	}
	await codecWasmInitPromise;
}

async function cziFunctions(options: Record<string, any>) {
	if (options.codec) {
		await requireCodecWasm();
		return { layout: codec_czi_layout, plan: codec_czi_region_plan, region: codec_decode_czi_region };
	}
	await requireWasm('CZI');
	return { layout: czi_layout, plan: czi_region_plan, region: decode_czi_region };
}

function cziDirectory(options: Record<string, any>) {
	const key = String(options.key || '');
	if (options.directory instanceof ArrayBuffer) {
		cziDirectories.delete(key);
		cziDirectories.set(key, {
			directory: new Uint8Array(options.directory),
			metadata: options.metadata instanceof ArrayBuffer ? new Uint8Array(options.metadata) : new Uint8Array(0),
		});
		while (cziDirectories.size > 4) { cziDirectories.delete(cziDirectories.keys().next().value as string); }
	}
	const entry = cziDirectories.get(key);
	if (!entry) { throw new Error('CZI directory is not cached in the decode worker'); }
	return entry;
}

function cziRangedOptions(options: Record<string, any>) {
	const { key: _key, directory: _directory, metadata: _metadata, codec: _codec, offsets: _offsets, ...rest } = options;
	return rest;
}

async function cziLayout(options: Record<string, any>) {
	const { directory, metadata } = cziDirectory(options);
	const fns = await cziFunctions(options);
	return JSON.parse(fns.layout(directory, metadata, JSON.stringify(cziRangedOptions(options))));
}

async function cziPlan(options: Record<string, any>) {
	const { directory } = cziDirectory(options);
	const fns = await cziFunctions(options);
	return JSON.parse(fns.plan(directory, JSON.stringify(cziRangedOptions(options))));
}

async function cziRegion(buffer: ArrayBuffer, options: Record<string, any>) {
	const { directory } = cziDirectory(options);
	const fns = await cziFunctions(options);
	return decodeCziRegionWithWasm(fns.region, directory, cziRangedOptions(options), buffer, new Uint32Array(options.offsets || []), 'worker');
}


async function decodeFormat(format: string, buffer: ArrayBuffer, options: Record<string, any> = {}) {
	switch (format) {
		case 'tiff':
			return options.preferParallelTiff
				? decodeTiffSpeculatively(buffer, Number(options.pageIndex || 0))
				: decodeTiff(buffer, Number(options.pageIndex || 0), options.levelHint);
		case 'tiff-region':
			return decodeTiffRegion(buffer, options);
		case 'exr':
			return decodeExr(buffer);
		case 'exr-zip-plan':
			return planExrZip(buffer);
		case 'npy':
			if (options?.numpyDataset) {
				if (!numpyDataset || numpyDataset.key !== options.sourceCacheKey) {
					numpyDataset?.decoder.free();
					numpyDataset = { key: options.sourceCacheKey, decoder: new NumpyDataset(new Uint8Array(buffer)) };
				}
				return decodeNumpySelectedWithWasm(json => numpyDataset!.decoder.decode(json), options, 'worker');
			}
			return decodeNpy(buffer);
		case 'pfm':
			return decodePfm(buffer);
		case 'ppm':
			return decodePpm(buffer);
		case 'png16':
			return decodePng16(buffer);
		case 'hdr':
			// A large HDR decodes faster as scanline ranges across the strip
			// pool, which only the page can drive; hand it back untouched.
			if (options?.preferParallelHdr && hdrWorthParallel(buffer)) {
				return { deferToParallelHdr: true, decodeTimings: [] };
			}
			return decodeHdr(buffer);
		case 'jxl':
			return decodeJxl(buffer);
		case 'jxr':
			return decodeJxr(buffer);
		case 'jp2':
			return decodeJp2(buffer);
		case 'fits':
			return decodeFits(buffer);
		case 'dicom':
			return decodeDicom(buffer, Number(options.frameIndex || 0));
		case 'netcdf':
			return decodeNetcdf(buffer, options);
		case 'czi':
			return decodeCzi(buffer, options);
		case 'czi-layout':
			return cziLayout(options);
		case 'czi-plan':
			return cziPlan(options);
		case 'czi-region':
			return cziRegion(buffer, options);
		case 'nd2-ranged':
			await requireWasm('ND2');
			return decodeRangedWithWasm(decode_nd2_ranged, 'nd2', buffer, options, 'worker');
		case 'lif-ranged':
			await requireWasm('LIF');
			return decodeRangedWithWasm(decode_lif_ranged, 'lif', buffer, options, 'worker');
		case 'nd2':
			return decodeNd2(buffer, options);
		case 'lif':
			return decodeLif(buffer, options);
		case 'sgi':
			await requireWasm('SGI RGB');
			return decodeSgiWithWasm(decode_sgi_fast, buffer, 'worker');
		case 'sdt':
			return decodeSdt(buffer, options);
		default:
			throw new Error(`Unknown decode format: ${format}`);
	}
}

/**
 * Collect every distinct ArrayBuffer reachable from a decode result so its
 * typed arrays are transferred (zero-copy) instead of structured-cloned.
 */
function collectTransferables(value: any, buffers: Set<ArrayBuffer> = new Set(), depth = 0): ArrayBuffer[] {
	if (value === null || value === undefined || depth > 4) {
		return [...buffers];
	}
	if (value instanceof ArrayBuffer) {
		buffers.add(value);
	} else if (ArrayBuffer.isView(value)) {
		if (value.buffer instanceof ArrayBuffer) {
			buffers.add(value.buffer);
		}
	} else if (Array.isArray(value)) {
		for (const item of value) {
			collectTransferables(item, buffers, depth + 1);
		}
	} else if (typeof value === 'object' && value.constructor === Object) {
		for (const key of Object.keys(value)) {
			collectTransferables(value[key], buffers, depth + 1);
		}
	}
	return [...buffers];
}

/**
 * Bytes of the most recently decoded source, retained for formats that decode
 * one plane per request. A CZI stack re-decodes the same ~100MB file every time
 * the user steps Z, and refetching plus re-transferring it dominates the decode
 * itself. Only one entry is kept, so a different file simply evicts it.
 */
let numpyDataset: { key: string, decoder: NumpyDataset } | null = null;
let sourceCache: { key: string, buffer: ArrayBuffer } | null = null;
let tiffRegionDecoder: { key: string, decoder: TiffRegionDecoder } | null = null;

self.onmessage = async (event: MessageEvent<any>) => {
	const msg = event.data;
	// Set synchronously, before this handler yields: the decode message for the
	// .jxl that prompted it is already queued behind this one.
	if (msg.type === 'jxl-module') {
		jxlWasmModule = msg.jxlModule;
		return;
	}
	if (msg.type === 'codec-module') {
		codecWasmCompiled = msg.codecModule;
		return;
	}
	if (msg.type === 'init') {
		tiffWasmInitPromise = initTiffDecoder(msg.tiffWasmModule || msg.tiffWasmBuffer, msg.tiffWasmUrls);
		await tiffWasmInitPromise;
		self.postMessage({ type: 'ready', caps: { tiff: tiffWasmReady, tiffWasm: tiffWasmReady } });
		return;
	}

	const { id, format, buffer, options } = msg;
	const cacheKey = options?.sourceCacheKey ? String(options.sourceCacheKey) : '';
	let servedFromCache = false;
	try {
		let source: ArrayBuffer = buffer;
		if (numpyDataset && (format !== 'npy' || !options?.numpyDataset || numpyDataset.key !== cacheKey || buffer?.byteLength)) {
			numpyDataset.decoder.free();
			numpyDataset = null;
		}
		const cachedNumpy = format === 'npy' && options?.numpyDataset && numpyDataset?.key === cacheKey;
		const cachedTiffRegion = format === 'tiff-region'
			&& !!cacheKey
			&& tiffRegionDecoder?.key === cacheKey;
		if (cacheKey && format !== 'tiff-region' && !options?.numpyDataset) {
			if (tiffRegionDecoder?.key !== cacheKey) {
				tiffRegionDecoder?.decoder.free();
				tiffRegionDecoder = null;
			}
			if (!source?.byteLength && sourceCache?.key === cacheKey) {
				source = sourceCache.buffer;
				servedFromCache = true;
			} else if (source?.byteLength) {
				sourceCache = { key: cacheKey, buffer: source };
			}
			if (!source?.byteLength) {
				// The caller withheld the bytes expecting a cache that is gone.
				throw new Error('Source bytes are not cached in the decode worker');
			}
		} else if (cacheKey) {
			// TIFF regions and NumPy datasets own their source in WASM. Keeping
			// the transferred ArrayBuffer too would double large-file memory.
			if (options?.numpyDataset && tiffRegionDecoder) {
				tiffRegionDecoder.decoder.free();
				tiffRegionDecoder = null;
			}
			sourceCache = null;
			if (!source?.byteLength && !cachedTiffRegion && !cachedNumpy) {
				throw new Error('Source bytes are not cached in the decode worker');
			}
		}
		const result = await decodeFormat(format, source, options);
		const transferables = collectTransferables(result);
		// WebAssembly linear memory grows but cannot shrink. Keeping a worker
		// whose heap expanded for a 100-500 MB one-shot raster alive makes the
		// main thread's following WebGL upload contend with that retained heap.
		// Ask the client to retire it after the transfer. Cached multi-plane
		// sources (currently CZI) deliberately keep their worker and source.
		const retireWorker = !cacheKey && transferables.some(item => item.byteLength >= 64 * 1024 * 1024);
		// `sourceCached` tells the caller it may withhold the bytes next time.
		// Decoders that opt in must copy out of the source rather than aliasing
		// it, since the cached buffer outlives the response.
		// `returnSource` hands the caller's untouched input back, so it need not
		// copy the file before transferring it here. The decoders copy the bytes
		// into WebAssembly; a result that aliases the input keeps it instead.
		const returnSource = !!options?.returnSource && !cacheKey && !servedFromCache
			&& buffer?.byteLength > 0 && !transferables.includes(buffer);
		if (returnSource) { transferables.push(buffer); }
		self.postMessage({ id, ok: true, result, sourceCached: !!cacheKey, retireWorker, ...(returnSource ? { sourceBuffer: buffer } : {}) }, transferables);
	} catch (error) {
		const message = String((error instanceof Error ? error.message : error) || 'decode failed');
		// A failure involving the cache invalidates it: the caller has no bytes
		// of its own to fall back on and must refetch.
		if (cacheKey) {
			numpyDataset?.decoder.free();
			numpyDataset = null;
			sourceCache = null;
			if (tiffRegionDecoder?.key === cacheKey) {
				tiffRegionDecoder.decoder.free();
				tiffRegionDecoder = null;
			}
		}
		try {
			// Never transfer the cached buffer back — the caller did not send it,
			// and detaching it would corrupt an entry another request may hold.
			if (servedFromCache || !buffer?.byteLength) {
				self.postMessage({ id, ok: false, error: message });
			} else {
				self.postMessage({ id, ok: false, error: message, buffer }, [buffer]);
			}
		} catch {
			self.postMessage({ id, ok: false, error: message });
		}
	}
};
