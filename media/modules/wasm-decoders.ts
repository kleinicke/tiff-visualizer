"use strict";
/**
 * Shared Rust/WASM decode entry points for PFM, NetPBM (PBM/PGM/PPM), NPY/NPZ,
 * FITS, classic NetCDF, DICOM and CZI.
 *
 * The Rust crate in `wasm/tiff-decoder` is the complete, authoritative decoder
 * for every variant. Common binary NetPBM, native float32 NPY, and native-endian
 * PFM files may use a conservative TypedArray hot path first; unsupported inputs
 * are returned untouched to this Rust path. There is exactly one copy of the Rust result
 * assembly — this file. Both Rust callers use it:
 *
 *   - `media/decode-worker.ts`, the normal off-thread path;
 *   - the format processors' main-thread path, taken when the decode worker is
 *     unavailable or its response is not ok (see
 *     `DecodeWorkerClient.decodeWithFallback`).
 *
 * The two callers differ ONLY in how the wasm module gets initialized, so the
 * functions here take the already-initialized decode function as an argument
 * rather than importing it. The worker initializes via its own
 * `tiffWasmInitPromise`; the main thread reuses the cached module from
 * `tiff-wasm-wrapper.ts`'s `initWasm()`. Neither creates a second instance.
 *
 * All seven Rust decoders now return the same unified `DecodedArray` struct
 * (see `crates/image-decoders/src/lib.rs`), so there is exactly one assembly
 * function — `assembleDecoded` — instead of one per format. `sample_kind`
 * tells it which of the three `take_data_as_*` getters actually holds data.
 *
 * IMPORTANT: the wasm results' `take_data_as_f32()` / `take_data_as_u8()` /
 * `take_data_as_u16()` are DESTRUCTIVE — a second call returns an EMPTY
 * vector. `assembleDecoded` calls exactly one of them, exactly once. Two real
 * bugs in this project have come from calling them twice; do not "helpfully"
 * re-read the data anywhere downstream.
 */

export type DecodeTiming = { name: string, durationMs: number };

/** Where the decode ran, used only for the human-readable `decodedWith` tag. */
export type DecodeContext = 'worker' | 'main';

function tag(format: string, context: DecodeContext): string {
	return `rust-${format}-wasm (${context === 'worker' ? 'worker' : 'main thread'})`;
}

function timing(format: string, startedAt: number): DecodeTiming[] {
	// The name matters: `DecodeWorkerClient` recognizes `decode-${format}-rust`
	// when attributing worker time.
	return [{ name: `decode-${format}-rust`, durationMs: performance.now() - startedAt }];
}

/**
 * Reads the raster out of a `DecodedArray` result via whichever
 * `take_data_as_*` getter `sample_kind` says actually holds data
 * (0 = f32, 1 = u8, 2 = u16, 3 = native-endian u16 bytes). Called exactly
 * once per result.
 */
function takeDecodedData(result: any, reusableBuffer?: ArrayBuffer): Float32Array | Uint8Array | Uint16Array {
	const length = Number(result.data_len || 0);
	if (reusableBuffer && Number.isSafeInteger(length) && length >= 0) {
		const sourceOffset = Number(result.source_data_offset || 0);
		if (result.can_reuse_source === true && result.sample_kind === 0 &&
			Number.isSafeInteger(sourceOffset) && sourceOffset >= 0 && sourceOffset % 4 === 0 &&
			sourceOffset + length * 4 <= reusableBuffer.byteLength && typeof result.discard_data === 'function') {
			const target = new Float32Array(reusableBuffer, sourceOffset, length);
			result.discard_data();
			return target;
		}
			switch (result.sample_kind) {
			case 1:
				if (reusableBuffer.byteLength >= length && typeof result.copy_data_as_u8_into === 'function') {
					const target = new Uint8Array(reusableBuffer, 0, length);
					result.copy_data_as_u8_into(target);
					return target;
				}
				break;
			case 2:
				if (reusableBuffer.byteLength >= length * 2 && typeof result.copy_data_as_u16_into === 'function') {
					const target = new Uint16Array(reusableBuffer, 0, length);
					result.copy_data_as_u16_into(target);
					return target;
				}
				break;
			case 3:
				if (reusableBuffer.byteLength >= length * 2 && typeof result.copy_data_as_u8_into === 'function') {
					const bytes = new Uint8Array(reusableBuffer, 0, length * 2);
					result.copy_data_as_u8_into(bytes);
					return new Uint16Array(reusableBuffer, 0, length);
				}
				break;
			default:
				if (reusableBuffer.byteLength >= length * 4 && typeof result.copy_data_as_f32_into === 'function') {
					const target = new Float32Array(reusableBuffer, 0, length);
					result.copy_data_as_f32_into(target);
					return target;
				}
		}
	}
	switch (result.sample_kind) {
		case 1: return result.take_data_as_u8();
		case 2: return result.take_data_as_u16();
		case 3: {
			const bytes = result.take_data_as_u8() as Uint8Array;
			return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
		}
		default: return result.take_data_as_f32();
	}
}

/**
 * Rebuilds the shared decoded-image shape from a `DecodedArray` result. All
 * six Rust decoders (PFM, NetPBM, NPY/NPZ, FITS, NetCDF, DICOM) funnel
 * through here — the struct is the same shape regardless of format, so this
 * is the ONE place that reads it.
 *
 * `T` narrows `data`'s type per caller: every format except NetPBM always
 * decodes to `Float32Array` (`sample_kind` is always 0 for them), so their
 * wrappers below pass `T = Float32Array` to keep `data` concretely typed for
 * consumers instead of the full `Float32Array | Uint8Array | Uint16Array`
 * union `takeDecodedData` can return in general. `N` narrows
 * `sourceNumericType` similarly: only NPY can produce `'float16'` (a half
 * numpy dtype has no other honest representation in this union), so its
 * caller widens `N` to include it while FITS/NetCDF/DICOM/PFM/NetPBM keep the
 * narrower 8-value union `ScientificDecodedImage` expects.
 */
function assembleDecoded<
	T extends Float32Array | Uint8Array | Uint16Array,
	N extends string = 'uint8' | 'int8' | 'uint16' | 'int16' | 'uint32' | 'int32' | 'float32' | 'float64',
>(
	result: any, format: string, context: DecodeContext, startedAt: number, statsReady = true,
	reusableBuffer?: ArrayBuffer,
) {
	const data = takeDecodedData(result, reusableBuffer) as T;
	const metadata = JSON.parse(result.metadata_json);
	return {
		width: result.width as number,
		height: result.height as number,
		channels: result.channels as number,
		data,
		metadata,
		numericDomain: {
			bitsPerSample: result.bits_per_sample as number,
			sampleFormat: result.sample_format as 1 | 2 | 3,
			typeMin: result.type_min as number,
			typeMax: result.type_max as number,
			sourceNumericType: result.source_numeric_type as N,
		},
		// Array/scientific decoders compute this eagerly. PFM/NetPBM's display
		// entry points skip it because their initial gamma mode does not consume
		// stats; those processors calculate it lazily if the mode changes.
		stats: statsReady ? { min: result.data_min as number, max: result.data_max as number } : undefined,
		nonFiniteCount: result.non_finite_count as number,
		validCount: result.valid_count as number,
		formatLabel: result.format_label as string,
		decodedWith: tag(format, context),
		decodeTimings: timing(format, startedAt),
	};
}

/**
 * PFM. `topDown` is always true in practice — row 0 must end up topmost for
 * the canvas — but it stays an explicit argument because the Rust decoder
 * supports both and the conformance suite exercises both.
 */
export function decodePfmWithWasm(
	decodePfmFast: (bytes: Uint8Array, topDown: boolean) => any,
	buffer: ArrayBuffer,
	context: DecodeContext,
	topDown = true,
) {
	const startedAt = performance.now();
	const result = decodePfmFast(new Uint8Array(buffer), topDown);
	return assembleDecoded<Float32Array>(result, 'pfm', context, startedAt, false, buffer);
}

/** NetPBM. The carrier is u16 only when the header's maxval exceeds 255. */
export function decodePpmWithWasm(
	decodePpmFast: (bytes: Uint8Array) => any,
	buffer: ArrayBuffer,
	context: DecodeContext,
) {
	const startedAt = performance.now();
	const result = decodePpmFast(new Uint8Array(buffer));
	return assembleDecoded<Uint8Array | Uint16Array>(result, 'ppm', context, startedAt, false, buffer);
}

/**
 * NPY/NPZ. The Rust entry point dispatches internally between a plain `.npy`
 * and a `.npz` archive on the ZIP local-file-header signature, so there is no
 * separate NPZ function here.
 */
export function decodeNpyWithWasm(
	decodeNpyFast: (bytes: Uint8Array) => any,
	buffer: ArrayBuffer,
	context: DecodeContext,
) {
	const startedAt = performance.now();
	const result = decodeNpyFast(new Uint8Array(buffer));
	return assembleDecoded<Float32Array, 'uint8' | 'int8' | 'uint16' | 'int16' | 'uint32' | 'int32' | 'float16' | 'float32' | 'float64'>(
		result, 'npy', context, startedAt, true, buffer);
}

/**
 * Standalone JPEG XR. Unlike the other array decoders this one can produce
 * 8-, 16- or 32-bit samples depending on the file's pixel format, but they all
 * arrive as f32 like FITS and friends, so the shared assembly applies.
 */
/**
 * Standalone JPEG XL. Unlike every other decoder here, `decodeJxlFast` comes
 * from a DIFFERENT WebAssembly module (`wasm/jxl-decoder`, fetched on demand),
 * but the result it returns is the same shape, so the shared assembly applies
 * unchanged. That module's result carries only the f32 carrier — JPEG XL never
 * produces the u8/u16 ones — so no reusable buffer is passed.
 */
export function decodeJxlWithWasm(
	decodeJxlFast: (bytes: Uint8Array) => any,
	buffer: ArrayBuffer,
	context: DecodeContext,
) {
	const startedAt = performance.now();
	const result = decodeJxlFast(new Uint8Array(buffer));
	return assembleDecoded<Float32Array>(result, 'jxl', context, startedAt);
}

export function decodeJpegxrWithWasm(
	decodeJpegxrFast: (bytes: Uint8Array) => any,
	buffer: ArrayBuffer,
	context: DecodeContext,
) {
	const startedAt = performance.now();
	const result = decodeJpegxrFast(new Uint8Array(buffer));
	return assembleDecoded<Float32Array>(result, 'jxr', context, startedAt);
}

export function decodeJpeg2000WithWasm(
	decodeJpeg2000Fast: (bytes: Uint8Array) => any,
	buffer: ArrayBuffer,
	context: DecodeContext,
) {
	const startedAt = performance.now();
	const result = decodeJpeg2000Fast(new Uint8Array(buffer));
	return assembleDecoded<Float32Array>(result, 'jp2', context, startedAt);
}

export function decodeFitsWithWasm(
	decodeFitsFast: (bytes: Uint8Array) => any,
	buffer: ArrayBuffer,
	context: DecodeContext,
) {
	const startedAt = performance.now();
	const result = decodeFitsFast(new Uint8Array(buffer));
	return assembleDecoded<Float32Array>(result, 'fits', context, startedAt);
}

export function decodeNetcdfWithWasm(
	decodeNetcdfFast: (bytes: Uint8Array, optionsJson: string) => any,
	buffer: ArrayBuffer,
	options: Record<string, any>,
	context: DecodeContext,
) {
	const startedAt = performance.now();
	const result = decodeNetcdfFast(new Uint8Array(buffer), JSON.stringify(options || {}));
	return assembleDecoded<Float32Array>(result, 'netcdf', context, startedAt);
}

/**
 * DICOM decoding, native and compressed alike. `decode_dicom_fast` decodes
 * JPEG Baseline and RLE Lossless Pixel Data natively (via
 * the same zune-jpeg the TIFF path uses, plus a PackBits reader for RLE); JPEG
 * 2000, JPEG-LS, lossless JPEG and Deflated Explicit VR decode too. Any other
 * compressed transfer syntax is rejected with a descriptive error.
 */
export function decodeDicomWithWasm(
	decodeDicomFast: (bytes: Uint8Array, frameIndex: number) => any,
	buffer: ArrayBuffer,
	frameIndex: number,
	context: DecodeContext,
) {
	const startedAt = performance.now();
	const result = decodeDicomFast(new Uint8Array(buffer), frameIndex >>> 0);
	return assembleDecoded<Float32Array>(result, 'dicom', context, startedAt);
}

/**
 * Zeiss CZI. `decode_czi_fast` walks the subblock directory (falling back to
 * a full segment scan) and assembles the plane matching `options.indices`
 * (per-axis Z/C/T/... coordinates); unspecified axes default to their first
 * coordinate. Compressed subblocks are rejected with a descriptive error.
 */
export function decodeCziWithWasm(
	decodeCziFast: (bytes: Uint8Array, optionsJson: string) => any,
	buffer: ArrayBuffer,
	options: Record<string, any>,
	context: DecodeContext,
) {
	const startedAt = performance.now();
	const result = decodeCziFast(new Uint8Array(buffer), JSON.stringify(options || {}));
	return assembleDecoded<Float32Array>(result, 'czi', context, startedAt);
}

/**
 * Nikon ND2. `decode_nd2_fast` reads the chunk map, resolves `options.indices`
 * (T/P/Z/C) against the experiment loop structure and returns that one frame.
 * Legacy (pre-2012) containers and Nikon's compressed modes are rejected with
 * a descriptive error rather than decoded incorrectly.
 */
export function decodeNd2WithWasm(
	decodeNd2Fast: (bytes: Uint8Array, optionsJson: string) => any,
	buffer: ArrayBuffer,
	options: Record<string, any>,
	context: DecodeContext,
) {
	const startedAt = performance.now();
	const result = decodeNd2Fast(new Uint8Array(buffer), JSON.stringify(options || {}));
	return assembleDecoded<Float32Array>(result, 'nd2', context, startedAt);
}

/**
 * Leica LIF. `decode_lif_fast` reads the XML header, indexes the memory
 * blocks and assembles one plane of one series; `options.indices.S` selects
 * the series, the remaining axes (Z/T/M/C) the plane within it.
 */
export function decodeLifWithWasm(
	decodeLifFast: (bytes: Uint8Array, optionsJson: string) => any,
	buffer: ArrayBuffer,
	options: Record<string, any>,
	context: DecodeContext,
) {
	const startedAt = performance.now();
	const result = decodeLifFast(new Uint8Array(buffer), JSON.stringify(options || {}));
	return assembleDecoded<Float32Array>(result, 'lif', context, startedAt);
}

/** Becker & Hickl SDT: integrated intensity, mean-arrival, or time-bin view. */
export function decodeSdtWithWasm(
	decodeSdtFast: (bytes: Uint8Array, optionsJson: string) => any,
	buffer: ArrayBuffer,
	options: Record<string, any>,
	context: DecodeContext,
) {
	const startedAt = performance.now();
	const result = decodeSdtFast(new Uint8Array(buffer), JSON.stringify(options || {}));
	return assembleDecoded<Float32Array>(result, 'sdt', context, startedAt);
}
