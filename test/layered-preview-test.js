'use strict';

const assert = require('assert');
const path = require('path');
const { zipSync, strToU8 } = require('fflate');
const UPNG = require('upng-js');
const { writePsd } = require('ag-psd');
const pako = require('pako');

function rgbaPng(width, height, rgba) {
	const pixels = new Uint8Array(width * height * 4);
	for (let i = 0; i < width * height; i++) { pixels.set(rgba, i * 4); }
	return pixelPng(width, height, pixels);
}

function pixelPng(width, height, pixels) {
	const encoded = new Uint8Array(UPNG.encode([pixels.buffer], width, height, 0));
	// upng-js omits the optional-to-its-own-decoder IEND CRC; embedded-file
	// scanners need a structurally complete PNG stream.
	const complete = new Uint8Array(encoded.length + 4);
	complete.set(encoded);
	complete.set([0xae, 0x42, 0x60, 0x82], encoded.length);
	return complete;
}

function asArrayBuffer(bytes) {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function buildMinimalXcf(compression = 0) {
	const bytes = [];
	const labels = new Map();
	const patches = [];
	const raw = values => bytes.push(...values);
	const u32 = value => bytes.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
	const pointer = label => { patches.push({ offset: bytes.length, label }); u32(0); };
	const label = name => labels.set(name, bytes.length);
	const string = value => { const encoded = Buffer.from(`${value}\0`); u32(encoded.length); raw(encoded); };
	const prop = (type, values) => { u32(type); u32(values.length); raw(values); };
	const propU32 = (type, value) => { u32(type); u32(4); u32(value); };
	const endProps = () => { u32(0); u32(0); };

	raw(Buffer.from('gimp xcf file\0'));
	u32(2); u32(1); u32(0); // canvas and RGB base type
	prop(17, [compression]);
	endProps();
	pointer('layer'); u32(0); // layer pointer list
	u32(0); // empty channel pointer list

	label('layer');
	u32(2); u32(1); u32(1); string('Synthetic RGBA');
	propU32(6, 255); propU32(8, 1); propU32(7, 0); endProps();
	pointer('hierarchy'); u32(0);

	label('hierarchy');
	u32(2); u32(1); u32(4); pointer('level'); u32(0);
	label('level');
	u32(2); u32(1); pointer('tile'); u32(0);
	label('tile');
	const pixels = [255, 0, 0, 255, 0, 255, 0, 128];
	if (compression === 0) { raw(pixels); }
	else if (compression === 1) { raw([254, 255, 0, 254, 0, 255, 254, 0, 0, 254, 255, 128]); }
	else if (compression === 2) { raw(pako.deflate(Uint8Array.from(pixels))); }

	for (const patch of patches) {
		const value = labels.get(patch.label);
		if (value === undefined) { throw new Error(`Missing XCF label ${patch.label}`); }
		bytes[patch.offset] = (value >>> 24) & 255;
		bytes[patch.offset + 1] = (value >>> 16) & 255;
		bytes[patch.offset + 2] = (value >>> 8) & 255;
		bytes[patch.offset + 3] = value & 255;
	}
	return Uint8Array.from(bytes);
}

async function main() {
	const decoderPath = path.join(__dirname, '..', 'out', 'media', 'modules', 'layered-preview-decoders.js');
	const { decodeLayeredPreview } = await import(decoderPath);
	const png = rgbaPng(2, 1, [12, 34, 56, 255]);

	const ora = zipSync({
		'mimetype': strToU8('image/openraster'),
		'mergedimage.png': png,
		'stack.xml': strToU8('<image w="2" h="1"><stack><stack name="Group"><layer name="Pixels" src="data/layer0.png"/></stack></stack></image>'),
		'data/layer0.png': png,
	});
	const oraResult = decodeLayeredPreview('ora', asArrayBuffer(ora));
	assert.deepStrictEqual([oraResult.width, oraResult.height, oraResult.document.layerCount], [2, 1, 1]);
	assert.strictEqual(oraResult.document.previewIsAuthoritative, true);
	assert.strictEqual(oraResult.document.root[0].name, 'Group');
	assert.strictEqual(oraResult.document.root[0].children[0].name, 'Pixels');
	assert.strictEqual(oraResult.layerAssets[0].groupPath[0], 'Group');
	assert.strictEqual(oraResult.layerAssets[0].groupIds.length, 1);
	assert.strictEqual(oraResult.layerAssets[0].support, 'native');
	assert.deepStrictEqual(Array.from(oraResult.reconstructedData), Array.from(oraResult.integratedData));
	assert.strictEqual(oraResult.document.reconstruction.differentPixelRatio, 0);

	const groupedMerged = rgbaPng(2, 1, [64, 64, 0, 255]);
	const groupedOra = zipSync({
		'mimetype': strToU8('image/openraster'),
		'mergedimage.png': groupedMerged,
		'stack.xml': strToU8('<image w="2" h="1"><stack><stack name="Half" opacity="0.5"><layer name="Green" src="data/green.png"/><layer name="Red" src="data/red.png"/></stack><layer name="Background" src="data/black.png"/></stack></image>'),
		'data/green.png': rgbaPng(2, 1, [0, 255, 0, 128]),
		'data/red.png': rgbaPng(2, 1, [255, 0, 0, 255]),
		'data/black.png': rgbaPng(2, 1, [0, 0, 0, 255]),
	});
	const grouped = decodeLayeredPreview('ora', asArrayBuffer(groupedOra));
	assert.deepStrictEqual(Array.from(grouped.reconstructedData), [64, 64, 0, 255, 64, 64, 0, 255], 'group opacity uses an isolated group surface');
	assert.strictEqual(grouped.document.reconstruction.differentPixelRatio, 0);

	const kra = zipSync({
		'mimetype': strToU8('application/x-krita'),
		'mergedimage.png': png,
		'maindoc.xml': strToU8('<DOC><IMAGE width="2" height="1"><layer name="Pixels"/></IMAGE></DOC>'),
	});
	const kraResult = decodeLayeredPreview('kra', asArrayBuffer(kra));
	assert.deepStrictEqual([kraResult.width, kraResult.height, kraResult.document.layerCount], [2, 1, 1]);

	const affinityBytes = new Uint8Array(8 + png.length);
	affinityBytes.set([0, 255, 75, 65], 0);
	affinityBytes.set(png, 8);
	const affinity = decodeLayeredPreview('affinity', affinityBytes.buffer);
	assert.deepStrictEqual([affinity.width, affinity.height], [2, 1]);
	assert.strictEqual(affinity.document.previewIsAuthoritative, false);

	const imageData = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]) };
	const psdBytes = new Uint8Array(writePsd({ width: 2, height: 1, imageData, children: [{ name: 'Pixels', left: 0, top: 0, imageData }] }));
	const psd = decodeLayeredPreview('psd', asArrayBuffer(psdBytes));
	assert.deepStrictEqual([psd.width, psd.height, psd.document.layerCount], [2, 1, 1]);
	assert.strictEqual(psd.document.previewIsAuthoritative, true);
	const psbBytes = new Uint8Array(writePsd({ width: 2, height: 1, imageData, children: [{ name: 'Pixels', left: 0, top: 0, imageData }] }, { psb: true }));
	const psb = decodeLayeredPreview('psb', asArrayBuffer(psbBytes));
	assert.deepStrictEqual([psb.width, psb.height, psb.document.layerCount], [2, 1, 1]);
	assert.strictEqual(psb.formatType, 'psb');

	for (const compression of [0, 1, 2]) {
		const xcf = decodeLayeredPreview('xcf', asArrayBuffer(buildMinimalXcf(compression)));
		assert.deepStrictEqual([xcf.width, xcf.height, xcf.document.layerCount], [2, 1, 1]);
		assert.deepStrictEqual(Array.from(xcf.data.slice(0, 4)), [255, 0, 0, 255]);
		assert.deepStrictEqual(Array.from(xcf.data.slice(4, 8)), [0, 255, 0, 128]);
		assert.strictEqual(xcf.document.previewKind, 'reconstructed');
		assert.strictEqual(xcf.layerAssets.length, 1);
		assert.deepStrictEqual(Array.from(xcf.layerAssets[0].data.slice(4, 8)), [0, 255, 0, 128]);
		assert.strictEqual(xcf.layerAssets[0].support, 'native');
	}

	console.log('Layered preview decoders passed: ORA, KRA, PSD/PSB, XCF, and Affinity.');
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
