"use strict";

/**
 * The heavy-codec WebAssembly module, fetched only when a file needs it.
 *
 * `wasm/tiff-decoder` is built twice from one source: the core module every
 * image open downloads, and this one, which adds JPEG 2000, JPEG XR, LERC,
 * LZMA, WebP and the DICOM JPEG-LS/lossless codecs. It is a strict SUPERSET of
 * the core — same adapter, same container parsers, more codecs — so a file the
 * core cannot finish is re-decoded here through the very same code rather than
 * through a second implementation that could drift.
 *
 * Nothing fetches it speculatively. The core reports a codec it does not carry
 * with an `[external-codec:NAME]` error, raised while reading the file's own
 * header and long before any pixel work, and that error is the only thing that
 * triggers the download. A plain LZW or Deflate TIFF never sees it.
 *
 * Imported STATICALLY for the same reason as `tiff-wasm-wrapper.ts`: esbuild
 * inlines the wasm-pack glue, whose relative payload URL only resolves when
 * bundled. Importing the glue costs a few KB and instantiates nothing; `init`
 * is what fetches the payload.
 */
import initCodecWasm, {
    decode_czi_fast, decode_dicom_fast, decode_jpegxr_fast, decode_tiff,
    decode_tiff_fast, decode_tiff_page, decode_tiff_page_fast, tiff_page_count,
} from '../wasm/codec-wasm.js';

/**
 * The marker `decompress_block` and the DICOM codec dispatch use for a codec
 * that is not in this build. Changing it means changing
 * `external_codec_needed` in `crates/image-decoders/src/formats/tiff/strips.rs`
 * to match — the two are one protocol.
 */
const EXTERNAL_CODEC_PATTERN = /\[external-codec:([^\]]+)\]/;

/** The exports the fallback dispatch needs, all present in both builds. */
export interface CodecModule {
    decode_tiff: any;
    decode_tiff_fast: any;
    decode_tiff_page: any;
    decode_tiff_page_fast: any;
    tiff_page_count: any;
    decode_dicom_fast: any;
    decode_czi_fast: any;
    decode_jpegxr_fast: any;
}

/**
 * The codec named by an `[external-codec:…]` error, or null for any other
 * failure. A caller that gets null must NOT fetch the codec module: the decode
 * failed for some other reason and retrying would only download megabytes to
 * fail again.
 */
export function externalCodecName(error: unknown): string | null {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return EXTERNAL_CODEC_PATTERN.exec(message)?.[1] ?? null;
}

let codecModule: CodecModule | null = null;
let codecInitPromise: Promise<CodecModule> | null = null;

/** Candidate payload URLs, in the order the other wrappers use them. */
export function codecWasmUrls(): string[] {
    return [
        (globalThis as any).__tiffVisualizerVendorAssets?.codecWasm,
        new URL('./wasm/codec-wasm.wasm', import.meta.url).href,
        new URL('../wasm/codec-wasm.wasm', import.meta.url).href,
    ].filter((url): url is string => typeof url === 'string' && url.length > 0);
}

/**
 * Instantiate the codec module, once per page. Concurrent callers share the
 * one in-flight promise; a failure clears it so a later open retries rather
 * than being stuck with a rejected promise for the life of the page.
 */
export async function initCodecDecoder(): Promise<CodecModule> {
    if (codecModule) { return codecModule; }
    if (codecInitPromise) { return codecInitPromise; }

    codecInitPromise = (async () => {
        let lastError: unknown = null;
        for (const url of codecWasmUrls()) {
            try {
                const response = await fetch(url);
                if (!response.ok) { throw new Error(`HTTP ${response.status}`); }
                await initCodecWasm({ module_or_path: await response.arrayBuffer() });
                codecModule = {
                    decode_tiff, decode_tiff_fast, decode_tiff_page, decode_tiff_page_fast,
                    tiff_page_count, decode_dicom_fast, decode_czi_fast, decode_jpegxr_fast,
                };
                return codecModule;
            } catch (error) {
                lastError = error;
            }
        }
        const details = lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(`Unable to load the extended codec decoder (${details})`);
    })();
    try {
        return await codecInitPromise;
    } catch (error) {
        codecInitPromise = null;
        throw error;
    }
}

/** Adopt a module the main thread already compiled (see `setCodecModule`). */
export async function initCodecDecoderFrom(compiled: WebAssembly.Module): Promise<CodecModule> {
    if (codecModule) { return codecModule; }
    if (!codecInitPromise) {
        codecInitPromise = (async () => {
            await initCodecWasm({ module_or_path: compiled });
            codecModule = {
                decode_tiff, decode_tiff_fast, decode_tiff_page, decode_tiff_page_fast,
                tiff_page_count, decode_dicom_fast, decode_czi_fast, decode_jpegxr_fast,
            };
            return codecModule;
        })().catch((error: unknown): never => {
            codecInitPromise = null;
            throw error;
        });
    }
    return codecInitPromise;
}
