#!/usr/bin/env node

"use strict";

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');

(async () => {
	const policy = await import(pathToFileURL(path.join(root, 'out/media/modules/tiff-parallel-policy.js')));
	const eligible = strips => ({ strip_count: strips, width: 2000, height: 1000 });
	assert.strictEqual(policy.shouldUseParallelTiffPlan(eligible(15)), false, '15 strips must stay on one worker');
	assert.strictEqual(policy.shouldUseParallelTiffPlan(eligible(16)), true, '16 strips and 2M pixels must use the pool');
	assert.strictEqual(policy.shouldUseParallelTiffPlan({ strip_count: 100, width: 1000, height: 1000 }), false,
		'small rasters must stay on one worker despite many strips');
	assert.strictEqual(policy.shouldUseParallelTiffPlan({ ...eligible(100), compression: 1, sample_format: 1, bits_per_sample: 8 }), false,
		'uncompressed uint8 rasters must avoid copy-bound pool dispatch');
	assert.strictEqual(policy.shouldUseParallelTiffPlan({ ...eligible(100), compression: 1, sample_format: 3, bits_per_sample: 32 }), true,
		'uncompressed float32 rasters still benefit from parallel conversion');

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
