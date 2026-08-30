#!/usr/bin/env node

"use strict";

/**
 * The main-thread decode path reaches its Rust entry points through a wrapper
 * that assembles one cached module object. A decoder added to
 * `main-thread-decode.ts` but not listed in that object fails only at runtime,
 * on the fallback path, which is exactly where it is least likely to be
 * noticed — hence this check.
 *
 * There are now TWO wrappers, because JPEG XL is built as its own WebAssembly
 * module (see wasm/jxl-decoder). So each decode function is matched against
 * the wrapper it actually awaits: a name resolved through `initJxlDecoder()`
 * must be in the JPEG XL module, and everything else in the shared one. That
 * distinction is the point — listing `decode_jxl_fast` in the shared wrapper
 * would be wrong, not merely redundant.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const mainThreadDecoder = read('media/modules/main-thread-decode.ts');

function moduleObjectOf(file) {
	const source = read(file);
	const match = source.match(/wasmModule\s*=\s*\{([\s\S]*?)\}/);
	assert(match, `${file} must assemble a WASM module object`);
	return match[1];
}

const modules = {
	shared: { object: moduleObjectOf('media/modules/tiff-wasm-wrapper.ts'), label: 'the shared WASM module' },
	jxl: { object: moduleObjectOf('media/modules/jxl-wasm-wrapper.ts'), label: 'the JPEG XL WASM module' },
};

// Each exported decode function, from its signature to the next one.
const functions = mainThreadDecoder.split(/(?=export async function )/).slice(1);
assert(functions.length > 0, 'main-thread-decode must export decode functions');

let checked = 0;
for (const body of functions) {
	const name = body.match(/export async function (\w+)/)[1];
	const used = [...body.matchAll(/wasm\.(decode_[a-z0-9_]+)/g)].map(m => m[1]);
	if (used.length === 0) { continue; }
	const which = /initJxlDecoder\(/.test(body) ? modules.jxl : modules.shared;
	for (const exportName of new Set(used)) {
		assert(
			new RegExp(`\\b${exportName}\\b`).test(which.object),
			`${name} uses ${exportName} but it is missing from ${which.label}`,
		);
		checked++;
	}
}

// The JPEG XL decoder must NOT also be linked into the shared module: that
// would put jxl-rs back into every TIFF open, which is what the separate
// module exists to avoid.
assert(!/\bdecode_jxl_fast\b/.test(modules.shared.object),
	'decode_jxl_fast must not be part of the shared WASM module — it belongs to wasm/jxl-decoder');

console.log(`Main-thread WASM wiring exposes all ${checked} required decoders, from the right module.`);
