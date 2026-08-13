'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// FITS, DICOM, NetCDF and CZI are decoded by Rust/WASM only — their
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
	assert.deepStrictEqual(image.metadata.selectors, [
		{ name: 'C', size: 2, value: 0 },
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

async function main() {
	console.log('Running FITS/DICOM/NetCDF/CZI parser tests...');
	await initWasm();
	testFits();
	testDicom();
	await testJpegBaselineDicom();
	testNetCdf();
	testCzi();
	testMpasNetCdf();
	console.log('FITS, DICOM, NetCDF, and CZI parser tests passed.');
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
