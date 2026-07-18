/**
 * Decode smoke-tests for the non-TIFF format processors:
 *   - NumPy   .npy / .npz   (NpyProcessor._parseNpy / _parseNpz)
 *   - PFM     Portable Float Map (PfmProcessor._parsePfm)
 *   - PNG     16-bit + 8-bit via UPNG.decode (the worker's png path)
 *
 * These exercise the real parsers the extension uses (the decode worker calls
 * the exact same entry points), guarding against regressions like the binary
 * PBM bug in processors that previously had no coverage.
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
	const { NpyProcessor } = await import(
		path.join('..', 'out', 'media', 'modules', 'npy-processor.js').replace(/\\/g, '/')
	);
	const { PfmProcessor } = await import(
		path.join('..', 'out', 'media', 'modules', 'pfm-processor.js').replace(/\\/g, '/')
	);
	const npy = new NpyProcessor(/** @type {any} */ (null), null);
	const pfm = new PfmProcessor(/** @type {any} */ (null), null);

	console.log('🧪 Running format decoder smoke-tests (NPY/NPZ/PFM/PNG)...\n');

	// --- NumPy .npy: float32, uint16, uint8 RGB ---
	const npyCases = [
		['npy_f32_gray.npy', 12, 8, 1, '<f4'],
		['npy_u16_gray.npy', 12, 8, 1, '<u2'],
		['npy_u8_rgb.npy', 12, 8, 3, '|u1'],
	];
	for (const [file, w, h, ch, dtype] of npyCases) {
		const r = npy._parseNpy(ab(file));
		assert.strictEqual(r.width, w, `${file} width`);
		assert.strictEqual(r.height, h, `${file} height`);
		assert.strictEqual(r.channels, ch, `${file} channels`);
		assert.strictEqual(r.dtype, dtype, `${file} dtype`);
		assert.strictEqual(r.data.length, w * h * ch, `${file} data length`);
		console.log(`✅ NPY ${file} -> ${w}x${h} ch=${ch} ${dtype}`);
	}

	// --- NumPy .npz (zip-wrapped single array) ---
	{
		const r = npy._parseNpz(ab('npz_f32.npz'));
		assert.strictEqual(r.width, 6);
		assert.strictEqual(r.height, 6);
		assert.strictEqual(r.channels, 1);
		assert.strictEqual(r.data.length, 36);
		console.log('✅ NPZ npz_f32.npz -> 6x6 ch=1');
	}

	// --- PFM: grayscale (Pf) and color (PF) ---
	const pfmCases = [
		['pfm_gray.pfm', 10, 7, 1],
		['pfm_color.pfm', 9, 6, 3],
	];
	for (const [file, w, h, ch] of pfmCases) {
		const r = pfm._parsePfm(ab(file));
		assert.strictEqual(r.width, w, `${file} width`);
		assert.strictEqual(r.height, h, `${file} height`);
		assert.strictEqual(r.channels, ch, `${file} channels`);
		assert.strictEqual(r.data.length, w * h * ch, `${file} data length`);
		console.log(`✅ PFM ${file} -> ${w}x${h} ch=${ch}`);
	}

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
