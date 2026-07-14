/**
 * Regression tests for TIFF sample-format handling in TiffProcessor
 * (media/modules/tiff-processor.js):
 *
 *   1. Sub-16-bit unsigned depths (10/12/14 bps) must be carried in a
 *      Uint16Array — not Uint8Array, where values above 255 wrap mod 256 —
 *      and gamma-mode normalization must use the true bit range
 *      (typeMax = 2^bits - 1, e.g. 4095 for 12-bit), not 255 or 65535.
 *   2. Signed integer samples (SampleFormat=2) must be carried in a
 *      Float32Array — an unsigned carrier corrupts negatives (-5 → 251) —
 *      must be routed to the 'tiff-int-signed' per-format settings key
 *      (auto-normalize defaults), and pixel inspection must keep showing
 *      plain integers.
 *   3. A GDAL_NODATA sentinel (tag 42113, e.g. "-32768") must be excluded
 *      from auto-normalize min/max statistics without altering pixel values.
 *
 * Fixtures:
 *   - test-samples/shapes_lzw_12bps.tif — 12-bit chunky LZW RGB (values up
 *     to 4095), copied from test_data/testfiles/exampletiffs.
 *   - A tiny int16 grayscale TIFF with GDAL_NODATA="-32768" synthesized
 *     in-memory below (makeInt16Tiff), so no binary fixture is needed.
 *
 * tiff-processor.js is a webview module, so like tiff-multipage-decode-test
 * it runs here with minimal browser shims: window.GeoTIFF (the real geotiff
 * npm package — the WASM decoder is disabled so the geotiff.js fallback is
 * exercised deterministically), fetch, document.createElement and ImageData.
 *
 * Run with: node test/tiff-sample-format-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const samplesDir = path.join(__dirname, '..', 'test-samples');
const twelveBitFixture = path.join(samplesDir, 'shapes_lzw_12bps.tif');
const syntheticInt16Path = 'synthetic-int16-nodata.tif';

// ---------------------------------------------------------------------------
// Browser shims tiff-processor.js needs at import/construct/render time.
// ---------------------------------------------------------------------------

/** @type {Map<string, ArrayBuffer>} */
const syntheticFiles = new Map();

global.window = { GeoTIFF: require('geotiff') };
global.fetch = async (filePath) => {
	const synthetic = syntheticFiles.get(filePath);
	if (synthetic) {
		return { arrayBuffer: async () => synthetic.slice(0) };
	}
	const buf = fs.readFileSync(filePath);
	const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	return { arrayBuffer: async () => arrayBuffer };
};
global.document = { createElement: () => ({}) };
// Minimal ImageData polyfill for ImageRenderer's CPU paths.
global.ImageData = class ImageData {
	constructor(dataOrWidth, widthOrHeight, maybeHeight) {
		if (typeof dataOrWidth === 'number') {
			this.width = dataOrWidth;
			this.height = widthOrHeight;
			this.data = new Uint8ClampedArray(this.width * this.height * 4);
		} else {
			this.data = dataOrWidth;
			this.width = widthOrHeight;
			this.height = maybeHeight;
		}
	}
};

// ---------------------------------------------------------------------------
// Synthetic int16 TIFF with a GDAL_NODATA tag.
// ---------------------------------------------------------------------------

/**
 * Build a minimal classic little-endian TIFF: 4x3 grayscale, uncompressed
 * int16 (SampleFormat=2), one strip, GDAL_NODATA="-32768".
 * Values: 0..2 plus one -5 and two -32768 (nodata) pixels.
 * @returns {{buffer: ArrayBuffer, pixels: number[], width: number, height: number}}
 */
function makeInt16Tiff() {
	const width = 4, height = 3;
	const pixels = [
		0, 1, 2, 0,
		1, -5, 2, 1,
		-32768, 0, 1, -32768,
	];
	const pixelBytes = width * height * 2;
	const nodataAscii = '-32768\0';
	const entries = 11;
	const ifdOffset = 8 + pixelBytes;
	const ifdBytes = 2 + entries * 12 + 4;
	const nodataOffset = ifdOffset + ifdBytes;
	const buf = Buffer.alloc(nodataOffset + nodataAscii.length);

	// Header: byte order II, magic 42, offset of first IFD.
	buf.write('II', 0, 'ascii');
	buf.writeUInt16LE(42, 2);
	buf.writeUInt32LE(ifdOffset, 4);

	// Pixel data (strip) directly after the header.
	for (let i = 0; i < pixels.length; i++) {
		buf.writeInt16LE(pixels[i], 8 + i * 2);
	}

	// IFD: entry count, then entries sorted by tag id, then next-IFD = 0.
	buf.writeUInt16LE(entries, ifdOffset);
	let entry = ifdOffset + 2;
	const writeEntry = (tag, type, count, value) => {
		buf.writeUInt16LE(tag, entry);
		buf.writeUInt16LE(type, entry + 2);
		buf.writeUInt32LE(count, entry + 4);
		buf.writeUInt32LE(value, entry + 8);
		entry += 12;
	};
	writeEntry(256, 3, 1, width);              // ImageWidth (SHORT)
	writeEntry(257, 3, 1, height);             // ImageLength (SHORT)
	writeEntry(258, 3, 1, 16);                 // BitsPerSample (SHORT)
	writeEntry(259, 3, 1, 1);                  // Compression: none
	writeEntry(262, 3, 1, 1);                  // Photometric: MinIsBlack
	writeEntry(273, 4, 1, 8);                  // StripOffsets (LONG)
	writeEntry(277, 3, 1, 1);                  // SamplesPerPixel
	writeEntry(278, 3, 1, height);             // RowsPerStrip
	writeEntry(279, 4, 1, pixelBytes);         // StripByteCounts (LONG)
	writeEntry(339, 3, 1, 2);                  // SampleFormat: signed int
	writeEntry(42113, 2, nodataAscii.length, nodataOffset); // GDAL_NODATA (ASCII)
	buf.writeUInt32LE(0, entry);               // next IFD: none
	buf.write(nodataAscii, nodataOffset, 'ascii');

	return {
		buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
		pixels, width, height,
	};
}

/**
 * TiffProcessor wired for node: WASM decode disabled (forces the geotiff.js
 * fallback), no extension host unless a vscode stub is passed.
 * @param {any} TiffProcessor
 * @param {any} settings
 * @param {any} [vscodeStub]
 */
function makeProcessor(TiffProcessor, settings, vscodeStub = null) {
	const p = new TiffProcessor({ settings }, vscodeStub);
	p._isInitialLoad = !!vscodeStub;
	p._wasmAvailable = false;
	// The constructor's async init may still flip _wasmAvailable to true;
	// a throwing decode stub keeps the test on the geotiff.js path either way.
	p._wasmProcessor = {
		init: async () => false,
		decode: async () => { throw new Error('WASM disabled in test'); },
	};
	return p;
}

const gammaIdentitySettings = {
	normalization: { min: 0, max: 1, autoNormalize: false, gammaMode: true },
	gamma: { in: 2.2, out: 2.2 },
	brightness: { offset: 0 },
	rgbAs24BitGrayscale: false,
	scale24BitFactor: 1000,
	normalizedFloatMode: false,
};

const autoNormalizeSettings = {
	...gammaIdentitySettings,
	normalization: { min: 0, max: 1, autoNormalize: true, gammaMode: false },
};

async function main() {
	if (!fs.existsSync(twelveBitFixture)) {
		console.log('⚠️  test-samples/shapes_lzw_12bps.tif not found — skipping.');
		return;
	}

	console.log('🧪 Running TIFF sample-format tests...\n');

	const { TiffProcessor, tiffTypeMax, tiffFormatTypeFor } = await import(
		path.join('..', 'media', 'modules', 'tiff-processor.js').replace(/\\/g, '/')
	);
	const { parseGdalNodata } = await import(
		path.join('..', 'media', 'modules', 'tiff-tag-utils.js').replace(/\\/g, '/')
	);

	// --- Helper contracts -------------------------------------------------
	assert.strictEqual(tiffTypeMax(1, 8), 255);
	assert.strictEqual(tiffTypeMax(1, 10), 1023);
	assert.strictEqual(tiffTypeMax(1, 12), 4095);
	assert.strictEqual(tiffTypeMax(1, 14), 16383);
	assert.strictEqual(tiffTypeMax(1, 16), 65535);
	assert.strictEqual(tiffTypeMax(2, 16), 32767, 'signed 16-bit full range is the positive half');
	assert.strictEqual(tiffTypeMax(3, 32), 1.0);
	assert.strictEqual(tiffTypeMax([1, 1, 1], 12), 4095, 'per-channel SampleFormat arrays use the first entry');
	assert.strictEqual(tiffFormatTypeFor(1), 'tiff-int');
	assert.strictEqual(tiffFormatTypeFor(2), 'tiff-int-signed');
	assert.strictEqual(tiffFormatTypeFor(3), 'tiff-float');
	console.log('✅ tiffTypeMax / tiffFormatTypeFor: 2^bits - 1 per depth, signed → tiff-int-signed');

	// GDAL_NODATA extraction from both decoder paths' tag spellings:
	// geotiff.js fileDirectory key, the Rust tiff crate's named variant, and
	// the crate's Unknown(id) fallback. Trailing NULs must not break parsing.
	assert.strictEqual(parseGdalNodata([{ tag: null, name: 'GDAL_NODATA', group: 'TIFF', value: '-32768\0' }]), -32768);
	assert.strictEqual(parseGdalNodata([{ tag: null, name: 'GdalNodata', group: 'TIFF', value: '-32768' }]), -32768);
	assert.strictEqual(parseGdalNodata([{ tag: null, name: 'Unknown(42113)', group: 'TIFF', value: '0' }]), 0);
	assert.strictEqual(parseGdalNodata([{ tag: null, name: 'ImageWidth', group: 'TIFF', value: '4' }]), undefined);
	assert.strictEqual(parseGdalNodata([{ tag: null, name: 'Unknown(42112)', group: 'TIFF', value: '7' }]), undefined);
	console.log('✅ parseGdalNodata: handles geotiff.js, Rust-crate and Unknown(42113) tag names');

	// --- 1. 12-bit unsigned RGB (values > 255 must survive) ---------------
	{
		const p = makeProcessor(TiffProcessor, gammaIdentitySettings);
		const { imageData } = await p.processTiff(twelveBitFixture);

		const data = p.rawTiffData.data;
		assert.ok(data instanceof Uint16Array,
			`12-bit samples need a Uint16Array carrier, got ${data.constructor.name}`);
		// Only channel 0 is asserted by value: geotiff.js (the fallback decoder
		// exercised here) misdecodes the later channels of 12-bit chunky LZW
		// files — an upstream unpacking bug the Rust/WASM decoder doesn't have.
		// Channel 0 is decoded correctly and covers the full 12-bit scale.
		let rawMax = 0;
		for (let i = 0; i < data.length; i += 3) { if (data[i] > rawMax) { rawMax = data[i]; } }
		assert.ok(rawMax > 255, `12-bit values above 255 must survive interleaving (max=${rawMax})`);
		assert.strictEqual(rawMax, 4095, 'fixture contains full-scale 12-bit values');

		// Interleaved data must match the planar rasters exactly (no wrap).
		const rasters = p.rawTiffData.rasters;
		for (const i of [0, 1000, 5000]) {
			for (let c = 0; c < 3; c++) {
				assert.strictEqual(data[i * 3 + c], rasters[c][i], `interleaved pixel ${i} channel ${c}`);
			}
		}

		// Gamma mode + identity transform normalizes by typeMax. With the true
		// 12-bit range (4095) full-scale pixels hit 255; with the old hardcoded
		// 65535 they would top out at ~16.
		let renderedMax = 0;
		for (let i = 0; i < imageData.data.length; i += 4) {
			if (imageData.data[i] > renderedMax) { renderedMax = imageData.data[i]; }
		}
		assert.strictEqual(renderedMax, 255,
			`gamma-mode render must use typeMax 4095 (max rendered intensity ${renderedMax})`);
		console.log('✅ 12-bit RGB: Uint16Array carrier, values up to 4095 survive, renders full-scale');
	}

	// --- 2. Signed int16 + GDAL_NODATA ------------------------------------
	{
		const synthetic = makeInt16Tiff();
		syntheticFiles.set(syntheticInt16Path, synthetic.buffer);

		/** @type {any[]} */
		const messages = [];
		const vscodeStub = { postMessage: (msg) => messages.push(msg) };
		const p = makeProcessor(TiffProcessor, autoNormalizeSettings, vscodeStub);
		await p.processTiff(syntheticInt16Path);

		// Initial load defers rendering and posts formatInfo first: signed int
		// must be routed to the 'tiff-int-signed' per-format settings key
		// (auto-normalize defaults in AppStateManager), not gamma-mode 'tiff-int'.
		const formatInfo = messages.find(m => m.type === 'formatInfo');
		assert.ok(formatInfo, 'formatInfo must be posted on initial load');
		assert.strictEqual(formatInfo.value.formatType, 'tiff-int-signed');
		assert.strictEqual(formatInfo.value.sampleFormat, 2);
		console.log('✅ Signed int16: formatType is tiff-int-signed');

		// Negative values must survive in the Float32Array carrier
		// (a Uint8/Uint16 carrier would wrap -5 to 251/65531).
		const data = p.rawTiffData.data;
		assert.ok(data instanceof Float32Array,
			`signed samples need a Float32Array carrier, got ${data.constructor.name}`);
		assert.deepStrictEqual(Array.from(data), synthetic.pixels,
			'signed pixel values must survive decode + interleave exactly');
		console.log('✅ Signed int16: Float32Array carrier, negatives and nodata values intact');

		assert.strictEqual(p._gdalNodata, -32768, 'GDAL_NODATA tag must be parsed');

		// Deferred render with auto-normalize: stats must exclude the nodata
		// sentinel (-32768 would otherwise become the range minimum and flatten
		// the real 0..2 data to a single gray level).
		const imageData = await p.performDeferredRender();
		assert.deepStrictEqual(p._lastStatistics, { min: -5, max: 2 },
			'auto-normalize stats must exclude the GDAL_NODATA value');
		const statsMsg = messages.find(m => m.type === 'stats');
		assert.deepStrictEqual(statsMsg.value, { min: -5, max: 2 });

		// Rendered intensities: max value (2) maps to 255, the minimum (-5) to 0,
		// and nodata pixels clamp to 0 — their stored values stay untouched.
		const intensityAt = (i) => imageData.data[i * 4];
		assert.strictEqual(intensityAt(2), 255, 'value 2 renders full white');
		assert.strictEqual(intensityAt(5), 0, 'value -5 renders black');
		assert.strictEqual(intensityAt(8), 0, 'nodata pixel clamps to black');
		console.log('✅ Signed int16 + nodata: stats {min:-5, max:2}, nodata excluded but pixels unaltered');

		// Pixel inspection keeps plain integer formatting for signed data.
		assert.strictEqual(p.getColorAtPixel(1, 1, synthetic.width, synthetic.height), '-5');
		assert.strictEqual(p.getColorAtPixel(0, 2, synthetic.width, synthetic.height), '-32768');
		assert.strictEqual(p.getColorAtPixel(2, 0, synthetic.width, synthetic.height), '2');
		console.log('✅ Signed int16: pixel inspection shows plain integers (no decimals, no wrap)');
	}

	// --- 3. Signed int16 via the WASM decoder path -------------------------
	// The Rust decoder returns sign-correct interleaved Float32 data plus its
	// own min/max scan — which includes the GDAL_NODATA sentinel. The processor
	// must reuse the stored Float32Array as-is (not re-interleave it into an
	// unsigned array, wrapping the negatives) and drop the WASM stats so they
	// are recomputed in JS with the nodata value excluded.
	{
		const synthetic = makeInt16Tiff();
		const wasmResult = {
			width: synthetic.width,
			height: synthetic.height,
			channels: 1,
			bitsPerSample: 16,
			sampleFormat: 2,
			compression: 1,
			predictor: 1,
			photometricInterpretation: 1,
			planarConfiguration: 1,
			data: new Float32Array(synthetic.pixels),
			min: -32768, // WASM's scan sees the nodata sentinel
			max: 2,
			allTagsJson: JSON.stringify([
				{ tag: 42113, name: 'GdalNodata', group: 'TIFF', value: '-32768' },
			]),
			decodedWith: 'wasm (stub)',
		};
		wasmResult.rasters = [wasmResult.data];

		const p = makeProcessor(TiffProcessor, autoNormalizeSettings);
		p._wasmAvailable = true;
		p._wasmProcessor = { init: async () => true, decode: async () => wasmResult };
		syntheticFiles.set(syntheticInt16Path, synthetic.buffer);
		const { imageData } = await p.processTiff(syntheticInt16Path);

		assert.strictEqual(p.rawTiffData.data, wasmResult.data,
			'the WASM path must keep the decoded Float32Array as the stored carrier');
		assert.deepStrictEqual(p._lastStatistics, { min: -5, max: 2 },
			'WASM min/max containing the nodata sentinel must be recomputed with it excluded');
		assert.strictEqual(imageData.data[2 * 4], 255, 'value 2 renders full white');
		assert.strictEqual(imageData.data[5 * 4], 0, 'value -5 renders black (not wrapped to 65531)');
		assert.strictEqual(p.getColorAtPixel(1, 1, synthetic.width, synthetic.height), '-5');
		console.log('✅ Signed int16 (WASM path): Float32 data reused, nodata-tainted stats recomputed');
	}

	console.log('\n🎉 All TIFF sample-format tests passed.\n');
}

main().catch(err => {
	console.error('❌ TIFF sample-format test failed:');
	console.error(err);
	process.exit(1);
});
