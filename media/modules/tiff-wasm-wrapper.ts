"use strict";

import { parseAllTagsJson, TagEntry } from './tiff-tag-utils.js';
// Imported STATICALLY, exactly as media/decode-worker.ts does it, so esbuild
// inlines the wasm-pack glue into the bundle. That matters for how the glue
// finds its .wasm payload: it contains
// `new URL('wasm/tiff-wasm.wasm', import.meta.url)` (patched in by the
// build:wasm script), which is only correct when the glue's base URL is
// `media/` — i.e. when it is bundled. A dynamic `import()` with a
// non-literal specifier is left for the runtime instead, making the base
// `media/wasm/` and the payload resolve to `media/wasm/wasm/…` (404).
// Importing the module does not instantiate wasm; `init()` below does.
import initTiffWasm, {
	decode_czi_fast, decode_dicom_fast, decode_lif_fast, decode_nd2_fast, decode_sdt_fast, label_components_fast, fill_mask_holes_fast, distance_transform_fast, gaussian_blur_fast, subtract_background_fast, decode_fits_fast, decode_netcdf_fast, decode_npy_display_fast,
    decode_pfm_display_fast, decode_ppm_display_fast, decode_tiff, decode_tiff_page,
    demosaic, extract_exif_tags, tiff_page_count, tiff_page_directory,
    decode_tiff_region, tiff_region_decode_available, decode_tiff_preview, tiff_preview_reduction,
    remote_tiff_header, remote_tiff_ifd, remote_tiff_index_values,
    compute_image_stats_f32, compute_image_stats_u8, compute_image_stats_u16,
    build_histogram_fast, auto_threshold_bin_fast, global_threshold_mask_fast,
    local_threshold_mask_fast, local_auto_threshold_mask_fast, compute_stability_curve_fast,
    tiff_float_strip_plan, tiff_strip_metadata,
    exr_zip_f32_plan,
} from '../wasm/tiff-wasm.js';

/**
 * Fast TIFF Processor using WebAssembly
 *
 * This module provides a high-performance TIFF decoder using Rust/WebAssembly.
 * It can be used as a drop-in replacement for geotiff.js for faster loading.
 */

let wasmModule: any = null;
let wasmInitPromise: Promise<any> | null = null;

/**
 * Initialize the WASM module
 */
async function initWasm(): Promise<any> {
    if (wasmModule) {
        return wasmModule;
    }
    if (wasmInitPromise) {
        return wasmInitPromise;
    }

    wasmInitPromise = (async () => {
        try {
			// Code-split processor chunks live under media/chunks/, so allowing the
			// wasm-pack glue to resolve its default URL relative to import.meta.url
			// would incorrectly request media/chunks/wasm/. Prefer the module already
			// compiled by the tiny VS Code bootstrap; the standalone web build uses
			// the explicit asset URL instead.
			const warmup = (globalThis as any).__tiffVisualizerDecoderWarmup as {
				wasmModulePromise?: Promise<WebAssembly.Module>;
			} | undefined;
			let initInput: WebAssembly.Module | ArrayBuffer | undefined;
			if (warmup?.wasmModulePromise) {
				try { initInput = await warmup.wasmModulePromise; } catch { /* use explicit asset */ }
			}
			if (!initInput) {
				const wasmUrl = (globalThis as any).__tiffVisualizerVendorAssets?.wasm;
				if (wasmUrl) {
					const response = await fetch(wasmUrl);
					if (!response.ok) { throw new Error(`TIFF WASM fetch failed (${response.status})`); }
					initInput = await response.arrayBuffer();
				}
			}
			await initTiffWasm(initInput);
            // These decode_*_fast entries back the main-thread decode path
            // in `main-thread-decode.ts`, taken when the decode worker is
            // unavailable. They share this one cached module instance rather
            // than initializing a second copy.
            wasmModule = {
                decode_tiff, decode_tiff_page, tiff_page_count, tiff_page_directory, extract_exif_tags, demosaic,
                // Rectangle reads: the cost of a view follows the window, not the file.
                decode_tiff_region, tiff_region_decode_available, decode_tiff_preview, tiff_preview_reduction,
    remote_tiff_header, remote_tiff_ifd, remote_tiff_index_values,
                decode_pfm_display_fast, decode_ppm_display_fast, decode_npy_display_fast, decode_fits_fast,
				decode_netcdf_fast, decode_dicom_fast, decode_czi_fast, decode_nd2_fast, decode_lif_fast, decode_sdt_fast,
                compute_image_stats_f32, compute_image_stats_u8, compute_image_stats_u16,
                label_components_fast, fill_mask_holes_fast, distance_transform_fast, gaussian_blur_fast, subtract_background_fast,
                build_histogram_fast, auto_threshold_bin_fast, global_threshold_mask_fast,
                local_threshold_mask_fast, local_auto_threshold_mask_fast, compute_stability_curve_fast,
                // IFD-only reads backing the strip-parallel decode path.
                tiff_float_strip_plan, tiff_strip_metadata,
                exr_zip_f32_plan,
            };
            return wasmModule;
        } catch (error) {
            // In the webview this is a real problem worth surfacing. Under
            // Node (the tsc `out/` layout used by tests) it is expected: the
            // wasm-pack "web" glue fetches its payload, which Node cannot
            // serve from a file URL. Tests that need the decoder pass explicit
            // bytes to `init()` instead.
            const isNode = typeof process !== 'undefined' && !!(process as any).versions?.node;
            console.warn(isNode
                ? `[tiff-wasm-wrapper] WASM self-initialization is unavailable under Node (expected); pass explicit bytes to init(). ${error}`
                : `Failed to load WASM module, will use geotiff.js fallback: ${error}`);
            return null;
        }
    })();

    return wasmInitPromise;
}

/**
 * Shared accessor for the initialised WASM module.
 *
 * Other modules (e.g. the debayer view transform) need WASM entry points that
 * are unrelated to TIFF decoding but live in the same crate. Returns null if
 * the module failed to load, so callers must keep a JS fallback.
 */
export async function getWasmModule(): Promise<any> {
    return initWasm();
}

/** Synchronous peek: non-null only once {@link getWasmModule} has resolved. */
export function getWasmModuleSync(): any {
    return wasmModule;
}

export interface TiffDecodeResult {
	pageIndex: number;
	pageCount: number;
    width: number;
    height: number;
    channels: number;
    bitsPerSample: number;
    /** 1=uint, 2=int, 3=float */
    sampleFormat: number;
	/** 0=f32, 1=u8, 3=little-endian u16 packed as bytes at the WASM boundary */
	sampleKind: number;
    /** TIFF compression type */
    compression: number;
    /** TIFF predictor value */
    predictor: number;
    /** TIFF photometric interpretation */
    photometricInterpretation: number;
    /** TIFF planar configuration */
    planarConfiguration: number;
    rowsPerStrip?: number;
    stripCount?: number;
    stripByteCountTotal?: number;
    stripByteCountMax?: number;
    tileWidth?: number;
    tileLength?: number;
    tileCount?: number;
    directDecode?: boolean;
    /** Pixel data in the narrowest carrier that preserves its semantics. */
    data: Float32Array | Uint16Array | Uint8Array;
    /** Minimum value */
    min: number;
    /** Maximum value */
    max: number;
    /** JSON array of every tag found in the file (TIFF/Exif/GPS), see tiff-tag-utils.js */
    allTagsJson: string;
	/** OME-XML from the first IFD, present even when another page was decoded. */
	omeXml?: string;
	/**
	 * GeoTIFF georeferencing as JSON — the unpacked key directory's CRS plus
	 * the raster-to-model transform. Absent for a TIFF that carries none,
	 * which is most of them.
	 */
	geoJson?: string;
	/**
	 * The file's IFD chain classified into pages, pyramid overviews and masks,
	 * as JSON — see tiff-pages.ts. Absent when the directory could not be read.
	 */
	pageDirectoryJson?: string;
}

/**
 * Fast TIFF Processor class using WASM
 */
export class TiffWasmProcessor {
    wasm: any;

    constructor() {
        this.wasm = null;
    }

    /**
     * Initialize the WASM module
     * @returns True if WASM loaded, false if falling back to JS
     */
    async init(): Promise<boolean> {
        this.wasm = await initWasm();
        return this.wasm !== null;
    }

    /**
     * Check if WASM is available
     */
    isAvailable(): boolean {
        return this.wasm !== null;
    }

    /**
     * Decode a TIFF file from an ArrayBuffer
     * @param buffer - TIFF file data
     */
    async decode(buffer: ArrayBuffer, pageIndex = 0): Promise<TiffDecodeResult> {
        if (!this.wasm) {
            throw new Error('WASM not initialized. Call init() first.');
        }
        try {
            return this._decodeWith(this.wasm, buffer, pageIndex);
        } catch (error) {
            // A codec the core module does not carry — JPEG 2000, JPEG XR,
            // LERC, LZMA, WebP. The heavy-codec module is the same adapter
            // built with those linked in, so the identical code finishes the
            // job. Any other failure propagates: retrying it would fetch a
            // couple of megabytes to fail the same way.
            const { externalCodecName, initCodecDecoder } = await import('./codec-wasm-wrapper.js');
            const codec = externalCodecName(error);
            if (!codec) { throw error; }
            if (codec === 'JPEG XL') {
                const { initJxlDecoder } = await import('./jxl-wasm-wrapper.js');
                return this._decodeWith(await initJxlDecoder(), buffer, pageIndex);
            }
            return this._decodeWith(await initCodecDecoder(), buffer, pageIndex);
        }
    }

    /**
     * `wasm` selects the module. Everything here is identical for the core and
     * the heavy-codec build — they are the same adapter — so the decode is
     * written once and pointed at whichever one can finish the file.
     */
    private _decodeWith(wasm: any, buffer: ArrayBuffer, pageIndex: number): TiffDecodeResult {
        const uint8Array = new Uint8Array(buffer);
        const generatedPreview = (pageIndex === 0 || pageIndex === 1) && wasm.tiff_preview_reduction?.(uint8Array) > 0;
        const pageCount = generatedPreview ? 2 : typeof wasm.tiff_page_count === 'function'
            ? wasm.tiff_page_count(uint8Array)
            : 1;
        if (pageIndex < 0 || pageIndex >= pageCount) {
            throw new Error(`TIFF page index ${pageIndex} is out of range (page count: ${pageCount})`);
        }
        if (generatedPreview) { pageIndex = 1; }
        const result = generatedPreview ? wasm.decode_tiff_preview(uint8Array) : pageIndex > 0 && typeof wasm.decode_tiff_page === 'function'
            ? wasm.decode_tiff_page(uint8Array, pageIndex)
            : wasm.decode_tiff(uint8Array);
		const sampleKind = Number(result.sample_kind ?? 0);
		let data: Float32Array | Uint16Array | Uint8Array;
		if ((sampleKind === 1 || sampleKind === 3) && typeof result.take_data_as_u8 === 'function') {
			const bytes = result.take_data_as_u8() as Uint8Array;
			data = sampleKind === 3
				? new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
				: bytes;
		} else {
			data = typeof result.take_data_as_f32 === 'function'
				? result.take_data_as_f32()
				: new Float32Array(result.get_data_as_f32());
		}

        const decodeResult: TiffDecodeResult = {
			pageIndex,
			pageCount,
            width: result.width,
            height: result.height,
            channels: result.channels,
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
            min: result.min_value,
            max: result.max_value,
            allTagsJson: result.all_tags_json,
			omeXml: result.ome_xml || undefined,
			geoJson: result.geo_json || undefined,
			pageDirectoryJson: result.page_directory_json || undefined
        };

        return decodeResult;
    }
}

/**
 * Walk a raw TIFF-structured Exif blob (e.g. a JPEG APP1 payload with its
 * "Exif\0\0" prefix already stripped, or a PNG eXIf chunk's raw bytes) and
 * return every tag found, in the same shape as TIFF's own tag dump. Lazily
 * loads/reuses the same WASM module as TiffWasmProcessor.
 */
export async function extractExifTagsFromBlob(blob: Uint8Array): Promise<TagEntry[]> {
    const wasm = await initWasm();
    if (!wasm || typeof wasm.extract_exif_tags !== 'function') { return []; }
    try {
        return parseAllTagsJson(wasm.extract_exif_tags(blob));
    } catch (error) {
        console.warn('[extractExifTagsFromBlob] Failed to parse embedded Exif blob:', error);
        return [];
    }
}

// Export for use
export { initWasm };
