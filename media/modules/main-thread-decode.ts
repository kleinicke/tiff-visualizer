"use strict";
/**
 * Main-thread Rust/WASM decode path for the seven formats that have no
 * TypeScript parser: PFM, NetPBM, NPY/NPZ, FITS, NetCDF, DICOM, CZI, ND2 and LIF.
 *
 * `DecodeWorkerClient.decodeWithFallback` runs these when the decode worker is
 * unavailable or its response is not ok. That used to be where the TypeScript
 * parsers lived; now the same Rust code runs, just on this thread, so there is
 * still exactly ONE implementation of every decoder.
 *
 * The wasm module comes from `tiff-wasm-wrapper.ts`'s cached `initWasm()` —
 * the same instance the TIFF path already uses — and the result assembly comes
 * from `wasm-decoders.ts`, shared verbatim with the worker. Nothing here is a
 * second implementation of anything.
 *
 * This module is imported ONLY by the format processors, never by
 * `decode-worker.ts`: the worker has its own init and must not pull the
 * wrapper (and its geotiff.js dependencies) into the worker bundle.
 */
import { initWasm } from './tiff-wasm-wrapper.js';
import {
	decodeCziWithWasm,
	decodeLifWithWasm,
	decodeNd2WithWasm,
	decodeDicomWithWasm,
	decodeFitsWithWasm,
	decodeJpegxrWithWasm,
	decodeNetcdfWithWasm,
	decodeNpyWithWasm,
	decodePfmWithWasm,
	decodePpmWithWasm,
} from './wasm-decoders.js';

/**
 * `initWasm()` resolves to null when the module fails to load. These formats
 * have no other decoder, so that is a hard error with an actionable message
 * rather than a silent degradation.
 */
async function requireWasm(format: string): Promise<any> {
	const wasm = await initWasm();
	if (!wasm) {
		throw new Error(
			`Cannot decode ${format}: the Rust/WASM decoder failed to load. ` +
			`${format} is decoded exclusively by WebAssembly in this extension.`);
	}
	return wasm;
}

export async function decodePfmLocal(buffer: ArrayBuffer, options: Record<string, any> = {}) {
	const wasm = await requireWasm('PFM');
	return decodePfmWithWasm(wasm.decode_pfm_display_fast, buffer, 'main', options.topDown !== false);
}

export async function decodePpmLocal(buffer: ArrayBuffer) {
	const wasm = await requireWasm('NetPBM');
	return decodePpmWithWasm(wasm.decode_ppm_display_fast, buffer, 'main');
}

export async function decodeNpyLocal(buffer: ArrayBuffer) {
	const wasm = await requireWasm('NPY');
	return decodeNpyWithWasm(wasm.decode_npy_display_fast, buffer, 'main');
}

export async function decodeJxrLocal(buffer: ArrayBuffer) {
	const wasm = await requireWasm('JPEG XR');
	return decodeJpegxrWithWasm(wasm.decode_jpegxr_fast, buffer, 'main');
}

export async function decodeFitsLocal(buffer: ArrayBuffer) {
	const wasm = await requireWasm('FITS');
	return decodeFitsWithWasm(wasm.decode_fits_fast, buffer, 'main');
}

export async function decodeNetcdfLocal(buffer: ArrayBuffer, options: Record<string, any> = {}) {
	const wasm = await requireWasm('NetCDF');
	return decodeNetcdfWithWasm(wasm.decode_netcdf_fast, buffer, options, 'main');
}

export async function decodeDicomLocal(buffer: ArrayBuffer, options: Record<string, any> = {}) {
	const wasm = await requireWasm('DICOM');
	return decodeDicomWithWasm(wasm.decode_dicom_fast, buffer, Number(options.frameIndex || 0), 'main');
}

export async function decodeNd2Local(buffer: ArrayBuffer, options: Record<string, any> = {}) {
	const wasm = await requireWasm('ND2');
	return decodeNd2WithWasm(wasm.decode_nd2_fast, buffer, options, 'main');
}

export async function decodeLifLocal(buffer: ArrayBuffer, options: Record<string, any> = {}) {
	const wasm = await requireWasm('LIF');
	return decodeLifWithWasm(wasm.decode_lif_fast, buffer, options, 'main');
}

export async function decodeCziLocal(buffer: ArrayBuffer, options: Record<string, any> = {}) {
	const wasm = await requireWasm('CZI');
	return decodeCziWithWasm(wasm.decode_czi_fast, buffer, options, 'main');
}
