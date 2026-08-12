'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const parserPath = path.join(__dirname, '..', 'out', 'media', 'modules', 'scientific-format-parsers.js');
if (!fs.existsSync(parserPath)) {
	throw new Error('Compile first with npm run compile');
}
const { extractDicomJpegFrame, parseFits, parseDicom, parseNetCdf, parseCzi } = require(parserPath);
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

async function testJpegBaselineDicom() {
	const fixture = '/Users/florian/Projects/cursor/test_data/testfiles/scientific/0002.DCM';
	if (!fs.existsSync(fixture)) { return; }
	const bytes = fs.readFileSync(fixture);
	const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	const first = extractDicomJpegFrame(buffer, 0);
	const last = extractDicomJpegFrame(buffer, 95);
	assert.deepStrictEqual([first.width, first.height, first.channels], [512, 512, 1]);
	assert.strictEqual(first.metadata.frames, 96);
	assert.strictEqual(first.metadata.rescaleSlope, 1, 'missing RescaleSlope must default to identity');
	assert.strictEqual(first.metadata.rescaleIntercept, 0);
	assert.strictEqual(first.numericDomain.typeMax, (2 ** first.metadata.bitsStored) - 1);
	assert.ok(Number.isNaN(first.metadata.windowCenter), 'missing WindowCenter must remain unspecified');
	assert.ok(Number.isNaN(first.metadata.windowWidth), 'missing WindowWidth must remain unspecified');
	assert.deepStrictEqual(Array.from(first.encoded.subarray(0, 2)), [0xff, 0xd8]);
	assert.deepStrictEqual(Array.from(last.encoded.subarray(0, 2)), [0xff, 0xd8]);
	assert.notStrictEqual(Buffer.compare(Buffer.from(first.encoded), Buffer.from(last.encoded)), 0);

	const wasmJs = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.js');
	const wasmBin = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.wasm');
	const wasm = await import(wasmJs.replace(/\\/g, '/'));
	await wasm.default({ module_or_path: fs.readFileSync(wasmBin) });
	const decoded = wasm.decode_jpeg_fast(first.encoded);
	assert.deepStrictEqual([decoded.width, decoded.height, decoded.channels], [512, 512, 3]);
	assert.strictEqual(decoded.take_data_as_u8().length, 512 * 512 * 3);
	console.log('✅ Real 96-frame JPEG Baseline DICOM extracts and decodes first/last frames');
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
	assert.strictEqual(mesh.metadata.variable, 'areaCell');
	assert.deepStrictEqual(mesh.metadata.variables.map(variable => variable.name), ['areaCell', 'h_s', 'h', 'ke', 'tracers']);
	const finite = Array.from(mesh.data).filter(Number.isFinite);
	assert.ok(finite.length > 200000, 'MPAS polygons should cover most projection pixels');
	const range = finite.reduce((current, value) => ({ min: Math.min(current.min, value), max: Math.max(current.max, value) }), { min: Infinity, max: -Infinity });
	assert.ok(range.min > 0 && range.max > range.min);

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
