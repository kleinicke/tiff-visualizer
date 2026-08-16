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
    decode_dicom_fast, label_components_fast, fill_mask_holes_fast, distance_transform_fast, gaussian_blur_fast, subtract_background_fast, decode_fits_fast, decode_netcdf_fast, decode_npy_display_fast,
    decode_pfm_display_fast, decode_ppm_display_fast, decode_tiff, decode_tiff_page,
    demosaic, extract_exif_tags, tiff_page_count,
    compute_image_stats_f32, compute_image_stats_u8, compute_image_stats_u16,
    build_histogram_fast, auto_threshold_bin_fast, global_threshold_mask_fast,
    local_threshold_mask_fast, local_auto_threshold_mask_fast, compute_stability_curve_fast,
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
            await initTiffWasm();
            // The six decode_*_fast entries back the main-thread decode path
            // in `main-thread-decode.ts`, taken when the decode worker is
            // unavailable. They share this one cached module instance rather
            // than initializing a second copy.
            wasmModule = {
                decode_tiff, decode_tiff_page, tiff_page_count, extract_exif_tags, demosaic,
                decode_pfm_display_fast, decode_ppm_display_fast, decode_npy_display_fast, decode_fits_fast,
                decode_netcdf_fast, decode_dicom_fast,
                compute_image_stats_f32, compute_image_stats_u8, compute_image_stats_u16,
                label_components_fast, fill_mask_holes_fast, distance_transform_fast, gaussian_blur_fast, subtract_background_fast,
                build_histogram_fast, auto_threshold_bin_fast, global_threshold_mask_fast,
                local_threshold_mask_fast, local_auto_threshold_mask_fast, compute_stability_curve_fast,
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
    /** Pixel data as floats */
    data: Float32Array;
    /** Minimum value */
    min: number;
    /** Maximum value */
    max: number;
    /** JSON array of every tag found in the file (TIFF/Exif/GPS), see tiff-tag-utils.js */
    allTagsJson: string;
	/** OME-XML from the first IFD, present even when another page was decoded. */
	omeXml?: string;
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

        const uint8Array = new Uint8Array(buffer);
        const pageCount = typeof this.wasm.tiff_page_count === 'function'
            ? this.wasm.tiff_page_count(uint8Array)
            : 1;
        if (pageIndex < 0 || pageIndex >= pageCount) {
            throw new Error(`TIFF page index ${pageIndex} is out of range (page count: ${pageCount})`);
        }
        const result = pageIndex > 0 && typeof this.wasm.decode_tiff_page === 'function'
            ? this.wasm.decode_tiff_page(uint8Array, pageIndex)
            : this.wasm.decode_tiff(uint8Array);

        const decodeResult: TiffDecodeResult = {
			pageIndex,
			pageCount,
            width: result.width,
            height: result.height,
            channels: result.channels,
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
            data: new Float32Array(result.get_data_as_f32()),
            min: result.min_value,
            max: result.max_value,
            allTagsJson: result.all_tags_json,
			omeXml: result.ome_xml || undefined
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
