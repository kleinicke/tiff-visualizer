#!/usr/bin/env node

"use strict";

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');

(async () => {
	const policy = await import(pathToFileURL(path.join(root, 'out/media/modules/tiff-parallel-policy.js')));
	const orientationRanges = await import(pathToFileURL(path.join(root, 'out/media/modules/tiff-orientation-range.js')));
	const eligible = strips => ({ strip_count: strips, width: 2000, height: 1000 });
	assert.strictEqual(policy.shouldUseParallelTiffPlan(eligible(15)), false, '15 strips must stay on one worker');
	assert.strictEqual(policy.shouldUseParallelTiffPlan(eligible(16)), true, '16 strips and 2M pixels must use the pool');
	assert.strictEqual(policy.shouldUseParallelTiffPlan({ strip_count: 100, width: 1000, height: 1000 }), false,
		'small rasters must stay on one worker despite many strips');
	assert.strictEqual(policy.shouldUseParallelTiffPlan({ ...eligible(100), compression: 1, sample_format: 1, bits_per_sample: 8 }), false,
		'uncompressed uint8 rasters must avoid copy-bound pool dispatch');
	assert.strictEqual(policy.shouldUseParallelTiffPlan({ ...eligible(100), compression: 1, sample_format: 3, bits_per_sample: 32 }), true,
		'uncompressed float32 rasters still benefit from parallel conversion');
	const lzma = strips => ({ ...eligible(strips), width: 4032, height: 3024, channels: 1,
		bits_per_sample: 8, compression: 34925 });
	assert.strictEqual(policy.shouldUseParallelTiffPlan(lzma(1)), false,
		'a single LZMA strip cannot be decoded in parallel');
	assert.strictEqual(policy.shouldUseParallelTiffPlan(lzma(2)), true,
		'two large LZMA strips must use two workers');
	assert.strictEqual(policy.parallelTiffWorkerCount(lzma(2)), 2,
		'two strips must never request idle workers');
	assert.strictEqual(policy.parallelTiffWorkerCount(lzma(12)), 6,
		'12 MiB of decoded LZMA output should request six workers');
	assert.strictEqual(policy.parallelTiffWorkerCount(lzma(100)), 6,
		'many small strips should be grouped by useful decoded work');
	assert.strictEqual(policy.parallelTiffWorkerCount({ ...lzma(100), channels: 3 }), 8,
		'large RGB LZMA should stop at the global eight-worker cap');

	// Assemble two independently transformed source-row bands and compare them
	// with an independent whole-raster reference for every TIFF orientation.
	const width = 3, height = 2, channels = 2;
	const source = new Uint8Array(width * height * channels);
	for (let index = 0; index < source.length; index++) { source[index] = index + 1; }
	for (let orientation = 1; orientation <= 8; orientation++) {
		const transposed = orientation >= 5;
		const outputWidth = transposed ? height : width;
		const outputHeight = transposed ? width : height;
		const expected = new Uint8Array(source.length);
		for (let sy = 0; sy < height; sy++) {
			for (let sx = 0; sx < width; sx++) {
				let dx, dy;
				switch (orientation) {
					case 2: dx = width - 1 - sx; dy = sy; break;
					case 3: dx = width - 1 - sx; dy = height - 1 - sy; break;
					case 4: dx = sx; dy = height - 1 - sy; break;
					case 5: dx = sy; dy = sx; break;
					case 6: dx = height - 1 - sy; dy = sx; break;
					case 7: dx = height - 1 - sy; dy = width - 1 - sx; break;
					case 8: dx = sy; dy = width - 1 - sx; break;
					default: dx = sx; dy = sy;
				}
				expected.set(source.subarray((sy * width + sx) * channels, (sy * width + sx + 1) * channels),
					(dy * outputWidth + dx) * channels);
			}
		}
		const assembled = new Uint8Array(source.length);
		for (let firstRow = 0; firstRow < height; firstRow++) {
			const band = orientationRanges.orientTiffRange(
				source.slice(firstRow * width * channels, (firstRow + 1) * width * channels),
				width, height, channels, firstRow, orientation);
			if (band.transposed) {
				for (let row = 0; row < outputHeight; row++) {
					const from = row * band.bandWidth * channels;
					assembled.set(band.samples.subarray(from, from + band.bandWidth * channels),
						(row * outputWidth + band.destinationStart) * channels);
				}
			} else {
				assembled.set(band.samples, band.destinationStart * width * channels);
			}
		}
		assert.deepStrictEqual(assembled, expected, `orientation ${orientation} must assemble from ranges exactly`);
	}

	const worker = fs.readFileSync(path.join(root, 'media/decode-worker.ts'), 'utf8');
	const processor = fs.readFileSync(path.join(root, 'media/modules/tiff-processor.ts'), 'utf8');
	assert.match(worker, /preferParallelTiff[\s\S]*decodeTiffSpeculatively/,
		'the bootstrap worker must probe the parallel route before decoding TIFF pixels');
	assert.match(processor, /deferToParallelTiff[\s\S]*bootstrapWasmResult[^\n]*!deferredToParallel/,
		'the TIFF processor must not adopt a speculative result reserved for the strip pool');

	console.log('TIFF speculative routing preserves strip-pool eligibility.');
})().catch(error => {
	console.error(error);
	process.exit(1);
});
