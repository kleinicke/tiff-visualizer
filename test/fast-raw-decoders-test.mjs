#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listCases, bufferToArrayBuffer } = require('./lib/decoder-cases');
const { expectsRejection } = require('./lib/golden-io');
const moduleUrl = pathToFileURL(path.resolve('out/media/modules/fast-raw-decoders.js')).href;
const { decodeBinaryNetpbmFast, decodeNativeF32NpyFast, decodeNativePfmFast } = await import(moduleUrl);

let supported = 0;
let fallback = 0;

for (const testCase of listCases()) {
	if (testCase.format !== 'ppm' && testCase.format !== 'npy' && testCase.format !== 'pfm') continue;
	if (testCase.format === 'pfm' && testCase.options?.topDown === false) { fallback++; continue; }
	const input = bufferToArrayBuffer(testCase.bytes);
	let decoded;
	try {
		decoded = testCase.format === 'ppm'
			? decodeBinaryNetpbmFast(input)
			: testCase.format === 'npy' ? decodeNativeF32NpyFast(input) : decodeNativePfmFast(input);
	} catch (error) {
		// Malformed inputs may be rejected by the fast path or returned to Rust;
		// either outcome preserves the normal decoder's authoritative error path.
		if (expectsRejection(testCase)) { fallback++; continue; }
		throw error;
	}
	if (!decoded) { fallback++; continue; }
	assert.equal(decoded.width, testCase.expectedMeta?.width ?? decoded.width, `${testCase.id}: width`);
	assert.equal(decoded.height, testCase.expectedMeta?.height ?? decoded.height, `${testCase.id}: height`);
	assert.equal(decoded.channels, testCase.expectedMeta?.channels ?? decoded.channels, `${testCase.id}: channels`);
	if (testCase.expectedMeta?.dataLength !== undefined) assert.equal(decoded.data.length, testCase.expectedMeta.dataLength, `${testCase.id}: length`);
	if (testCase.expectedData) {
		for (let i = 0; i < testCase.expectedData.length; i++) {
			assert.ok(Object.is(decoded.data[i], testCase.expectedData[i]), `${testCase.id}: sample ${i}`);
		}
	}
	if (testCase.format === 'npy') {
		assert.deepEqual(decoded.numericDomain, {
			bitsPerSample: 32, sampleFormat: 3, typeMin: 0, typeMax: 1, sourceNumericType: 'float32',
		}, `${testCase.id}: numeric domain`);
		let min = Infinity, max = -Infinity;
		const scanChannels = decoded.channels >= 3 ? 3 : 1;
		for (let pixel = 0; pixel < decoded.width * decoded.height; pixel++) {
			for (let channel = 0; channel < scanChannels; channel++) {
				const value = decoded.data[pixel * decoded.channels + channel];
				if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); }
			}
		}
		assert.deepEqual(decoded.stats, { min, max }, `${testCase.id}: stats`);
	} else if (testCase.format === 'ppm') {
		const bits = decoded.data instanceof Uint16Array ? 16 : 8;
		assert.equal(decoded.numericDomain.bitsPerSample, bits, `${testCase.id}: bits per sample`);
		assert.equal(decoded.numericDomain.sourceNumericType, bits === 16 ? 'uint16' : 'uint8', `${testCase.id}: numeric type`);
	} else {
		assert.deepEqual(decoded.numericDomain, {
			bitsPerSample: 32, sampleFormat: 3, typeMin: 0, typeMax: 1, sourceNumericType: 'float32',
		}, `${testCase.id}: numeric domain`);
	}
	supported++;
}

assert.ok(supported >= 5, `Expected several fast-path fixtures, got ${supported}`);
assert.ok(fallback >= 5, `Expected unsupported variants to retain Rust fallback, got ${fallback}`);

const lazyStatsCase = listCases().find(testCase => testCase.id === 'npy-dtype-le-f4');
assert.ok(lazyStatsCase, 'Expected native float32 NPY fixture');
const lazyStatsDecoded = decodeNativeF32NpyFast(bufferToArrayBuffer(lazyStatsCase.bytes), false);
assert.equal(lazyStatsDecoded?.stats, undefined, 'NPY hot path skips an unneeded full-raster stats pass');
assert.equal(
	lazyStatsDecoded?.data.length,
	lazyStatsDecoded.width * lazyStatsDecoded.height * lazyStatsDecoded.channels,
	'lazy-stats data remains intact',
);
// The NPY fast path's statistics scan must equal the straightforward one it
// replaced (finite-only min/max, finite/non-finite counts, first-seen wins on
// a -0/+0 tie) on arrays full of NaN, infinities and signed zeros.
function npyBytes(height, width, channels, values) {
	let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${height}, ${width}${channels > 1 ? `, ${channels}` : ''}), }`;
	while ((10 + header.length + 1) % 64) header += ' ';
	header += '\n';
	const out = new Uint8Array(10 + header.length + values.length * 4);
	out.set([0x93, 78, 85, 77, 80, 89, 1, 0, header.length & 255, header.length >> 8]);
	for (let i = 0; i < header.length; i++) out[10 + i] = header.charCodeAt(i);
	new Float32Array(out.buffer, 10 + header.length).set(values);
	return out.buffer;
}
function referenceRange(data, width, height, channels) {
	let min = Infinity, max = -Infinity, valid = 0, nonFinite = 0;
	const scanned = channels >= 3 ? 3 : 1;
	for (let pixel = 0; pixel < width * height; pixel++) {
		for (let channel = 0; channel < scanned; channel++) {
			const value = data[pixel * channels + channel];
			if (Number.isFinite(value)) {
				if (value < min) min = value;
				if (value > max) max = value;
				valid++;
			} else nonFinite++;
		}
	}
	return [min, max, valid, nonFinite];
}
const specials = [NaN, Infinity, -Infinity, 0, -0, 1e30, -1e30];
let seed = 12345;
const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 0x100000000);
for (let trial = 0; trial < 2000; trial++) {
	const channels = [1, 3, 4][trial % 3];
	const width = 1 + Math.floor(random() * 9), height = 1 + Math.floor(random() * 7);
	const values = new Float32Array(width * height * channels);
	for (let i = 0; i < values.length; i++) {
		values[i] = random() < 0.25 ? specials[Math.floor(random() * specials.length)] : (random() - 0.5) * 100;
	}
	const decoded = decodeNativeF32NpyFast(npyBytes(height, width, channels, values));
	assert.ok(decoded, `trial ${trial}: fast path declined a native float32 array`);
	const got = [decoded.stats.min, decoded.stats.max, decoded.validCount, decoded.nonFiniteCount];
	const expected = referenceRange(values, width, height, channels);
	assert.ok(got.every((value, index) => Object.is(value, expected[index])),
		`trial ${trial} (${width}x${height}x${channels}): ${got} != ${expected}`);
}

// The dataset path must not let a raster accelerator swallow navigation or
// treat Fortran samples as C-order. Ordinary 2D C-order stays zero-copy.
{
    const { npy } = require('./lib/numpy-dataset-fixtures.cjs');
    for (const shape of [[2, 5, 6], [5, 6, 3], [2, 5, 6, 3]]) {
        assert.equal(decodeNativeF32NpyFast(bufferToArrayBuffer(npy(shape)), true, true), null);
    }
    assert.equal(decodeNativeF32NpyFast(bufferToArrayBuffer(npy([5, 6], { fortran: true })), true, true), null);
    const buffer = bufferToArrayBuffer(npy([5, 6]));
    const image = decodeNativeF32NpyFast(buffer, true, true);
    assert.equal(image.data.buffer, buffer);
    assert.equal(image.data[29], 29);
}

console.log(`✅ Fast raw decoders: ${supported} optimized fixtures, ${fallback} Rust fallbacks, 2000 randomized NPY ranges`);
