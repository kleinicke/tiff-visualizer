// @ts-check
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
import initTiffWasm, { decode_tiff } from './wasm/tiff-wasm.js';
import { NpyProcessor } from './modules/npy-processor.js';
import { PfmProcessor } from './modules/pfm-processor.js';
import { PpmProcessor } from './modules/ppm-processor.js';

// Parser-only instances: the constructors just assign fields, and the
// _parse* methods used here touch no DOM or vscode APIs.
const npyParser = new NpyProcessor(/** @type {any} */ (null), null);
const pfmParser = new PfmProcessor(/** @type {any} */ (null), null);
const ppmParser = new PpmProcessor(/** @type {any} */ (null), null);

let tiffWasmReady = false;
/** @type {Promise<void>|null} */
let tiffWasmInitPromise = null;
const TIFF_WASM_INIT_TIMEOUT_MS = 3000;

/** @param {Promise<any>} promise @param {number} ms @param {string} message */
function withTimeout(promise, ms, message) {
	return Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
	]);
}

/**
 * @param {ArrayBuffer|null|undefined} buffer - Bytes fetched by the webview
 * @param {string[]} urls - Candidate URLs for ordinary browser workers
 */
async function initTiffDecoder(buffer, urls) {
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
 * @param {ArrayBuffer} buffer
 */
function decodeTiffWasm(buffer) {
	if (!tiffWasmReady) {
		throw new Error('TIFF WASM decoder not initialized');
	}
	const timings = [];
	let phaseStart = performance.now();
	const result = decode_tiff(new Uint8Array(buffer));
	let now = performance.now();
	timings.push({ name: 'decode-wasm-rust', durationMs: now - phaseStart });

	phaseStart = now;
	const width = result.width;
	const height = result.height;
	const channels = result.channels;
	const data = new Float32Array(result.get_data_as_f32());
	now = performance.now();
	timings.push({ name: 'decode-wasm-to-f32', durationMs: now - phaseStart });

	phaseStart = now;
	/** @type {Float32Array[]} */
	const rasters = [];
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
		width,
		height,
		channels,
		bitsPerSample: result.bits_per_sample,
		sampleFormat: result.sample_format,
		compression: result.compression,
		predictor: result.predictor,
		photometricInterpretation: result.photometric_interpretation,
		planarConfiguration: result.planar_configuration,
		data,
		rasters,
		min: result.min_value,
		max: result.max_value,
		decodedWith: 'wasm (worker)',
		decodeTimings: timings,
	};
}

/**
 * Decode TIFF variants unsupported by the Rust decoder without blocking the
 * webview thread.
 * @param {ArrayBuffer} buffer
 * @param {string} wasmError
 */
async function decodeTiffGeotiff(buffer, wasmError) {
	const timings = [];
	let phaseStart = performance.now();
	const tiff = await WorkerGeoTIFF.fromArrayBuffer(buffer);
	let now = performance.now();
	timings.push({ name: 'decode-geotiff-open', durationMs: now - phaseStart });

	phaseStart = now;
	const image = await tiff.getImage();
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

	/** @type {Float32Array} */
	let data;
	/** @type {Float32Array[]|any[]} */
	let rasters;
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
		decodedWith: 'geotiff.js (worker)',
		wasmFallbackReason: wasmError,
		decodeTimings: timings,
	};
}

/** @param {ArrayBuffer} buffer */
async function decodeTiff(buffer) {
	if (tiffWasmInitPromise) {
		// WASM is preferred, but a slow or wedged initialization must never
		// prevent the worker's GeoTIFF compatibility decoder from running.
		await withTimeout(tiffWasmInitPromise, TIFF_WASM_INIT_TIMEOUT_MS, 'TIFF WASM init wait timed out')
			.catch(error => console.warn('[DecodeWorker]', error));
	}
	try {
		return decodeTiffWasm(buffer);
	} catch (error) {
		const message = String((error instanceof Error ? error.message : error) || 'WASM decode failed');
		console.warn('[DecodeWorker] TIFF WASM decode failed, using geotiff.js in worker:', message);
		return decodeTiffGeotiff(buffer, message);
	}
}

/**
 * @param {string} format
 * @param {ArrayBuffer} buffer
 */
async function decodeFormat(format, buffer) {
	switch (format) {
		case 'tiff':
			return decodeTiff(buffer);
		case 'exr':
			// FloatType (1015): decoded Float32Array values, matching exr-processor.
			// @ts-ignore — parseExr is attached to the (shimmed) window by parse-exr.js
			return globalThis.parseExr(buffer, 1015);
		case 'npy': {
			const view = new DataView(buffer);
			// NPZ (ZIP) signature 0x04034b50
			if (buffer.byteLength >= 4 && view.getUint32(0, true) === 0x04034b50) {
				return npyParser._parseNpz(buffer);
			}
			return npyParser._parseNpy(buffer);
		}
		case 'pfm':
			return pfmParser._parsePfm(buffer);
		case 'ppm':
			return ppmParser._parsePpm(buffer);
		case 'png16':
			return UPNG.decode(buffer);
		case 'hdr':
			return parseHdr(buffer);
		default:
			throw new Error(`Unknown decode format: ${format}`);
	}
}

/**
 * Collect every distinct ArrayBuffer reachable from a decode result so its
 * typed arrays are transferred (zero-copy) instead of structured-cloned.
 * @param {any} value
 * @param {Set<ArrayBuffer>} [buffers]
 * @param {number} [depth]
 * @returns {ArrayBuffer[]}
 */
function collectTransferables(value, buffers = new Set(), depth = 0) {
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

self.onmessage = async (event) => {
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

	const { id, format, buffer } = msg;
	try {
		const result = await decodeFormat(format, buffer);
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
