'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const parserPath = path.join(__dirname, '..', 'out', 'media', 'modules', 'scientific-format-parsers.js');
if (!fs.existsSync(parserPath)) {
	throw new Error('Compile first with npm run compile');
}
const { extractDicomJpegFrame, parseFits, parseDicom, parseNetCdf } = require(parserPath);
const fixtures = path.join(__dirname, '..', 'test-samples', 'scientific');

function arrayBuffer(file) {
	const bytes = fs.readFileSync(path.join(fixtures, file));
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function testFits() {
	const image = parseFits(arrayBuffer('synthetic-gradient.fits'));
	assert.deepStrictEqual([image.width, image.height, image.channels], [32, 24, 1]);
	assert.strictEqual(image.metadata.bitpix, 16);
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
}

async function testJpegBaselineDicom() {
	const fixture = '/Users/florian/Projects/cursor/test_data/testfiles/MRI/0002.DCM';
	if (!fs.existsSync(fixture)) { return; }
	const bytes = fs.readFileSync(fixture);
	const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	const first = extractDicomJpegFrame(buffer, 0);
	const last = extractDicomJpegFrame(buffer, 95);
	assert.deepStrictEqual([first.width, first.height, first.channels], [512, 512, 1]);
	assert.strictEqual(first.metadata.frames, 96);
	assert.strictEqual(first.metadata.rescaleSlope, 1, 'missing RescaleSlope must default to identity');
	assert.strictEqual(first.metadata.rescaleIntercept, 0);
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
	assert.ok(Math.abs(image.data[0] - 273.15) < 0.001);
	assert.ok(Math.abs(image.data[767] - 287.75) < 0.001);
}

async function main() {
	console.log('Running FITS/DICOM/NetCDF parser tests...');
	testFits();
	testDicom();
	await testJpegBaselineDicom();
	testNetCdf();
	console.log('FITS, DICOM, and NetCDF parser tests passed.');
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
