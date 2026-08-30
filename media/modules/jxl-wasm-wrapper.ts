"use strict";

// Imported STATICALLY for the same reason as `tiff-wasm-wrapper.ts`: esbuild
// then inlines the wasm-pack glue into the bundle, where its relative payload
// URL resolves correctly. A dynamic `import()` with a non-literal specifier is
// left to the runtime, which resolves it against `media/wasm/` and 404s.
//
// Importing the glue does NOT instantiate WebAssembly — `initJxlWasm()` does,
// and that is what fetches the ~1.3 MB payload. So the module stays unfetched
// until someone actually opens a `.jxl`, which is the whole reason JPEG XL is
// built as its own module rather than linked into `tiff-wasm.wasm`.
import initJxlWasm, { decode_jxl_fast } from '../wasm/jxl-wasm.js';

let wasmModule: { decode_jxl_fast: any } | null = null;
let wasmInitPromise: Promise<{ decode_jxl_fast: any }> | null = null;

/** Candidate payload URLs, in the order the tiff wrapper uses them. */
export function jxlWasmUrls(): string[] {
    const configured = (globalThis as any).__tiffVisualizerVendorAssets?.jxlWasm;
    return [
        configured,
        new URL('./wasm/jxl-wasm.wasm', import.meta.url).href,
        new URL('../wasm/jxl-wasm.wasm', import.meta.url).href,
    ].filter(Boolean) as string[];
}

/**
 * Instantiate the JPEG XL module, once per page. Concurrent callers share the
 * one in-flight promise; a failure clears it so a later open can retry rather
 * than being stuck with a rejected promise forever.
 */
export async function initJxlDecoder(): Promise<{ decode_jxl_fast: any }> {
    if (wasmModule) { return wasmModule; }
    if (wasmInitPromise) { return wasmInitPromise; }

    wasmInitPromise = (async () => {
        let lastError: unknown = null;
        for (const url of jxlWasmUrls()) {
            try {
                const response = await fetch(url);
                if (!response.ok) { throw new Error(`HTTP ${response.status}`); }
                await initJxlWasm({ module_or_path: await response.arrayBuffer() });
                wasmModule = { decode_jxl_fast };
                return wasmModule;
            } catch (error) {
                lastError = error;
            }
        }
        const details = lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(`Unable to initialize the JPEG XL decoder WASM (${details})`);
    })();
    try {
        return await wasmInitPromise;
    } catch (error) {
        wasmInitPromise = null;
        throw error;
    }
}
