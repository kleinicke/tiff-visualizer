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
 *   4. Wide unsigned-integer samples (bitsPerSample > 16, e.g. uint32) must
 *      also be carried in a Float32Array — a Uint16Array carrier wraps
 *      values above 65535 mod 65536 — must be routed to the 'tiff-int-wide'
 *      per-format settings key (auto-normalize defaults, since gamma mode's
 *      full [0, 2^32-1] range would render typical data essentially black),
 *      and pixel inspection must keep showing plain integers.
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
const syntheticUint32Path = 'synthetic-uint32.tif';

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
 * Build a minimal classic little-endian TIFF: 4x3 grayscale, uncompressed
 * uint32 (BitsPerSample=32, SampleFormat=1), one strip.
 * Values: 0, 1, 2 plus one value above the 16-bit range (70000, which a
 * Uint16Array carrier would wrap mod 65536) and one near u32::MAX
 * (4294967040 = 0xFFFFFF00 - chosen, instead of the true max 4294967295,
 * because it has 8 trailing zero bits and so is one of the still-exactly-
 * representable-in-float32 values above 2^24; float32 only carries 24
 * mantissa bits, so an odd value like 4294967295 itself would round to
 * 4294967296 on the Float32Array carrier - an accepted display-only
 * approximation documented in tiffNeedsFloatCarrier, not something this
 * "survives exactly" test should exercise).
 * @returns {{buffer: ArrayBuffer, pixels: number[], width: number, height: number}}
 */
function makeUint32Tiff() {
	const width = 4, height = 3;
	const pixels = [
		0, 1, 2, 0,
		1, 70000, 2, 1,
		4294967040, 0, 1, 3000000000,
	];
	const pixelBytes = width * height * 4;
	const entries = 10;
	const ifdOffset = 8 + pixelBytes;
	const buf = Buffer.alloc(ifdOffset + 2 + entries * 12 + 4);

	buf.write('II', 0, 'ascii');
	buf.writeUInt16LE(42, 2);
	buf.writeUInt32LE(ifdOffset, 4);

	for (let i = 0; i < pixels.length; i++) {
		buf.writeUInt32LE(pixels[i], 8 + i * 4);
	}

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
	writeEntry(258, 3, 1, 32);                 // BitsPerSample (SHORT)
	writeEntry(259, 3, 1, 1);                  // Compression: none
	writeEntry(262, 3, 1, 1);                  // Photometric: MinIsBlack
	writeEntry(273, 4, 1, 8);                  // StripOffsets (LONG)
	writeEntry(277, 3, 1, 1);                  // SamplesPerPixel
	writeEntry(278, 3, 1, height);             // RowsPerStrip
	writeEntry(279, 4, 1, pixelBytes);         // StripByteCounts (LONG)
	writeEntry(339, 3, 1, 1);                  // SampleFormat: unsigned int
	buf.writeUInt32LE(0, entry);               // next IFD: none

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

	const { TiffProcessor, tiffTypeMax, tiffFormatTypeFor, tiffNeedsFloatCarrier } = await import(
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

	// Wide (>16-bit) unsigned integer: its own routing key ('tiff-int-wide'),
	// full-range typeMax of 2^32-1, and a Float32Array carrier requirement
	// (tiffNeedsFloatCarrier) alongside signed int and float.
	assert.strictEqual(tiffTypeMax(1, 32), 4294967295);
	assert.strictEqual(tiffFormatTypeFor(1, 8), 'tiff-int', '<=16-bit unsigned stays tiff-int regardless of bitsPerSample param');
	assert.strictEqual(tiffFormatTypeFor(1, 16), 'tiff-int', '16-bit unsigned is not "wide"');
	assert.strictEqual(tiffFormatTypeFor(1, 32), 'tiff-int-wide');
	assert.strictEqual(tiffFormatTypeFor(1), 'tiff-int', 'bitsPerSample omitted defaults to the non-wide bucket');
	assert.strictEqual(tiffFormatTypeFor(2, 32), 'tiff-int-signed', 'signed always wins over wide, regardless of bit depth');
	assert.strictEqual(tiffFormatTypeFor(3, 32), 'tiff-float', 'float always wins over wide, regardless of bit depth');
	assert.strictEqual(tiffNeedsFloatCarrier(1, 8), false);
	assert.strictEqual(tiffNeedsFloatCarrier(1, 16), false);
	assert.strictEqual(tiffNeedsFloatCarrier(1, 32), true, 'unsigned >16-bit needs a Float32Array carrier');
	assert.strictEqual(tiffNeedsFloatCarrier(2, 16), true, 'signed always needs a Float32Array carrier');
	assert.strictEqual(tiffNeedsFloatCarrier(3, 32), true, 'float always needs a Float32Array carrier');
	console.log('✅ tiffTypeMax / tiffFormatTypeFor / tiffNeedsFloatCarrier: wide (>16-bit) unsigned int → tiff-int-wide, Float32Array carrier');

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

	// --- 4. Wide unsigned integer (uint32) via the geotiff.js path --------
	{
		const synthetic = makeUint32Tiff();
		syntheticFiles.set(syntheticUint32Path, synthetic.buffer);

		/** @type {any[]} */
		const messages = [];
		const vscodeStub = { postMessage: (msg) => messages.push(msg) };
		const p = makeProcessor(TiffProcessor, autoNormalizeSettings, vscodeStub);
		await p.processTiff(syntheticUint32Path);

		// Wide unsigned int must be routed to the 'tiff-int-wide' per-format
		// settings key (auto-normalize defaults), not gamma-mode 'tiff-int' -
		// gamma mode's full [0, 2^32-1] range would render this data black.
		const formatInfo = messages.find(m => m.type === 'formatInfo');
		assert.ok(formatInfo, 'formatInfo must be posted on initial load');
		assert.strictEqual(formatInfo.value.formatType, 'tiff-int-wide');
		assert.strictEqual(formatInfo.value.sampleFormat, 1);
		assert.strictEqual(formatInfo.value.bitsPerSample, 32);
		console.log('✅ Wide uint32: formatType is tiff-int-wide');

		// Values above 65535 must survive in the Float32Array carrier (a
		// Uint16Array carrier would wrap 70000 mod 65536 to 4464).
		const data = p.rawTiffData.data;
		assert.ok(data instanceof Float32Array,
			`wide unsigned samples need a Float32Array carrier, got ${data.constructor.name}`);
		assert.deepStrictEqual(Array.from(data), synthetic.pixels,
			'uint32 pixel values must survive decode + interleave exactly');
		console.log('✅ Wide uint32: Float32Array carrier, values above 65535 intact (no 16-bit wrap)');

		const imageData = await p.performDeferredRender();
		assert.deepStrictEqual(p._lastStatistics, { min: 0, max: 4294967040 },
			'auto-normalize stats must reflect the true uint32 data range');

		// Rendered intensities: max value (4294967040) maps to 255, the
		// minimum (0) to 0.
		const intensityAt = (i) => imageData.data[i * 4];
		assert.strictEqual(intensityAt(8), 255, 'max uint32 value renders full white');
		assert.strictEqual(intensityAt(0), 0, 'zero value renders black');
		console.log('✅ Wide uint32: auto-normalize stats span the true data range, renders correctly');

		// Pixel inspection keeps plain integer formatting (no decimals).
		assert.strictEqual(p.getColorAtPixel(1, 1, synthetic.width, synthetic.height), '70000');
		assert.strictEqual(p.getColorAtPixel(0, 2, synthetic.width, synthetic.height), '4294967040');
		console.log('✅ Wide uint32: pixel inspection shows plain integers');
	}

	// --- 5. Wide unsigned integer (uint32) via the WASM decoder path ------
	// Mirrors section 3 (signed int16 via WASM): the Rust decoder returns the
	// wide unsigned samples as interleaved Float32 data directly (see
	// wasm/tiff-decoder/src/lib.rs's get_data_as_f32 32-bit branch), and the
	// processor must reuse that Float32Array as-is rather than re-interleaving
	// it into a Uint16Array (which would wrap every value above 65535).
	{
		const synthetic = makeUint32Tiff();
		const wasmResult = {
			width: synthetic.width,
			height: synthetic.height,
			channels: 1,
			bitsPerSample: 32,
			sampleFormat: 1,
			compression: 1,
			predictor: 1,
			photometricInterpretation: 1,
			planarConfiguration: 1,
			data: new Float32Array(synthetic.pixels),
			min: 0,
			max: 4294967040,
			allTagsJson: '[]',
			decodedWith: 'wasm (stub)',
		};
		wasmResult.rasters = [wasmResult.data];

		const p = makeProcessor(TiffProcessor, autoNormalizeSettings);
		p._wasmAvailable = true;
		p._wasmProcessor = { init: async () => true, decode: async () => wasmResult };
		syntheticFiles.set(syntheticUint32Path, synthetic.buffer);
		const { imageData } = await p.processTiff(syntheticUint32Path);

		assert.strictEqual(p.rawTiffData.data, wasmResult.data,
			'the WASM path must keep the decoded Float32Array as the stored carrier');
		assert.strictEqual(imageData.data[8 * 4], 255, 'max uint32 value renders full white');
		assert.strictEqual(imageData.data[0], 0, 'zero value renders black');
		assert.strictEqual(p.getColorAtPixel(1, 1, synthetic.width, synthetic.height), '70000');
		console.log('✅ Wide uint32 (WASM path): Float32 data reused as-is, no 16-bit wrap');
	}

	console.log('\n🎉 All TIFF sample-format tests passed.\n');
}

main().catch(err => {
	console.error('❌ TIFF sample-format test failed:');
	console.error(err);
	process.exit(1);
});
