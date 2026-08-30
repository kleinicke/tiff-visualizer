"use strict";

/**
 * Re-decode a file whose codec the core WebAssembly module does not carry.
 *
 * The core reports such a codec with an `[external-codec:NAME]` error while
 * reading the file's header, before any pixel work. Only that error reaches
 * here: any other failure is a real decode failure, and retrying it would
 * download a couple of megabytes to fail the same way.
 *
 * This runs on the MAIN THREAD, not in the decode worker, and deliberately so.
 * The worker bundle is an IIFE that esbuild cannot code-split, so importing the
 * codec module's wasm-pack glue there added 78 KB of JavaScript to a bundle
 * every ordinary image open already loads. Here the glue lands in a code-split
 * chunk that is fetched only alongside the module itself. The cost is that a
 * file needing one of these codecs decodes on the main thread — which is the
 * decode worker's existing "response is not ok" fallback path, and a bounded
 * price for a file that has just downloaded a 2.6 MB module anyway. Moving it
 * back off-thread means a second worker bundle built against the codec glue,
 * not adding that glue to this one.
 *
 * The formats listed are exactly the containers that can carry a heavy codec:
 *
 *   TIFF   JPEG 2000 (34712, 33003-5), JPEG XR (34934, 22610), LERC (34887),
 *          LZMA (34925), WebP (34927)
 *   DICOM  JPEG 2000 (.4.90/.91), JPEG-LS (.4.80/.81), lossless JPEG (.4.57/.70)
 *   CZI    JPEG XR subblocks
 *   JXR    the standalone file, which IS a JPEG XR codestream
 *
 * Everything else — EXR, PNG, HDR, NumPy, NetPBM, PFM, FITS, NetCDF, ND2, LIF
 * — has no codec outside the core, so a failure there is never retried.
 */

import type { CodecModule } from './codec-wasm-wrapper.js';
import {
	decodeCziWithWasm,
	decodeDicomWithWasm,
	decodeJpegxrWithWasm,
} from './wasm-decoders.js';
import type { DecodeContext } from './wasm-decoders.js';

/** Formats whose decode can be retried in the codec module. */
export const CODEC_FALLBACK_FORMATS: ReadonlySet<string> =
	new Set(['tiff', 'dicom', 'czi', 'jxr']);

/**
 * Decode `format` with the already-initialized codec module.
 *
 * TIFF is not handled here: `TiffWasmProcessor.decode` retries itself with the
 * codec module's exports, because it also builds tags and reports timings,
 * none of which should exist twice.
 */
export function decodeNonTiffWithCodecModule(
	wasm: CodecModule,
	format: string,
	buffer: ArrayBuffer,
	options: Record<string, any>,
	context: DecodeContext,
) {
	switch (format) {
		case 'dicom':
			return decodeDicomWithWasm(
				wasm.decode_dicom_fast, buffer, Number(options?.frameIndex || 0), context);
		case 'czi':
			return decodeCziWithWasm(wasm.decode_czi_fast, buffer, options || {}, context);
		case 'jxr':
			return decodeJpegxrWithWasm(wasm.decode_jpegxr_fast, buffer, context);
		default:
			throw new Error(`${format} has no codec-module decoder`);
	}
}
