/**
 * Decode smoke-test for PNG (16-bit + 8-bit via UPNG.decode — the worker's
 * png path), standalone JPEG XR (`decode_jpegxr_fast`) and standalone JPEG XL
 * (`decode_jxl_fast`, which lives in its own WebAssembly module), exercising
 * the real decoders the extension uses.
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

/** The pattern the fixture generator scripts encode into every fixture. */
function pattern(x, y) {
	return (Math.sin(x / 5) * Math.cos(y / 4) + 1) / 2;
}

/**
 * Standalone JPEG XR, decoded by the vendored crates/jpegxr through
 * `decode_jpegxr_fast` in the heavy-codec module. The integer fixtures are LOSSLESS, so their samples
 * are checked against the generator's own formula rather than against another
 * decode — an independent expectation, not a snapshot. The float32 encoder is
 * lossy whatever the level, so that one gets a tolerance.
 */
async function testJpegXr() {
	// JPEG XR lives ONLY in the heavy-codec module: a `.jxr` file is a JPEG XR
	// codestream and nothing else, so there is no core decode to try first.
	const wasmJs = path.join(__dirname, '..', 'media', 'wasm', 'codec-wasm.js');
	const wasmBin = path.join(__dirname, '..', 'media', 'wasm', 'codec-wasm.wasm');
	if (!fs.existsSync(wasmBin)) {
		console.log('⚠️  media/wasm/codec-wasm.wasm not found — run `npm run build:wasm:codecs` first. Skipping JPEG XR.');
		return;
	}
	const wasm = await import(wasmJs.replace(/\\/g, '/'));
	await wasm.default({ module_or_path: fs.readFileSync(wasmBin) });

	for (const [file, channels, bits, sampleFormat, numericType, scale, tolerance] of [
		['standalone_gray8.jxr', 1, 8, 1, 'uint8', 255, 0],
		['standalone_rgb8.jxr', 3, 8, 1, 'uint8', 255, 0],
		['standalone_gray16.jxr', 1, 16, 1, 'uint16', 65535, 0],
		['standalone_f32.jxr', 1, 32, 3, 'float32', 1, 1e-3],
	]) {
		const bytes = new Uint8Array(fs.readFileSync(path.join(samplesDir, file)));
		const result = wasm.decode_jpegxr_fast(bytes);
		assert.strictEqual(result.width, 64, `${file} width`);
		assert.strictEqual(result.height, 48, `${file} height`);
		assert.strictEqual(result.channels, channels, `${file} channels`);
		assert.strictEqual(result.bits_per_sample, bits, `${file} bits per sample`);
		assert.strictEqual(result.sample_format, sampleFormat, `${file} sample format`);
		assert.strictEqual(result.source_numeric_type, numericType, `${file} numeric type`);

		const data = result.take_data_as_f32();
		assert.strictEqual(data.length, 64 * 48 * channels, `${file} sample count`);
		// The red channel of the RGB fixture carries the pattern; the other two
		// are derived from it, so checking the first channel is enough to prove
		// the stride and row order are right.
		let worst = 0;
		for (let y = 0; y < 48; y++) {
			for (let x = 0; x < 64; x++) {
				const expected = scale === 1
					? pattern(x, y)
					: Math.floor(pattern(x, y) * scale);
				worst = Math.max(worst, Math.abs(data[(y * 64 + x) * channels] - expected));
			}
		}
		assert.ok(worst <= tolerance,
			`${file}: worst sample error ${worst} exceeds ${tolerance}`);
		console.log(`✅ ${file} decodes to ${channels}-channel ${numericType} (worst error ${worst})`);
	}

	// A file that is not JPEG XR at all must be refused by signature rather
	// than handed to the codec.
	assert.throws(() => wasm.decode_jpegxr_fast(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
		/Not a JPEG XR file/, 'a non-JPEG XR buffer must be rejected by signature');
	console.log('✅ Non-JPEG XR bytes are rejected by signature');
}

/**
 * Standalone JPEG XL, decoded by jxl-rs through `decode_jxl_fast`. This module
 * is built SEPARATELY from tiff-wasm (see wasm/jxl-decoder), which is why this
 * loads a second module rather than reusing the one testJpegXr initialized.
 *
 * Every fixture is lossless, so all of them — including the 16-bit and float32
 * ones — are checked against the generator's formula with ZERO tolerance. That
 * is the point of the suite: the JavaScript decoder this replaced returned
 * 8-bit RGBA whatever went in, and `standalone_gray16` and `standalone_f32`
 * are exactly the cases it got wrong.
 */
async function testJpegXl() {
	const wasmJs = path.join(__dirname, '..', 'media', 'wasm', 'jxl-wasm.js');
	const wasmBin = path.join(__dirname, '..', 'media', 'wasm', 'jxl-wasm.wasm');
	if (!fs.existsSync(wasmBin)) {
		console.log('⚠️  media/wasm/jxl-wasm.wasm not found — run `npm run build:wasm:jxl` first. Skipping JPEG XL.');
		return;
	}
	const wasm = await import(wasmJs.replace(/\\/g, '/'));
	await wasm.default({ module_or_path: fs.readFileSync(wasmBin) });

	for (const [file, channels, bits, sampleFormat, numericType, scale] of [
		['standalone_gray8.jxl', 1, 8, 1, 'uint8', 255],
		['standalone_rgb8.jxl', 3, 8, 1, 'uint8', 255],
		['standalone_rgba8.jxl', 4, 8, 1, 'uint8', 255],
		['standalone_gray16.jxl', 1, 16, 1, 'uint16', 65535],
		['standalone_f32.jxl', 1, 32, 3, 'float32', 1],
	]) {
		const bytes = new Uint8Array(fs.readFileSync(path.join(samplesDir, file)));
		const result = wasm.decode_jxl_fast(bytes);
		assert.strictEqual(result.width, 64, `${file} width`);
		assert.strictEqual(result.height, 48, `${file} height`);
		assert.strictEqual(result.channels, channels, `${file} channels`);
		assert.strictEqual(result.bits_per_sample, bits, `${file} bits per sample`);
		assert.strictEqual(result.sample_format, sampleFormat, `${file} sample format`);
		assert.strictEqual(result.source_numeric_type, numericType, `${file} numeric type`);

		const data = result.take_data_as_f32();
		assert.strictEqual(data.length, 64 * 48 * channels, `${file} sample count`);
		let worst = 0;
		for (let y = 0; y < 48; y++) {
			for (let x = 0; x < 64; x++) {
				const expected = scale === 1
					? Math.fround(pattern(x, y))
					: Math.floor(pattern(x, y) * scale);
				worst = Math.max(worst, Math.abs(data[(y * 64 + x) * channels] - expected));
			}
		}
		assert.strictEqual(worst, 0, `${file}: lossless fixture decoded with error ${worst}`);
		// The alpha fixture stores a constant 200, which an invented opaque
		// alpha channel (255) would not match.
		if (channels === 4) {
			assert.strictEqual(data[3], 200, `${file} alpha sample`);
		}
		console.log(`✅ ${file} decodes to ${channels}-channel ${numericType} losslessly`);
	}

	// A file that is not JPEG XL must be refused by signature rather than fed
	// to the codec.
	assert.throws(() => wasm.decode_jxl_fast(new Uint8Array(12)),
		/Not a JPEG XL file/, 'a non-JPEG XL buffer must be rejected by signature');
	console.log('✅ Non-JPEG XL bytes are rejected by signature');
}

async function main() {
	console.log('🧪 Running format decoder smoke-tests (PNG, JPEG XR, JPEG XL)...\n');
	await testJpegXr();
	await testJpegXl();

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
