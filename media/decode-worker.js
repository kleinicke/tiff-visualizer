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

/** @param {string[]} urls - Candidate URLs for tiff-wasm.wasm */
async function initTiffDecoder(urls) {
	for (const url of urls || []) {
		try {
			await initTiffWasm(url);
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
function decodeTiff(buffer) {
	if (!tiffWasmReady) {
		throw new Error('TIFF WASM decoder not initialized');
	}
	const result = decode_tiff(new Uint8Array(buffer));
	const width = result.width;
	const height = result.height;
	const channels = result.channels;
	const data = new Float32Array(result.get_data_as_f32());

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
	};
}

/**
 * @param {string} format
 * @param {ArrayBuffer} buffer
 */
function decodeFormat(format, buffer) {
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
		await initTiffDecoder(msg.tiffWasmUrls);
		self.postMessage({ type: 'ready', caps: { tiffWasm: tiffWasmReady } });
		return;
	}

	const { id, format, buffer } = msg;
	try {
		const result = decodeFormat(format, buffer);
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
