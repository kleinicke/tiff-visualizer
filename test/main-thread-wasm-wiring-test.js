#!/usr/bin/env node

"use strict";

/**
 * The main-thread decode path reaches its Rust entry points through a wrapper
 * that assembles one cached module object. A decoder added to
 * `main-thread-decode.ts` but not listed in that object fails only at runtime,
 * on the fallback path, which is exactly where it is least likely to be
 * noticed — hence this check.
 *
 * There are now THREE wrappers, because two decoders are built as their own
 * WebAssembly modules: JPEG XL (wasm/jxl-decoder) and the heavy codecs
 * (wasm/tiff-decoder built a second time with `--features heavy-codecs`). So
 * each decode function is matched against the wrapper it actually awaits — a
 * name resolved through `initJxlDecoder()` must be in the JPEG XL module, one
 * resolved through `initCodecDecoder()` in the codec module, everything else
 * in the shared one. That distinction is the point: listing `decode_jxl_fast`
 * or `decode_jpegxr_fast` in the shared wrapper would be wrong, not merely
 * redundant, because the shared module does not contain them.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const mainThreadDecoder = read('media/modules/main-thread-decode.ts');

function moduleObjectOf(file) {
	const source = read(file);
	// Each wrapper caches its exports in a `<something>Module = { ... }` object.
	const match = source.match(/\w*[Mm]odule\s*=\s*\{([\s\S]*?)\}/);
	assert(match, `${file} must assemble a WASM module object`);
	return match[1];
}

const modules = {
	shared: { object: moduleObjectOf('media/modules/tiff-wasm-wrapper.ts'), label: 'the shared WASM module' },
	jxl: { object: moduleObjectOf('media/modules/jxl-wasm-wrapper.ts'), label: 'the JPEG XL WASM module' },
	codec: { object: moduleObjectOf('media/modules/codec-wasm-wrapper.ts'), label: 'the heavy-codec WASM module' },
};

// Each exported decode function, from its signature to the next one.
const functions = mainThreadDecoder.split(/(?=export async function )/).slice(1);
assert(functions.length > 0, 'main-thread-decode must export decode functions');

let checked = 0;
for (const body of functions) {
	const name = body.match(/export async function (\w+)/)[1];
	const used = [...body.matchAll(/wasm\.(decode_[a-z0-9_]+)/g)].map(m => m[1]);
	if (used.length === 0) { continue; }
	const which = /initJxlDecoder\(/.test(body) ? modules.jxl
		: /initCodecDecoder\(/.test(body) ? modules.codec
			: modules.shared;
	for (const exportName of new Set(used)) {
		assert(
			new RegExp(`\\b${exportName}\\b`).test(which.object),
			`${name} uses ${exportName} but it is missing from ${which.label}`,
		);
		checked++;
	}
}

// The on-demand decoders must NOT also be linked into the shared module: that
// would put their weight back into every image open, which is exactly what the
// separate modules exist to avoid.
assert(!/\bdecode_jxl_fast\b/.test(modules.shared.object),
	'decode_jxl_fast must not be part of the shared WASM module — it belongs to wasm/jxl-decoder');
assert(!/\bdecode_jpegxr_fast\b/.test(modules.shared.object),
	'decode_jpegxr_fast must not be part of the shared WASM module — it belongs to the heavy-codec build');

console.log(`Main-thread WASM wiring exposes all ${checked} required decoders, from the right module.`);
