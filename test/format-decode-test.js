/**
 * Decode smoke-test for PNG (16-bit + 8-bit via UPNG.decode — the worker's
 * png path), exercising the real decoder the extension uses.
 *
 * NumPy and PFM used to be covered here against their TypeScript parsers.
 * Those parsers have been deleted — both formats are decoded by Rust/WASM
 * only — and their coverage now lives in test/rust-npy-conformance-test.js
 * and test/rust-netpbm-conformance-test.js, which check the same fixtures
 * plus a much wider synthesized matrix against golden snapshots.
 *
 * Not covered here: EXR and HDR (cannot be generated without OpenEXR/imageio in
 * this environment) and RAW.
 *
 * Run with: node test/format-decode-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const samplesDir = path.join(__dirname, '..', 'test-samples');
const UPNG = require('../media/upng.min.js');

function ab(file) {
	const b = fs.readFileSync(path.join(samplesDir, file));
	return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

async function main() {
	console.log('🧪 Running format decoder smoke-tests (PNG)...\n');

	// --- PNG via UPNG (the path the extension uses for 16-bit PNGs) ---
	const pngCases = [
		['png_u16_gray.png', 16, 10, 16, 0], // ctype 0 = grayscale
		['png_u8_rgb.png', 16, 10, 8, 2], // ctype 2 = truecolor
	];
	for (const [file, w, h, depth, ctype] of pngCases) {
		const p = UPNG.decode(ab(file));
		assert.strictEqual(p.width, w, `${file} width`);
		assert.strictEqual(p.height, h, `${file} height`);
		assert.strictEqual(p.depth, depth, `${file} bit depth`);
		assert.strictEqual(p.ctype, ctype, `${file} color type`);
		assert.ok(p.data && p.data.length > 0, `${file} has pixel data`);
		console.log(`✅ PNG ${file} -> ${w}x${h} depth=${depth} ctype=${ctype}`);
	}

	console.log('\n🎉 All format decoder smoke-tests passed.\n');
}

main().catch(err => {
	console.error('❌ Format decoder smoke-test failed:');
	console.error(err);
	process.exit(1);
});
