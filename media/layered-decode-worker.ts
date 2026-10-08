"use strict";

import { decodeLayeredPreview, setFastPngRgbaDecoder } from './modules/layered-preview-decoders.js';
import initTiffWasm, { decode_png_rgba8 } from './wasm/tiff-wasm.js';

declare const self: any;

function collectTransferables(value: any, buffers: Set<ArrayBuffer> = new Set(), depth = 0): ArrayBuffer[] {
	if (value === null || value === undefined || depth > 5) { return [...buffers]; }
	if (value instanceof ArrayBuffer) { buffers.add(value); }
	else if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) { buffers.add(value.buffer); }
	else if (Array.isArray(value)) {
		for (const item of value) { collectTransferables(item, buffers, depth + 1); }
	} else if (typeof value === 'object' && value.constructor === Object) {
		for (const item of Object.values(value)) { collectTransferables(item, buffers, depth + 1); }
	}
	return [...buffers];
}

/** Embedded PNGs decode in Rust once the page hands over the core module. */
let rustPng: Promise<void> = Promise.resolve();

function useRustPng(module: WebAssembly.Module): Promise<void> {
	return initTiffWasm({ module_or_path: module }).then(() => {
		setFastPngRgbaDecoder(bytes => {
			let decoded;
			try { decoded = decode_png_rgba8(bytes); } catch { return null; }
			const result = { width: decoded.width, height: decoded.height, data: decoded.take_data() };
			decoded.free();
			return result;
		});
	}, error => console.warn('[LayeredDecodeWorker] PNG decoding stays in JavaScript:', error));
}

self.onmessage = async (event: MessageEvent<any>) => {
	const msg = event.data;
	if (msg.type === 'init') {
		if (msg.tiffWasmModule instanceof WebAssembly.Module) { rustPng = useRustPng(msg.tiffWasmModule); }
		self.postMessage({ type: 'ready', caps: { layered: true } });
		return;
	}
	const { id, format, buffer, options } = msg;
	try {
		await rustPng;
		const result: any = await decodeLayeredPreview(format, buffer, options || {});
		// `returnSource` hands the untouched input back for a later decode of the
		// same document, so the caller need not read the file again.
		if (options?.returnSource) { result.sourceBuffer = buffer; }
		self.postMessage({ id, ok: true, result }, collectTransferables(result));
	} catch (error) {
		self.postMessage({ id, ok: false, error: String((error as Error)?.message || error), buffer }, [buffer]);
	}
};
