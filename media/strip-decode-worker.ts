"use strict";
/**
 * One member of the TIFF strip-decode pool.
 *
 * Each instance owns its own WASM module, decodes a contiguous run of strips
 * from only that run's compressed bytes, and transfers the samples back. There
 * is no shared memory and no coordination between workers: strips in a TIFF are
 * independently compressed, so a range is a complete unit of work.
 *
 * The WASM arrives as a precompiled `WebAssembly.Module` from the orchestrator
 * (compiled once, instantiated N times) because this runs from a blob URL and
 * cannot fetch webview-resource URLs itself.
 */
import initTiffWasm, { decode_tiff_float_strip_range } from './wasm/tiff-wasm.js';

let ready: Promise<unknown> | null = null;

self.onmessage = async (event: MessageEvent) => {
	const message = event.data as any;

	if (message?.type === 'init') {
		try {
			ready = initTiffWasm({ module_or_path: message.tiffWasmModule || message.tiffWasmBuffer });
			await ready;
			(self as any).postMessage({ type: 'ready' });
		} catch (error) {
			(self as any).postMessage({ type: 'ready', error: String((error as Error)?.message || error) });
		}
		return;
	}

	const job = message;
	try {
		await ready;
		const started = performance.now();
		const samples = decode_tiff_float_strip_range(
			new Uint8Array(job.blob),
			new Uint32Array(job.counts),
			job.firstStrip,
			job.width,
			job.height,
			job.channels,
			job.bitsPerSample,
			job.compression,
			job.rowsPerStrip,
			job.predictor,
			job.sampleFormat,
			job.littleEndian,
		);
		// Min/max over this range only; the orchestrator combines them. Doing it
		// here keeps the stats pass parallel and off the main thread.
		let min = Infinity;
		let max = -Infinity;
		let sawNonFinite = false;
		for (let i = 0; i < samples.length; i++) {
			const value = samples[i];
			if (value < min) { min = value; }
			if (value > max) { max = value; }
			if (value !== value) { sawNonFinite = true; }
		}
		if (sawNonFinite || !Number.isFinite(min) || !Number.isFinite(max)) {
			// The fast loop is poisoned by NaN/Infinity; redo it finite-aware.
			// Rare enough not to be worth paying for on every range.
			min = Infinity;
			max = -Infinity;
			for (let i = 0; i < samples.length; i++) {
				const value = samples[i];
				if (Number.isFinite(value)) {
					if (value < min) { min = value; }
					if (value > max) { max = value; }
				}
			}
		}
		(self as any).postMessage(
			{ id: job.id, samples, min, max, ms: performance.now() - started },
			[samples.buffer],
		);
	} catch (error) {
		(self as any).postMessage({ id: job.id, error: String((error as Error)?.message || error) });
	}
};
