"use strict";

/**
 * PNG-only decode worker.
 *
 * Keeping this separate from decode-worker.ts means a 16-bit PNG does not
 * download or parse GeoTIFF, EXR, layered-document, or scientific-container
 * compatibility code. The Rust module remains shared because it owns the
 * authoritative precise PNG decoder; UPNG is only its compatibility fallback.
 */
import UPNG from './upng.min.js';
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

function decodeWithUpng(buffer: ArrayBuffer, wasmError: string) {
	const started = performance.now();
	const png: any = UPNG.decode(buffer);
	const timings = [{ name: 'decode-png16-upng', durationMs: performance.now() - started }];
	if (png.depth === 16 && png.data) {
		const uint8Data = new Uint8Array(png.data);
		const uint16Data = new Uint16Array(uint8Data.length / 2);
		for (let i = 0, src = 0; i < uint16Data.length; i++, src += 2) {
			uint16Data[i] = (uint8Data[src] << 8) | uint8Data[src + 1];
		}
		png.decodedData = uint16Data;
		png.data = null;
	}
	png.decodeTimings = timings;
	png.decodedWith = 'upng-js (png worker)';
	png.wasmFallbackReason = wasmError;
	return png;
}

(self as any).onmessage = async (event: MessageEvent<any>) => {
	const msg = event.data;
	if (msg.type === 'init') {
		try {
			await initTiffWasm({ module_or_path: msg.tiffWasmModule || msg.tiffWasmBuffer });
			wasmReady = true;
		} catch (error) {
			console.warn('[PngDecodeWorker] WASM unavailable; UPNG fallback remains active:', error);
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
		let result: any;
		try {
			result = decodeWithRust(buffer);
		} catch (error) {
			result = decodeWithUpng(buffer, String((error as Error)?.message || error));
		}
		const transferables: ArrayBuffer[] = [];
		if (result.decodedData?.buffer instanceof ArrayBuffer) transferables.push(result.decodedData.buffer);
		else if (result.data instanceof ArrayBuffer) transferables.push(result.data);
		(self as any).postMessage({ id, ok: true, result }, transferables);
	} catch (error) {
		(self as any).postMessage({ id, ok: false, error: String((error as Error)?.message || error), buffer }, [buffer]);
	}
};
