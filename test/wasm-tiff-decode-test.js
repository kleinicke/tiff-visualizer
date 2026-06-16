/**
 * Regression tests for the Rust/WASM TIFF decoder (wasm/tiff-decoder).
 *
 * Exercises the compression types the geotiff.js fallback cannot handle and
 * which the WASM decoder is responsible for:
 *   - CCITT Group 3 / T.4   (compression 3)
 *   - CCITT Group 4 / T.6   (compression 4)
 *   - JPEG-in-TIFF          (compression 7, decoded to RGB)
 *   - Uncompressed bilevel  (1-bit, expanded to 8-bit grayscale)
 *
 * The CCITT-compressed images are byte-for-byte copies of an uncompressed
 * reference, so a correct decode must match the reference exactly.
 *
 * Run with: node test/wasm-tiff-decode-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const samplesDir = path.join(__dirname, '..', 'test-samples');
const wasmJs = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.js');
const wasmBin = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.wasm');

function decode(mod, file) {
	const buffer = fs.readFileSync(path.join(samplesDir, file));
	const result = mod.decode_tiff(new Uint8Array(buffer));
	return {
		width: result.width,
		height: result.height,
		channels: result.channels,
		bitsPerSample: result.bits_per_sample,
		compression: result.compression,
		data: Array.from(result.get_data_as_f32()),
	};
}

async function main() {
	if (!fs.existsSync(wasmBin)) {
		console.log('⚠️  media/wasm/tiff-wasm.wasm not found — run `npm run build:wasm` first. Skipping.');
		return;
	}

	const mod = await import(wasmJs.replace(/\\/g, '/'));
	await mod.default({ module_or_path: fs.readFileSync(wasmBin) });

	console.log('🧪 Running WASM TIFF decoder tests...\n');

	const reference = decode(mod, 'ccitt_none.tif');

	// 1. Uncompressed bilevel expands to one byte per pixel (regression for the
	//    1-bit path that previously returned an empty buffer).
	{
		assert.strictEqual(reference.width, 128);
		assert.strictEqual(reference.height, 96);
		assert.strictEqual(reference.channels, 1);
		assert.strictEqual(reference.bitsPerSample, 8, 'bilevel should be expanded to 8-bit');
		assert.strictEqual(reference.data.length, 128 * 96, 'expanded data must cover every pixel');
		assert.ok(reference.data.some(v => v === 0) && reference.data.some(v => v === 255),
			'bilevel image should contain both black and white pixels');
		console.log('✅ Uncompressed 1-bit bilevel expands to 8-bit grayscale');
	}

	// 2. CCITT Group 3 and Group 4 decode to the exact same pixels as the
	//    uncompressed reference image.
	for (const [label, file, comp] of [['Group 3', 'ccitt_g3.tif', 3], ['Group 4', 'ccitt_g4.tif', 4]]) {
		const img = decode(mod, file);
		assert.strictEqual(img.compression, comp, `${label} compression tag`);
		assert.strictEqual(img.width, reference.width);
		assert.strictEqual(img.height, reference.height);
		assert.strictEqual(img.channels, 1);
		assert.deepStrictEqual(img.data, reference.data,
			`CCITT ${label} must decode identically to the uncompressed reference`);
		console.log(`✅ CCITT ${label} (compression ${comp}) matches the uncompressed reference exactly`);
	}

	// 3. JPEG-in-TIFF decodes to a 3-channel (RGB) 8-bit image.
	{
		const jpeg = decode(mod, 'jpeg_ycbcr.tif');
		assert.strictEqual(jpeg.compression, 7, 'JPEG compression tag');
		assert.strictEqual(jpeg.width, 160);
		assert.strictEqual(jpeg.height, 120);
		assert.strictEqual(jpeg.channels, 3, 'JPEG should decode to 3 interleaved channels');
		assert.strictEqual(jpeg.bitsPerSample, 8);
		assert.strictEqual(jpeg.data.length, 160 * 120 * 3);
		const max = jpeg.data.reduce((m, v) => Math.max(m, v), 0);
		assert.ok(max > 0, 'JPEG image should contain non-zero pixels');
		console.log('✅ JPEG-in-TIFF (compression 7) decodes to 3-channel RGB');
	}

	console.log('\n🎉 All WASM TIFF decoder tests passed.\n');
}

main().catch(err => {
	console.error('❌ WASM TIFF decoder test failed:');
	console.error(err);
	process.exit(1);
});
