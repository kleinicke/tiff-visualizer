"use strict";

import { decodeLayeredPreviewAsync, setBandCompositor, setFastPngRgbaDecoder } from './modules/layered-preview-decoders.js';
import { composite, type CompositeResult, type Layer } from './modules/layer-compositor.js';
import { canComposeInBands, finiteRangeOf, mergeBands, sliceLayersForBand } from './modules/layer-compositor-bands.js';
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

/**
 * XCF previews composite in row bands on nested workers running this same
 * bundle (layer-compositor-bands.ts: identical to one composite). Small
 * documents, offset groups and any worker failure stay on this thread.
 */
const MIN_BAND_PIXELS = 1_000_000;
const BAND_TIMEOUT_MS = 15_000;
let bandWorkers: Worker[] | null = null;
let nextBandId = 1;

function startBandWorkers(): Worker[] {
	if (!bandWorkers) {
		const count = Math.max(2, Math.min(8, (self.navigator?.hardwareConcurrency || 4) - 2));
		bandWorkers = Array.from({ length: count }, () => new Worker(self.location.href, { type: 'module' }));
	}
	return bandWorkers;
}

type Band = { result: CompositeResult; range: { min: number; max: number } };

function compositeBand(worker: Worker, layers: Layer[], width: number, rows: number): Promise<Band> {
	const id = nextBandId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error('band composite timed out')), BAND_TIMEOUT_MS);
		const finish = (error: Error | null, result?: Band) => {
			clearTimeout(timer);
			worker.removeEventListener('message', onMessage);
			worker.removeEventListener('error', onError);
			if (error) { reject(error); } else { resolve(result!); }
		};
		const onMessage = (event: MessageEvent) => {
			if (event.data?.bandId !== id) { return; }
			if (event.data.error) { finish(new Error(event.data.error)); } else { finish(null, event.data); }
		};
		const onError = (event: ErrorEvent) => finish(new Error(event.message || 'band worker failed'));
		worker.addEventListener('message', onMessage);
		worker.addEventListener('error', onError);
		worker.postMessage({ type: 'composite-band', bandId: id, layers, width, rows }, collectTransferables(layers));
	});
}

async function compositeInBands(stack: Layer[], width: number, height: number): Promise<CompositeResult | null> {
	if (width * height < MIN_BAND_PIXELS || !canComposeInBands(stack) || typeof Worker !== 'function') { return null; }
	try {
		const workers = startBandWorkers();
		const count = Math.min(workers.length, height);
		const bands = await Promise.all(workers.slice(0, count).map((worker, index) => {
			const y0 = Math.round(index * height / count), y1 = Math.round((index + 1) * height / count);
			return compositeBand(worker, sliceLayersForBand(stack, y0, y1), width, y1 - y0);
		}));
		return mergeBands(bands.map(band => band.result), width, height, bands.map(band => band.range));
	} catch (error) {
		console.warn('[LayeredDecodeWorker] Composite bands failed, compositing on one thread:', error);
		bandWorkers?.forEach(worker => worker.terminate());
		bandWorkers = null;
		return null;
	}
}

setBandCompositor(compositeInBands);

self.onmessage = async (event: MessageEvent<any>) => {
	const msg = event.data;
	if (msg.type === 'composite-band') {
		// This bundle running as one of the band workers above.
		try {
			const result = composite(msg.layers, msg.width, msg.rows);
			self.postMessage({ bandId: msg.bandId, result, range: finiteRangeOf(result) }, [result.data.buffer]);
		} catch (error) {
			self.postMessage({ bandId: msg.bandId, error: String((error as Error)?.message || error) });
		}
		return;
	}
	if (msg.type === 'init') {
		if (msg.tiffWasmModule instanceof WebAssembly.Module) { rustPng = useRustPng(msg.tiffWasmModule); }
		if (msg.prewarmBands && typeof Worker === 'function') {
			try { startBandWorkers(); } catch { /* composited on this thread */ }
		}
		self.postMessage({ type: 'ready', caps: { layered: true } });
		return;
	}
	const { id, format, buffer, options } = msg;
	// Band workers boot while the XCF's layers decode.
	if (format === 'xcf' && typeof Worker === 'function') {
		try { startBandWorkers(); } catch { /* composited on this thread */ }
	}
	try {
		await rustPng;
		const result: any = await decodeLayeredPreviewAsync(format, buffer, options || {});
		// `returnSource` hands the untouched input back for a later decode of the
		// same document, so the caller need not read the file again.
		if (options?.returnSource) { result.sourceBuffer = buffer; }
		self.postMessage({ id, ok: true, result }, collectTransferables(result));
	} catch (error) {
		self.postMessage({ id, ok: false, error: String((error as Error)?.message || error), buffer }, [buffer]);
	}
};
