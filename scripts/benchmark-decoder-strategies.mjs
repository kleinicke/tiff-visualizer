#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { makeNpyF32, makePpm16 } from './lib/decoder-performance-samples.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const size = Number(process.env.PERF_SIZE || 5120);
const iterations = Math.max(1, Number(process.env.PERF_ITERATIONS || 5));

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

function measure(name, source, run) {
	const times = [];
	let checksum = 0;
	for (let iteration = 0; iteration < iterations; iteration++) {
		const input = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
		const started = performance.now();
		const result = run(input);
		times.push(performance.now() - started);
		checksum += Number(result[0]) + Number(result[result.length - 1]);
	}
	return { strategy: name, medianMs: median(times).toFixed(1), checksum: checksum.toFixed(3) };
}

function ppmRasterOffset(bytes) {
	let tokens = 0;
	let inToken = false;
	let comment = false;
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i];
		if (comment) { if (byte === 10 || byte === 13) comment = false; continue; }
		if (byte === 35 && !inToken) { comment = true; continue; }
		const whitespace = byte === 32 || byte === 9 || byte === 10 || byte === 13;
		if (!whitespace && !inToken) { inToken = true; tokens++; }
		if (whitespace && inToken) {
			inToken = false;
			if (tokens === 4) return i + 1;
		}
	}
	throw new Error('Invalid NetPBM header');
}

function ppmSliceScalar(buffer) {
	const bytes = new Uint8Array(buffer);
	const offset = ppmRasterOffset(bytes);
	const raster = buffer.slice(offset);
	const values = new Uint16Array(raster);
	for (let i = 0; i < values.length; i++) {
		const value = values[i];
		values[i] = ((value & 0xff) << 8) | (value >>> 8);
	}
	return values;
}

function ppmCompactScalar(buffer) {
	const bytes = new Uint8Array(buffer);
	const offset = ppmRasterOffset(bytes);
	const length = bytes.length - offset;
	bytes.copyWithin(0, offset);
	const values = new Uint16Array(buffer, 0, length / 2);
	for (let i = 0; i < values.length; i++) {
		const value = values[i];
		values[i] = ((value & 0xff) << 8) | (value >>> 8);
	}
	return values;
}

function ppmCompactU32(buffer) {
	const bytes = new Uint8Array(buffer);
	const offset = ppmRasterOffset(bytes);
	const length = bytes.length - offset;
	bytes.copyWithin(0, offset);
	const pairs = new Uint32Array(buffer, 0, Math.floor(length / 4));
	for (let i = 0; i < pairs.length; i++) {
		const value = pairs[i];
		pairs[i] = ((value & 0x00ff00ff) << 8) | ((value & 0xff00ff00) >>> 8);
	}
	if ((length & 2) !== 0) {
		const values = new Uint16Array(buffer, 0, length / 2);
		const i = values.length - 1;
		const value = values[i];
		values[i] = ((value & 0xff) << 8) | (value >>> 8);
	}
	return new Uint16Array(buffer, 0, length / 2);
}

function npyView(buffer) {
	const view = new DataView(buffer);
	const major = view.getUint8(6);
	const headerLength = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
	const offset = (major === 1 ? 10 : 12) + headerLength;
	return new Float32Array(buffer, offset);
}

function statsScalar(data) {
	let min = Infinity, max = -Infinity;
	for (let i = 0; i < data.length; i++) {
		const value = data[i];
		if (Number.isFinite(value)) { if (value < min) min = value; if (value > max) max = value; }
	}
	return new Float64Array([min, max]);
}

function statsUnrolled8(data) {
	let min = Infinity, max = -Infinity;
	let i = 0;
	const stop = data.length - (data.length % 8);
	for (; i < stop; i += 8) {
		const a = data[i], b = data[i + 1], c = data[i + 2], d = data[i + 3];
		const e = data[i + 4], f = data[i + 5], g = data[i + 6], h = data[i + 7];
		if (Number.isFinite(a)) { min = Math.min(min, a); max = Math.max(max, a); }
		if (Number.isFinite(b)) { min = Math.min(min, b); max = Math.max(max, b); }
		if (Number.isFinite(c)) { min = Math.min(min, c); max = Math.max(max, c); }
		if (Number.isFinite(d)) { min = Math.min(min, d); max = Math.max(max, d); }
		if (Number.isFinite(e)) { min = Math.min(min, e); max = Math.max(max, e); }
		if (Number.isFinite(f)) { min = Math.min(min, f); max = Math.max(max, f); }
		if (Number.isFinite(g)) { min = Math.min(min, g); max = Math.max(max, g); }
		if (Number.isFinite(h)) { min = Math.min(min, h); max = Math.max(max, h); }
	}
	for (; i < data.length; i++) {
		const value = data[i];
		if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); }
	}
	return new Float64Array([min, max]);
}

const wasmJs = path.join(root, 'media/wasm/tiff-wasm.js');
const wasm = await import(`${pathToFileURL(wasmJs).href}?strategy=${Date.now()}`);
await wasm.default({ module_or_path: fs.readFileSync(path.join(root, 'media/wasm/tiff-wasm.wasm')) });

const ppm = makePpm16(size, size, 3);
const npy = makeNpyF32(size, size);
const ppmRows = [
	measure('JS slice + scalar u16 swap', ppm, ppmSliceScalar),
	measure('JS compact + scalar u16 swap', ppm, ppmCompactScalar),
	measure('JS compact + paired u32 swap', ppm, ppmCompactU32),
	measure('Rust/WASM display decode', ppm, buffer => {
		const result = wasm.decode_ppm_display_fast(new Uint8Array(buffer));
		const length = result.data_len;
		const bytes = new Uint8Array(buffer, 0, length * 2);
		result.copy_data_as_u8_into(bytes);
		return new Uint16Array(buffer, 0, length);
	}),
];

const npyRows = [
	measure('JS zero-copy header only', npy, npyView),
	measure('JS zero-copy + scalar stats', npy, buffer => statsScalar(npyView(buffer))),
	measure('JS zero-copy + unrolled stats', npy, buffer => statsUnrolled8(npyView(buffer))),
	measure('Rust/WASM zero-copy + stats', npy, buffer => {
		const result = wasm.decode_npy_display_fast(new Uint8Array(buffer));
		const output = new Float64Array([result.data_min, result.data_max]);
		result.discard_data();
		return output;
	}),
];

console.log(`Strategy matrix: ${size}x${size}, median of ${iterations}`);
console.log('PPM RGB16');
console.table(ppmRows);
console.log('NPY float32');
console.table(npyRows);
