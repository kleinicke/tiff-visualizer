"use strict";
/**
 * Shared Rust/WASM decode entry points for the six formats whose byte-parsing
 * lives entirely in Rust: PFM, NetPBM (PBM/PGM/PPM), NPY/NPZ, FITS, classic
 * NetCDF and DICOM.
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
 * IMPORTANT: the wasm results' `take_data_as_f32()` / `take_data_as_u8()` /
 * `take_data_as_u16()` are DESTRUCTIVE — a second call returns an EMPTY
 * vector. Every function here takes the array exactly once. Two real bugs in
 * this project have come from calling them twice; do not "helpfully" re-read
 * the data anywhere downstream.
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
	const data = result.take_data_as_f32();
	return {
		width: result.width,
		height: result.height,
		channels: result.channels,
		data,
		decodedWith: tag('pfm', context),
		decodeTimings: timing('pfm', startedAt),
	};
}

/** NetPBM. The carrier is u16 only when the header's maxval exceeds 255. */
export function decodePpmWithWasm(
	decodePpmFast: (bytes: Uint8Array) => any,
	buffer: ArrayBuffer,
	context: DecodeContext,
) {
	const startedAt = performance.now();
	const result = decodePpmFast(new Uint8Array(buffer));
	const data = result.is_16bit ? result.take_data_as_u16() : result.take_data_as_u8();
	return {
		width: result.width,
		height: result.height,
		channels: result.channels,
		data,
		maxval: result.maxval,
		format: result.format,
		decodedWith: tag('ppm', context),
		decodeTimings: timing('ppm', startedAt),
	};
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
	const data = result.take_data_as_f32();
	return {
		width: result.width,
		height: result.height,
		channels: result.channels,
		dtype: result.dtype,
		showNorm: result.show_norm,
		data,
		decodedWith: tag('npy', context),
		decodeTimings: timing('npy', startedAt),
	};
}

/**
 * Rebuilds the shared `ScientificDecodedImage` shape from the flat
 * `ScientificResult` getters. FITS, NetCDF and DICOM all return this one
 * struct, so they all funnel through here.
 */
export function scientificResultToDecoded(result: any) {
	const data = result.take_data_as_f32();
	const metadata = JSON.parse(result.metadata_json);
	return {
		width: result.width,
		height: result.height,
		channels: result.channels,
		data,
		metadata,
		numericDomain: {
			bitsPerSample: result.bits_per_sample,
			sampleFormat: result.sample_format,
			typeMin: result.type_min,
			typeMax: result.type_max,
			sourceNumericType: result.source_numeric_type,
		},
	};
}

export function decodeFitsWithWasm(
	decodeFitsFast: (bytes: Uint8Array) => any,
	buffer: ArrayBuffer,
	context: DecodeContext,
) {
	const startedAt = performance.now();
	const decoded: any = scientificResultToDecoded(decodeFitsFast(new Uint8Array(buffer)));
	decoded.decodedWith = tag('fits', context);
	decoded.decodeTimings = timing('fits', startedAt);
	return decoded;
}

export function decodeNetcdfWithWasm(
	decodeNetcdfFast: (bytes: Uint8Array, optionsJson: string) => any,
	buffer: ArrayBuffer,
	options: Record<string, any>,
	context: DecodeContext,
) {
	const startedAt = performance.now();
	const decoded: any = scientificResultToDecoded(
		decodeNetcdfFast(new Uint8Array(buffer), JSON.stringify(options || {})));
	decoded.decodedWith = tag('netcdf', context);
	decoded.decodeTimings = timing('netcdf', startedAt);
	return decoded;
}

/**
 * DICOM with native (uncompressed) Pixel Data.
 *
 * Encapsulated/compressed Pixel Data is NOT decoded here: the Rust decoder
 * throws an error containing `requires codec: jpeg-baseline`, which the caller
 * catches and routes through `extractDicomJpegFrame` + `decode_jpeg_fast`.
 * That contract is asserted by the conformance suite — do not change the
 * message without updating both the caller and the golden.
 */
export function decodeDicomWithWasm(
	decodeDicomFast: (bytes: Uint8Array, frameIndex: number) => any,
	buffer: ArrayBuffer,
	frameIndex: number,
	context: DecodeContext,
) {
	const startedAt = performance.now();
	const decoded: any = scientificResultToDecoded(
		decodeDicomFast(new Uint8Array(buffer), frameIndex >>> 0));
	decoded.decodedWith = tag('dicom', context);
	decoded.decodeTimings = timing('dicom', startedAt);
	return decoded;
}
