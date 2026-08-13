"use strict";
/**
 * Shared Rust/WASM decode entry points for the seven formats whose
 * byte-parsing lives entirely in Rust: PFM, NetPBM (PBM/PGM/PPM), NPY/NPZ,
 * FITS, classic NetCDF, DICOM and CZI.
 *
 * There is exactly ONE implementation of each of these decoders (the Rust
 * crate in `wasm/tiff-decoder`), and exactly one copy of the JS-side result
 * assembly — this file. Both callers use it:
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
 * (see `wasm/tiff-decoder/src/lib.rs`), so there is exactly one assembly
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
 * (0 = f32, 1 = u8, 2 = u16). Called exactly once per result.
 */
function takeDecodedData(result: any): Float32Array | Uint8Array | Uint16Array {
	switch (result.sample_kind) {
		case 1: return result.take_data_as_u8();
		case 2: return result.take_data_as_u16();
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
	result: any, format: string, context: DecodeContext, startedAt: number,
) {
	const data = takeDecodedData(result) as T;
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
	return assembleDecoded<Float32Array>(result, 'pfm', context, startedAt);
}

/** NetPBM. The carrier is u16 only when the header's maxval exceeds 255. */
export function decodePpmWithWasm(
	decodePpmFast: (bytes: Uint8Array) => any,
	buffer: ArrayBuffer,
	context: DecodeContext,
) {
	const startedAt = performance.now();
	const result = decodePpmFast(new Uint8Array(buffer));
	return assembleDecoded<Uint8Array | Uint16Array>(result, 'ppm', context, startedAt);
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
		result, 'npy', context, startedAt);
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
 * dicom-object/dicom-pixeldata in Rust); any other compressed transfer
 * syntax is rejected with a descriptive error.
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
