'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildDicom, dcmPixelSamples } = require('./lib/decoder-cases');

// FITS, DICOM, NetCDF, CZI, ND2 and LIF are decoded by Rust/WASM only — their
// TypeScript parsers have all been deleted. These tests assert format
// semantics (row order, numeric domain, mesh projection, mosaic assembly)
// rather than parity, so they now drive the wasm decoders directly. Broader
// coverage lives in test/rust-scientific-conformance-test.js.
let wasm = null;
async function initWasm() {
	if (wasm) { return wasm; }
	const wasmJs = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.js');
	const wasmBin = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.wasm');
	wasm = await import(wasmJs.replace(/\\/g, '/'));
	await wasm.default({ module_or_path: fs.readFileSync(wasmBin) });
	return wasm;
}

/** Mirrors the worker's `scientificResultToDecoded`. `take_data_as_f32()` is
 * destructive, so it is called exactly once here. */
function toDecoded(result) {
	return {
		width: result.width,
		height: result.height,
		channels: result.channels,
		data: result.take_data_as_f32(),
		metadata: JSON.parse(result.metadata_json),
		numericDomain: {
			bitsPerSample: result.bits_per_sample,
			sampleFormat: result.sample_format,
			typeMin: result.type_min,
			typeMax: result.type_max,
			sourceNumericType: result.source_numeric_type,
		},
	};
}
const parseFits = (buf) => toDecoded(wasm.decode_fits_fast(new Uint8Array(buf)));
const parseDicom = (buf, frameIndex = 0) => toDecoded(wasm.decode_dicom_fast(new Uint8Array(buf), frameIndex >>> 0));
const parseNetCdf = (buf, options = {}) => toDecoded(wasm.decode_netcdf_fast(new Uint8Array(buf), JSON.stringify(options)));
const parseCzi = (buf, options = {}) => toDecoded(wasm.decode_czi_fast(new Uint8Array(buf), JSON.stringify(options)));
const parseNd2 = (buf, options = {}) => toDecoded(wasm.decode_nd2_fast(new Uint8Array(buf), JSON.stringify(options)));
const parseLif = (buf, options = {}) => toDecoded(wasm.decode_lif_fast(new Uint8Array(buf), JSON.stringify(options)));
const fixtures = path.join(__dirname, '..', 'test-samples', 'scientific');

function arrayBuffer(file) {
	const bytes = fs.readFileSync(path.join(fixtures, file));
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function testFits() {
	const image = parseFits(arrayBuffer('synthetic-gradient.fits'));
	assert.deepStrictEqual([image.width, image.height, image.channels], [32, 24, 1]);
	assert.strictEqual(image.metadata.bitpix, 16);
	assert.deepStrictEqual(image.numericDomain, {
		bitsPerSample: 16, sampleFormat: 2,
		typeMin: -16484, typeMax: 16283.5, sourceNumericType: 'int16',
	});
	assert.strictEqual(image.data[0], -100 + 0.5 * 2300, 'FITS rows should be displayed top-down');
	assert.strictEqual(image.data[23 * 32], -100, 'FITS bottom row should contain the first stored row');
}

function testDicom() {
	const image = parseDicom(arrayBuffer('synthetic-ct.dcm'));
	assert.deepStrictEqual([image.width, image.height, image.channels], [32, 24, 1]);
	assert.strictEqual(image.metadata.transferSyntax, '1.2.840.10008.1.2.1');
	assert.strictEqual(image.data[0], -1024);
	assert.strictEqual(image.data[767], -257);
	assert.strictEqual(image.metadata.windowCenter, -640);
	assert.deepStrictEqual(image.numericDomain, {
		bitsPerSample: 12, sampleFormat: 1,
		typeMin: -1024, typeMax: 3071, sourceNumericType: 'uint16',
	}, 'the Float32 decode carrier must retain the DICOM source domain');
}

function testDicomFrameLabels() {
	const labels = Buffer.from('Series 4\\Series 4\\Series 6\\Series 6', 'latin1');
	const paddedLabels = labels.length % 2 === 0 ? labels : Buffer.concat([labels, Buffer.from(' ')]);
	const bytes = buildDicom({
		explicit: true, little: true, rows: 1, columns: 1, frames: 4,
		bitsAllocated: 16, bitsStored: 12, signed: 0,
		photometric: 'MONOCHROME2', pixelDataVR: 'OW',
		pixelBytes: dcmPixelSamples([1, 2, 3, 4], 16, true),
		extraElements: [[0x0018, 0x2002, 'SH', paddedLabels]],
	});
	const image = parseDicom(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
	assert.deepStrictEqual(image.metadata.frameLabels, ['Series 4', 'Series 4', 'Series 6', 'Series 6']);
}

/** Every compressed transfer syntax must decode to the SAME samples as the
 * uncompressed twin. The fixtures are written by scripts/make-dicom-testdata.py
 * and all hold identical pixels, so any difference here is a decoder bug rather
 * than a property of the file.
 *
 * JPEG 2000, JPEG-LS and lossless JPEG are decoded from the encapsulated
 * fragments by pure-Rust crates — `dicom-pixeldata`'s own adapters for the
 * first two are C libraries that do not build for WebAssembly. Deflated
 * Explicit VR is inflated before parsing, and RLE and JPEG Baseline still go
 * through dicom-pixeldata. */
function testDicomTransferSyntaxes() {
	const reference = parseDicom(arrayBuffer('synthetic-ct-codec-ref.dcm'));
	assert.deepStrictEqual([reference.width, reference.height, reference.channels], [64, 48, 1]);

	for (const [file, syntax, label] of [
		['synthetic-ct-deflated.dcm', '1.2.840.10008.1.2.1.99', 'Deflated Explicit VR'],
		['synthetic-ct-jpeg2000.dcm', '1.2.840.10008.1.2.4.90', 'JPEG 2000 Lossless'],
		['synthetic-ct-jpegls.dcm', '1.2.840.10008.1.2.4.80', 'JPEG-LS Lossless'],
		['synthetic-ct-jpeglossless.dcm', '1.2.840.10008.1.2.4.70', 'JPEG Lossless SV1'],
		['synthetic-ct-rle.dcm', '1.2.840.10008.1.2.5', 'RLE Lossless'],
	]) {
		const image = parseDicom(arrayBuffer(file));
		assert.strictEqual(image.metadata.transferSyntax, syntax, `${label}: transfer syntax`);
		assert.deepStrictEqual(
			[image.width, image.height, image.channels],
			[reference.width, reference.height, reference.channels],
			`${label}: geometry`,
		);
		assert.deepStrictEqual(Array.from(image.data), Array.from(reference.data),
			`${label} must decode to the same samples as the uncompressed twin`);
		console.log(`  ✅ ${label} matches the uncompressed twin exactly`);
	}

	// A lossless-JPEG predictor the decoder reproduces incorrectly must be
	// REFUSED, not returned as a plausible-looking wrong image. Predictor 6 is
	// one of the two it gets wrong; the error has to name it.
	assert.throws(
		() => parseDicom(arrayBuffer('synthetic-ct-jpeglossless-predictor6.dcm')),
		/predictor 6 is not supported/,
		'an unsupported lossless-JPEG predictor must fail loudly',
	);
	console.log('  ✅ Lossless JPEG with an unsupported predictor is refused, not mis-decoded');
}

/** `decode_dicom_fast` decodes JPEG Baseline Pixel Data natively now (via
 * dicom-object/dicom-pixeldata in Rust) instead of throwing the
 * `requires codec: jpeg-baseline` error that used to route through the
 * TS `extractDicomJpegFrame` + shared zune-jpeg fallback (both deleted).
 * This asserts the same real 96-frame fixture decodes directly. */
async function testJpegBaselineDicom() {
	const fixture = '/Users/florian/Projects/cursor/test_data/testfiles/scientific/0002.DCM';
	if (!fs.existsSync(fixture)) { return; }
	const bytes = fs.readFileSync(fixture);
	const wasmMod = await initWasm();

	const first = wasmMod.decode_dicom_fast(new Uint8Array(bytes), 0);
	const firstData = first.take_data_as_f32();
	const firstMeta = JSON.parse(first.metadata_json);
	assert.deepStrictEqual([first.width, first.height, first.channels], [512, 512, 1]);
	assert.strictEqual(firstMeta.frames, 96);
	assert.strictEqual(firstMeta.frameIndex, 0);
	assert.strictEqual(firstMeta.rescaleSlope, 1, 'missing RescaleSlope must default to identity');
	assert.strictEqual(firstMeta.rescaleIntercept, 0);
	assert.strictEqual(first.type_max, (2 ** first.bits_per_sample) - 1);
	assert.strictEqual(firstMeta.windowCenter, null, 'missing WindowCenter must remain unspecified');
	assert.strictEqual(firstMeta.windowWidth, null, 'missing WindowWidth must remain unspecified');
	assert.strictEqual(firstData.length, 512 * 512);

	const last = wasmMod.decode_dicom_fast(new Uint8Array(bytes), 95);
	const lastData = last.take_data_as_f32();
	const lastMeta = JSON.parse(last.metadata_json);
	assert.deepStrictEqual([last.width, last.height, last.channels], [512, 512, 1]);
	assert.strictEqual(lastMeta.frameIndex, 95);
	assert.notStrictEqual(Buffer.compare(Buffer.from(firstData.buffer), Buffer.from(lastData.buffer)), 0,
		'frame 0 and frame 95 must decode to different pixel data');

	console.log('✅ Real 96-frame JPEG Baseline DICOM decodes first/last frames natively via decode_dicom_fast');
}

function testNetCdf() {
	const image = parseNetCdf(arrayBuffer('synthetic-temperature.nc'));
	assert.deepStrictEqual([image.width, image.height, image.channels], [32, 24, 1]);
	assert.strictEqual(image.metadata.variable, 'temperature');
	assert.strictEqual(image.numericDomain.sampleFormat, 3);
	assert.ok(Math.abs(image.data[0] - 273.15) < 0.001);
	assert.ok(Math.abs(image.data[767] - 287.75) < 0.001);
}

function testMpasNetCdf() {
	const fixture = '/Users/florian/Projects/cursor/test_data/testfiles/scientific/x16.2562.grid.nc';
	if (!fs.existsSync(fixture)) { return; }
	const bytes = fs.readFileSync(fixture);
	const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	const mesh = parseNetCdf(buffer);
	assert.deepStrictEqual([mesh.width, mesh.height, mesh.channels], [720, 360, 1]);
	assert.strictEqual(mesh.metadata.viewMode, 'mpas-mesh');
	// The default must be a simulated field, not the mesh it lives on. MPAS
	// stores geometry (areaCell, latCell, indexToCellID, ...) beside the model
	// output under the same nCells dimension, and the geometry comes first in
	// file order — so an unguarded "first variable" default opens an ocean
	// model showing cell areas in m^2.
	assert.strictEqual(mesh.metadata.variable, 'h',
		'should default to a time-varying field rather than mesh geometry');
	assert.ok(!mesh.metadata.variable.endsWith('Cell'),
		'mesh geometry must never be the default variable');
	assert.deepStrictEqual(mesh.metadata.variables.map(variable => variable.name), ['areaCell', 'h_s', 'h', 'ke', 'tracers'],
		'every nCells variable stays selectable, including the geometry');
	const finite = Array.from(mesh.data).filter(Number.isFinite);
	assert.ok(finite.length > 200000, 'MPAS polygons should cover most projection pixels');
	const range = finite.reduce((current, value) => ({ min: Math.min(current.min, value), max: Math.max(current.max, value) }), { min: Infinity, max: -Infinity });
	assert.ok(range.min > 0 && range.max >= range.min);

	const field = parseNetCdf(buffer, { variableName: 'h', indices: { Time: 0, nVertLevels: 0 } });
	assert.strictEqual(field.metadata.variable, 'h');
	assert.deepStrictEqual(field.metadata.selectors.map(selector => selector.name), ['Time', 'nVertLevels']);
	assert.ok(Array.from(field.data).some(value => value === 1000));
	console.log('✅ Real MPAS NetCDF: variable selection and nCells mesh projection');
}


function testCzi() {
	const buffer = arrayBuffer('synthetic-stack.czi');
	const image = parseCzi(buffer);
	// Two 16px tiles blitted side by side into one 32px-wide plane.
	assert.deepStrictEqual([image.width, image.height, image.channels], [32, 24, 1]);
	assert.strictEqual(image.metadata.pixelTypeName, 'Gray8');
	assert.strictEqual(image.metadata.tileCount, 2, 'both mosaic tiles should be assembled');
	assert.strictEqual(image.metadata.subBlockCount, 12);
	assert.deepStrictEqual(image.numericDomain, {
		bitsPerSample: 8, sampleFormat: 1,
		typeMin: 0, typeMax: 255, sourceNumericType: 'uint8',
	});
	// Pixel value is (tileOffset + x + z * 40 + c * 100); Z=0, C=0 here.
	assert.strictEqual(image.data[0], 0);
	assert.strictEqual(image.data[15], 15);
	assert.strictEqual(image.data[16], 16, 'second tile should start at x=16');
	assert.strictEqual(image.data[31], 31);

	// Selectors expose only the axes with more than one coordinate; M is a
	// mosaic axis and must not be offered as a plane selector.
	//
	// A selector carries `labels` when the FILE names its options, and omits
	// them when it does not. That single fact is what the viewer uses to decide
	// dropdown versus slider, for every format — so the presence of names here
	// is part of the decoder's contract, not a display detail.
	assert.deepStrictEqual(image.metadata.selectors, [
		{ name: 'C', size: 2, value: 0, labels: ['DAPI', 'GFP'] },
		{ name: 'Z', size: 3, value: 0 },
	]);
	assert.deepStrictEqual(image.metadata.channelNames, ['DAPI', 'GFP']);
	assert.strictEqual(image.metadata.channelName, 'DAPI');
	assert.ok(Math.abs(image.metadata.scalingXUm - 0.1) < 1e-9);
	assert.ok(Math.abs(image.metadata.scalingZUm - 0.5) < 1e-9);

	const plane = parseCzi(buffer, { indices: { Z: 2, C: 1 } });
	assert.strictEqual(plane.data[0], 2 * 40 + 100);
	assert.strictEqual(plane.metadata.channelName, 'GFP');
	assert.strictEqual(plane.metadata.selectors.find(s => s.name === 'Z').value, 2);

	// Out-of-range coordinates clamp instead of throwing.
	const clamped = parseCzi(buffer, { indices: { Z: 99 } });
	assert.strictEqual(clamped.metadata.selectors.find(s => s.name === 'Z').value, 2);

	assert.throws(() => parseCzi(new Uint8Array(64).buffer), /Invalid CZI signature/);
	console.log('✅ CZI: mosaic assembly, Z/C plane selection, channel names, scaling');
}


/**
 * `synthetic-stack.nd2` is 4x3, uint16, 2 channels, 2 timepoints x 3 Z, with
 * each sample encoding its own coordinate as `1000*frame + 100*channel +
 * 10*y + x`. Rows are padded by two bytes so that a decoder ignoring
 * `uiWidthBytes` shears the image instead of quietly passing.
 */
function testNd2() {
	const buffer = arrayBuffer('synthetic-stack.nd2');

	const first = parseNd2(buffer);
	assert.deepStrictEqual([first.width, first.height, first.channels], [4, 3, 1],
		'a multi-channel fluorescence ND2 yields one plane at a time');
	assert.strictEqual(first.metadata.format, 'ND2');
	assert.strictEqual(first.metadata.pixelTypeName, 'uint16');
	assert.deepStrictEqual(first.numericDomain, {
		bitsPerSample: 16, sampleFormat: 1,
		typeMin: 0, typeMax: 65535, sourceNumericType: 'uint16',
	});
	// Row padding: without honouring uiWidthBytes, row 1 would start mid-row.
	assert.strictEqual(first.data[0], 0, 'pixel (0,0) of frame 0 channel 0');
	assert.strictEqual(first.data[3], 3, 'pixel (3,0) follows x');
	assert.strictEqual(first.data[4], 10, 'row 1 starts after the padded stride');
	assert.strictEqual(first.data[11], 23, 'last pixel is (3,2)');

	// The time loop is declared (2); the Z loop of 3 is not, and has to be
	// recovered as the leftover factor of the 6 stored frames.
	const axes = Object.fromEntries(first.metadata.selectors.map(s => [s.name, s.size]));
	assert.deepStrictEqual(axes, { T: 2, P: 3, C: 2 },
		'the undeclared inner loop is recovered from the frame count');

	// Frame index is the mixed radix of the axes: T=1,P=2 -> frame 1*3+2 = 5.
	const late = parseNd2(buffer, { indices: { T: 1, P: 2, C: 1 } });
	assert.strictEqual(late.data[0], 5 * 1000 + 100, 'T/P flatten to the right frame');
	assert.strictEqual(late.data[11], 5 * 1000 + 100 + 23);

	// Channels are independent measurements, so C selects rather than composites.
	const second = parseNd2(buffer, { indices: { C: 1 } });
	assert.strictEqual(second.data[0], 100, 'channel 1 of frame 0');

	// Out-of-range coordinates clamp instead of throwing, because the slider
	// can outrun a reload.
	const clamped = parseNd2(buffer, { indices: { T: 99, P: 99, C: 99 } });
	assert.strictEqual(clamped.data[0], 5 * 1000 + 100, 'coordinates clamp to the last plane');

	assert.strictEqual(Math.round(first.metadata.scalingXUm * 100) / 100, 0.25,
		'calibration is reported in micrometres per pixel');

	// A legacy container must be named as such, not called corrupt.
	const legacy = new Uint8Array(64);
	assert.throws(() => wasm.decode_nd2_fast(legacy, '{}'), /legacy/i,
		'a non-chunk ND2 reports that it is a legacy file');
}

/**
 * `synthetic-stack.lif` is 4x3, uint16, 2 channels, 2 Z, one series, with each
 * sample encoding `1000*channel + 100*z + 10*y + x`. It exercises the
 * stride-driven addressing: channels are separated by a whole volume, so a
 * decoder assuming interleaved samples reads the wrong plane entirely.
 */
function testLif() {
	const buffer = arrayBuffer('synthetic-stack.lif');

	const first = parseLif(buffer);
	assert.deepStrictEqual([first.width, first.height, first.channels], [4, 3, 1]);
	assert.strictEqual(first.metadata.format, 'LIF');
	assert.strictEqual(first.metadata.seriesName, 'SeriesA');
	assert.strictEqual(first.metadata.seriesCount, 1);
	assert.deepStrictEqual(first.numericDomain, {
		bitsPerSample: 16, sampleFormat: 1,
		typeMin: 0, typeMax: 65535, sourceNumericType: 'uint16',
	});
	assert.strictEqual(first.data[0], 0);
	assert.strictEqual(first.data[3], 3);
	assert.strictEqual(first.data[4], 10, 'row stride comes from the Y BytesInc');
	assert.strictEqual(first.data[11], 23);

	const axes = Object.fromEntries(first.metadata.selectors.map(s => [s.name, s.size]));
	assert.deepStrictEqual(axes, { Z: 2, C: 2 },
		'a single-series file offers no series selector');

	const z1 = parseLif(buffer, { indices: { Z: 1 } });
	assert.strictEqual(z1.data[0], 100, 'Z steps by its own BytesInc');

	// The planar channel layout is the point: channel 1 lives a whole volume
	// further into the block, not one sample over.
	const c1 = parseLif(buffer, { indices: { C: 1 } });
	assert.strictEqual(c1.data[0], 1000, 'channel 1 is offset by its BytesInc');
	const both = parseLif(buffer, { indices: { Z: 1, C: 1 } });
	assert.strictEqual(both.data[11], 1000 + 100 + 23);

	assert.deepStrictEqual(first.metadata.channelNames, ['Ch0', 'Ch1']);

	const bad = new Uint8Array(64);
	assert.throws(() => wasm.decode_lif_fast(bad, '{}'), /LIF/i);
}

async function main() {
	console.log('Running FITS/DICOM/NetCDF/CZI/ND2/LIF parser tests...');
	await initWasm();
	testFits();
	testDicom();
	testDicomFrameLabels();
	testDicomTransferSyntaxes();
	await testJpegBaselineDicom();
	testNetCdf();
	testCzi();
	testNd2();
	testLif();
	testMpasNetCdf();
	console.log('FITS, DICOM, NetCDF, CZI, ND2 and LIF parser tests passed.');
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
