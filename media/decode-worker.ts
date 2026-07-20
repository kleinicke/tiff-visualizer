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
 * JXL) or that already decode off-thread (camera RAW via the libraw worker)
 * keep their existing processors. Every format handled here also keeps its
 * local decoder as a fallback: on any worker error the input bytes are
 * transferred back so the caller can decode locally without refetching.
 */

import './modules/worker-shims.js';
// Vendored, window-attaching parse-exr build with channel-name support — the
// npm parse-exr package lacks channelNames/displayedChannels, so the worker
// must use the exact same build as the main thread.
import './parse-exr.js';
// Keep the compatibility TIFF fallback in this worker too. Some valid TIFF
// variants are not supported by the Rust decoder, and decoding those with
// geotiff.js on the webview thread would freeze the UI.
import * as WorkerGeoTIFF from './geotiff.min.js';
import UPNG from './upng.min.js';
import parseHdr from 'parse-hdr';
import initTiffWasm, { decode_exr_fast, decode_hdr_fast, decode_png16_fast, decode_tiff, decode_tiff_fast, decode_tiff_page, decode_tiff_page_fast, tiff_page_count } from './wasm/tiff-wasm.js';
import { NpyProcessor } from './modules/npy-processor.js';
import { PfmProcessor } from './modules/pfm-processor.js';
import { PpmProcessor } from './modules/ppm-processor.js';
import { buildTagsFromGeotiffImage } from './modules/tiff-tag-utils.js';

// This file runs as a Web Worker entry point. The "dom" lib (see
// media/tsconfig.json) types `self` as `Window & typeof globalThis`, which
// doesn't match the DedicatedWorkerGlobalScope API used here (e.g. the
// two-argument `postMessage(message, transferList)` overload, or assigning
// `onmessage` directly). Adding the `webworker` lib would conflict with
// `dom`, so `self` is pragmatically typed as `any` instead.
declare const self: any;

// Parser-only instances: the constructors just assign fields, and the
// _parse* methods used here touch no DOM or vscode APIs.
const npyParser = new NpyProcessor(null as any, null);
const pfmParser = new PfmProcessor(null as any, null);
const ppmParser = new PpmProcessor(null as any, null);

let tiffWasmReady = false;
let tiffWasmInitPromise: Promise<void> | null = null;
const TIFF_WASM_INIT_TIMEOUT_MS = 3000;

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
async function initTiffDecoder(buffer: ArrayBuffer | null | undefined, urls: string[]) {
	if (buffer?.byteLength) {
		try {
			await withTimeout(
				initTiffWasm({ module_or_path: buffer }),
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
 * Decode a TIFF with the Rust/WASM decoder, mirroring TiffWasmProcessor.decode
 * and additionally deinterleaving the per-channel rasters off-thread.
 */
function decodeTiffWasm(buffer: ArrayBuffer, pageIndex = 0) {
	if (!tiffWasmReady) {
		throw new Error('TIFF WASM decoder not initialized');
	}
	const timings = [];
	let phaseStart = performance.now();
	const bytes = new Uint8Array(buffer);
	const pageCount = typeof tiff_page_count === 'function' ? tiff_page_count(bytes) : 1;
	if (pageIndex < 0 || pageIndex >= pageCount) {
		throw new Error(`TIFF page index ${pageIndex} is out of range (page count: ${pageCount})`);
	}
	const result = pageIndex > 0 && typeof decode_tiff_page_fast === 'function'
		? decode_tiff_page_fast(bytes, pageIndex)
		: pageIndex > 0 && typeof decode_tiff_page === 'function'
			? decode_tiff_page(bytes, pageIndex)
			: typeof decode_tiff_fast === 'function'
				? decode_tiff_fast(bytes)
				: decode_tiff(bytes);
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
	const data = typeof result.take_data_as_f32 === 'function'
		? result.take_data_as_f32()
		: result.get_data_as_f32();
	now = performance.now();
	timings.push({ name: 'decode-wasm-to-f32', durationMs: now - phaseStart });

	phaseStart = now;
	const rasters: Float32Array[] = [];
	if (channels === 1) {
		rasters.push(data);
	} else {
		const pixelCount = width * height;
		for (let c = 0; c < channels; c++) {
			const channel = new Float32Array(pixelCount);
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
		decodedWith: 'wasm (worker)',
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
		decodedWith: 'geotiff.js (worker)',
		wasmFallbackReason: wasmError,
		decodeTimings: timings,
	};
}

async function decodeTiff(buffer: ArrayBuffer, pageIndex = 0) {
	if (tiffWasmInitPromise) {
		// WASM is preferred, but a slow or wedged initialization must never
		// prevent the worker's GeoTIFF compatibility decoder from running.
		await withTimeout(tiffWasmInitPromise, TIFF_WASM_INIT_TIMEOUT_MS, 'TIFF WASM init wait timed out')
			.catch(error => console.warn('[DecodeWorker]', error));
	}
	try {
		return decodeTiffWasm(buffer, pageIndex);
	} catch (error) {
		const message = String((error instanceof Error ? error.message : error) || 'WASM decode failed');
		console.warn('[DecodeWorker] TIFF WASM decode failed, using geotiff.js in worker:', message);
		return decodeTiffGeotiff(buffer, message, pageIndex);
	}
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
		console.warn('[DecodeWorker] EXR WASM decode failed, using parse-exr in worker:', message);
		return decodeExrParseExr(buffer, message);
	}
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
		console.warn('[DecodeWorker] PNG WASM decode failed, using UPNG in worker:', message);
		return decodePng16Upng(buffer, message);
	}
}

function decodePpmWorker(buffer: ArrayBuffer) {
	const start = performance.now();
	const result = ppmParser._parsePpm(buffer);
	const parseTimings = Array.isArray(result.decodeTimings) ? result.decodeTimings : [];
	result.decodeTimings = [
		{ name: 'decode-ppm-parse', durationMs: performance.now() - start },
		...parseTimings
	];
	return result;
}

async function decodeFormat(format: string, buffer: ArrayBuffer, options: Record<string, any> = {}) {
	switch (format) {
		case 'tiff':
			return decodeTiff(buffer, Number(options.pageIndex || 0));
		case 'exr':
			return decodeExr(buffer);
		case 'npy': {
			const view = new DataView(buffer);
			// NPZ (ZIP) signature 0x04034b50
			if (buffer.byteLength >= 4 && view.getUint32(0, true) === 0x04034b50) {
				return npyParser._parseNpz(buffer);
			}
			return npyParser._parseNpy(buffer);
		}
		case 'pfm':
			return pfmParser._parsePfm(buffer, { topDown: true });
		case 'ppm':
			return decodePpmWorker(buffer);
		case 'png16':
			return decodePng16(buffer);
		case 'hdr':
			return decodeHdr(buffer);
		default:
			throw new Error(`Unknown decode format: ${format}`);
	}
}

/**
 * Collect every distinct ArrayBuffer reachable from a decode result so its
 * typed arrays are transferred (zero-copy) instead of structured-cloned.
 */
function collectTransferables(value: any, buffers: Set<ArrayBuffer> = new Set(), depth = 0): ArrayBuffer[] {
	if (value == null || depth > 4) {
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

self.onmessage = async (event: MessageEvent<any>) => {
	const msg = event.data;
	if (msg.type === 'init') {
		// GeoTIFF is ready as soon as the worker bundle has loaded. Advertise
		// that immediately so early image loads do not fall back to the UI
		// thread while WASM is still initializing.
		self.postMessage({ type: 'ready', caps: { tiff: true, tiffWasm: false } });
		tiffWasmInitPromise = initTiffDecoder(msg.tiffWasmBuffer, msg.tiffWasmUrls);
		await tiffWasmInitPromise;
		self.postMessage({ type: 'caps', caps: { tiff: true, tiffWasm: tiffWasmReady } });
		return;
	}

	const { id, format, buffer, options } = msg;
	try {
		const result = await decodeFormat(format, buffer, options);
		self.postMessage({ id, ok: true, result }, collectTransferables(result));
	} catch (error) {
		// Send the input bytes back (transferred) so the caller can fall back
		// to its local decoder without refetching the file.
		const message = String((error instanceof Error ? error.message : error) || 'decode failed');
		try {
			self.postMessage({ id, ok: false, error: message, buffer }, [buffer]);
		} catch {
			self.postMessage({ id, ok: false, error: message });
		}
	}
};
