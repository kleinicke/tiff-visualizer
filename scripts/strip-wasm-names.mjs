#!/usr/bin/env node
/**
 * Remove the `name` custom section from a wasm module, in place.
 *
 * wasm-pack leaves it in the release build: 261 KiB of tiff-wasm.wasm and
 * 88 KiB of jxl-wasm.wasm — around 7% of each — is Rust symbol names that
 * nothing reads at runtime. `wasm-opt --strip-debug` would also do it, but
 * that means depending on the binaryen toolchain at build time, which
 * wasm/tiff-decoder's Cargo.toml deliberately avoids. Deleting one custom
 * section is a small enough job to do here instead.
 *
 * Only `name` is removed. `target_features` stays — engines read it to
 * validate the SIMD the module was built with.
 *
 * What is lost: a wasm trap or panic reported to the console shows numeric
 * function indices rather than Rust names. Panic MESSAGES are unaffected —
 * those are strings in the data section. Set TIFF_WASM_KEEP_NAMES=1 to keep
 * the section while debugging one.
 *
 * Usage: node scripts/strip-wasm-names.mjs FILE...
 */

import fs from 'node:fs';

/** Read a LEB128 unsigned integer, returning the value and the next offset. */
function readVarUint(bytes, offset) {
	let value = 0;
	let shift = 0;
	let byte;
	do {
		byte = bytes[offset++];
		value += (byte & 0x7f) * 2 ** shift;
		shift += 7;
	} while (byte & 0x80);
	return [value, offset];
}

/** The byte ranges of every top-level section, in order. */
function sections(bytes) {
	const found = [];
	let offset = 8; // magic + version
	while (offset < bytes.length) {
		const sectionStart = offset;
		const id = bytes[offset++];
		const [size, bodyStart] = readVarUint(bytes, offset);
		found.push({ id, sectionStart, bodyStart, end: bodyStart + size });
		offset = bodyStart + size;
	}
	return found;
}

export function stripNameSection(bytes) {
	const keep = [];
	let previousEnd = 0;
	for (const section of sections(bytes)) {
		if (section.id !== 0) { continue; }
		const [nameLength, nameStart] = readVarUint(bytes, section.bodyStart);
		if (bytes.toString('latin1', nameStart, nameStart + nameLength) !== 'name') { continue; }
		keep.push(bytes.subarray(previousEnd, section.sectionStart));
		previousEnd = section.end;
	}
	if (previousEnd === 0) { return null; }
	keep.push(bytes.subarray(previousEnd));
	return Buffer.concat(keep);
}

function main() {
	const files = process.argv.slice(2);
	if (files.length === 0) {
		console.error('usage: strip-wasm-names.mjs FILE...');
		process.exit(2);
	}
	if (process.env.TIFF_WASM_KEEP_NAMES === '1') {
		console.log('TIFF_WASM_KEEP_NAMES=1, keeping wasm symbol names');
		return;
	}
	for (const file of files) {
		const before = fs.readFileSync(file);
		const after = stripNameSection(before);
		if (!after) {
			console.log(`${file}: no name section`);
			continue;
		}
		fs.writeFileSync(file, after);
		const saved = before.length - after.length;
		console.log(`${file}: stripped names, ${(before.length / 1024).toFixed(0)} -> ${(after.length / 1024).toFixed(0)} KiB (-${(saved / 1024).toFixed(0)} KiB)`);
	}
}

main();
