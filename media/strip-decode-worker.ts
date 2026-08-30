"use strict";
/**
 * One member of the shared TIFF-strip / EXR-ZIP decode pool.
 *
 * Each instance owns its own WASM module, decodes a contiguous run of units —
 * strips, or whole tile rows — from only that run's compressed bytes, and
 * transfers the samples back. There is no shared memory and no coordination
 * between workers: blocks in a TIFF are independently compressed, so a range is
 * a complete unit of work.
 *
 * The WASM arrives as a precompiled `WebAssembly.Module` from the orchestrator
 * (compiled once, instantiated N times) because this runs from a blob URL and
 * cannot fetch webview-resource URLs itself.
 */
import initTiffWasm, { decode_exr_zip_f32_blocks, decode_tiff_float_strip_range, decode_tiff_strip_range_raw } from './wasm/tiff-wasm.js';

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
		if (job.kind === 'orient') {
			const source = new Uint8Array(job.data);
			const width = Number(job.width);
			const height = Number(job.height);
			const bytesPerPixel = Number(job.bytesPerPixel);
			const orientation = Number(job.orientation);
			const transposes = orientation >= 5 && orientation <= 8;
			const outputWidth = transposes ? height : width;
			const outputHeight = transposes ? width : height;
			const output = new Uint8Array(source.byteLength);
			for (let y = 0; y < outputHeight; y++) {
				for (let x = 0; x < outputWidth; x++) {
					let sx: number, sy: number;
					switch (orientation) {
						case 2: sx = width - 1 - x; sy = y; break;
						case 3: sx = width - 1 - x; sy = height - 1 - y; break;
						case 4: sx = x; sy = height - 1 - y; break;
						case 5: sx = y; sy = x; break;
						case 6: sx = y; sy = height - 1 - x; break;
						case 7: sx = width - 1 - y; sy = height - 1 - x; break;
						case 8: sx = width - 1 - y; sy = x; break;
						default: sx = x; sy = y;
					}
					const from = (sy * width + sx) * bytesPerPixel;
					const to = (y * outputWidth + x) * bytesPerPixel;
					if (bytesPerPixel === 1) {
						output[to] = source[from];
					} else if (bytesPerPixel === 3) {
						output[to] = source[from];
						output[to + 1] = source[from + 1];
						output[to + 2] = source[from + 2];
					} else if (bytesPerPixel === 4) {
						output[to] = source[from];
						output[to + 1] = source[from + 1];
						output[to + 2] = source[from + 2];
						output[to + 3] = source[from + 3];
					} else {
						for (let byte = 0; byte < bytesPerPixel; byte++) {
							output[to + byte] = source[from + byte];
						}
					}
				}
			}
			(self as any).postMessage(
				{ id: job.id, data: output.buffer, width: outputWidth, height: outputHeight, ms: performance.now() - started },
				[output.buffer],
			);
			return;
		}
		if (job.kind === 'exr-zip') {
			const bytes = decode_exr_zip_f32_blocks(
				new Uint8Array(job.blob),
				new Uint32Array(job.counts),
				new Uint32Array(job.rows),
				job.width,
			);
			const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
			let min = Infinity;
			let max = -Infinity;
			let sawNonFinite = false;
			for (let index = 0; index < samples.length; index++) {
				const value = samples[index];
				if (value < min) { min = value; }
				if (value > max) { max = value; }
				if (!Number.isFinite(value)) { sawNonFinite = true; }
			}
			if (sawNonFinite || !Number.isFinite(min) || !Number.isFinite(max)) {
				min = Infinity; max = -Infinity;
				for (let index = 0; index < samples.length; index++) {
					const value = samples[index];
					if (Number.isFinite(value)) {
						if (value < min) { min = value; }
						if (value > max) { max = value; }
					}
				}
			}
			(self as any).postMessage(
				{ id: job.id, samples, min, max, ms: performance.now() - started },
				[bytes.buffer],
			);
			return;
		}
		// `raw` asks for native little-endian sample bytes, which the caller
		// wraps in the carrier its pipeline wants (Uint8/Uint16/Float32) with no
		// conversion. Half floats and >16-bit integers still need widening, so
		// those keep the f32 path.
		if (job.raw) {
			const bytes = decode_tiff_strip_range_raw(
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
				job.planarConfiguration || 1,
				job.orientation || 1,
				job.tileWidth || 0,
				job.tileLength || 0,
				job.blocksAcross || 1,
				job.lercAdditionalCompression || 0,
			);
			const view = job.bitsPerSample === 8
				? bytes
				: job.sampleFormat === 3
					? new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
					: new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
			let rmin = Infinity;
			let rmax = -Infinity;
			let nonFinite = false;
			for (let i = 0; i < view.length; i++) {
				const value = view[i];
				if (value < rmin) { rmin = value; }
				if (value > rmax) { rmax = value; }
				if (value !== value) { nonFinite = true; }
			}
			if (nonFinite || !Number.isFinite(rmin) || !Number.isFinite(rmax)) {
				rmin = Infinity; rmax = -Infinity;
				for (let i = 0; i < view.length; i++) {
					const value = view[i];
					if (Number.isFinite(value)) {
						if (value < rmin) { rmin = value; }
						if (value > rmax) { rmax = value; }
					}
				}
			}
			(self as any).postMessage(
				{ id: job.id, samples: view, min: rmin, max: rmax, ms: performance.now() - started },
				[bytes.buffer],
			);
			return;
		}
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
			job.planarConfiguration || 1,
			job.orientation || 1,
			job.tileWidth || 0,
			job.tileLength || 0,
			job.blocksAcross || 1,
			job.lercAdditionalCompression || 0,
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
