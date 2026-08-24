#!/usr/bin/env node

"use strict";

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const mainThreadDecoder = fs.readFileSync(
	path.join(root, 'media/modules/main-thread-decode.ts'),
	'utf8',
);
const wrapper = fs.readFileSync(
	path.join(root, 'media/modules/tiff-wasm-wrapper.ts'),
	'utf8',
);

const moduleObject = wrapper.match(/wasmModule\s*=\s*\{([\s\S]*?)\n\s*\};/);
assert(moduleObject, 'tiff-wasm-wrapper must assemble a shared WASM module object');

const requiredExports = [...mainThreadDecoder.matchAll(/wasm\.(decode_[a-z0-9_]+)/g)]
	.map(match => match[1]);

for (const exportName of new Set(requiredExports)) {
	assert(
		new RegExp(`\\b${exportName}\\b`).test(moduleObject[1]),
		`${exportName} is used by the main-thread decoder but missing from the shared WASM module`,
	);
}

console.log(`Main-thread WASM wiring exposes all ${new Set(requiredExports).size} required decoders.`);
