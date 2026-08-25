"use strict";

/**
 * PNG-only decode worker.
 *
 * Keeping this separate from decode-worker.ts means a 16-bit PNG does not
 * download or parse GeoTIFF, EXR, layered-document, or scientific-container
 * compatibility code. The Rust module remains shared because it owns the
 * authoritative precise PNG decoder. Compatibility fallback is deliberately
 * returned to the webview, which loads UPNG only if Rust rejects the file.
 */
import initTiffWasm, { decode_png16_fast } from './wasm/tiff-wasm.js';

let wasmReady = false;

function decodeWithRust(buffer: ArrayBuffer) {
	if (!wasmReady) throw new Error('PNG WASM decoder not initialized');
	const started = performance.now();
	const result = decode_png16_fast(new Uint8Array(buffer));
	const decodedData = result.take_data_as_u16();
	return {
		width: result.width,
		height: result.height,
		depth: result.bit_depth,
		ctype: result.color_type,
		decodedData,
		decodedWith: 'rust-png-wasm (png worker)',
		decodeTimings: [{ name: 'decode-png16-rust', durationMs: performance.now() - started }],
	};
}

(self as any).onmessage = async (event: MessageEvent<any>) => {
	const msg = event.data;
	if (msg.type === 'init') {
		try {
			await initTiffWasm({ module_or_path: msg.tiffWasmModule || msg.tiffWasmBuffer });
			wasmReady = true;
		} catch (error) {
			console.warn('[PngDecodeWorker] WASM unavailable; the webview will load its fallback on demand:', error);
		}
		(self as any).postMessage({ type: 'ready', caps: { png16: true } });
		return;
	}

	const { id, format, buffer } = msg;
	if (format !== 'png16') {
		(self as any).postMessage({ id, ok: false, error: `Unsupported PNG worker format: ${format}`, buffer }, [buffer]);
		return;
	}
	try {
		const result: any = decodeWithRust(buffer);
		const transferables: ArrayBuffer[] = [];
		if (result.decodedData?.buffer instanceof ArrayBuffer) transferables.push(result.decodedData.buffer);
		else if (result.data instanceof ArrayBuffer) transferables.push(result.data);
		(self as any).postMessage({ id, ok: true, result }, transferables);
	} catch (error) {
		(self as any).postMessage({ id, ok: false, error: String((error as Error)?.message || error), buffer }, [buffer]);
	}
};
