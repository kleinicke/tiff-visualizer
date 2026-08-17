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
console.log(`✅ Fast raw decoders: ${supported} optimized fixtures, ${fallback} Rust fallbacks`);
