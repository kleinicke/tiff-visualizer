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

function kraPaintDevice(pixelSize, pixels) {
	const pixelCount = 64 * 64;
	const tile = new Uint8Array(pixelCount * pixelSize);
	// Krita's raw and compressed tile payloads are both channel-major.
	for (let source = 0; source < pixels.length; source++) {
		const pixel = Math.floor(source / pixelSize), channel = source % pixelSize;
		tile[channel * pixelCount + pixel] = pixels[source];
	}
	const header = Buffer.from(`VERSION 2\nTILEWIDTH 64\nTILEHEIGHT 64\nPIXELSIZE ${pixelSize}\nDATA 1\n0,0,LZF,${tile.length + 1}\n`);
	return Buffer.concat([header, Buffer.from([0]), Buffer.from(tile)]);
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

function buildEffectXcf() {
	const bytes = [], labels = new Map(), patches = [];
	const raw = values => bytes.push(...values);
	const u32 = value => bytes.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
	const f32 = value => { const data = Buffer.alloc(4); data.writeFloatBE(value); raw(data); };
	const pointer = label => { patches.push({ offset: bytes.length, label }); raw([0, 0, 0, 0, 0, 0, 0, 0]); };
	const zeroPointer = () => raw([0, 0, 0, 0, 0, 0, 0, 0]);
	const label = name => labels.set(name, bytes.length);
	const string = value => { const encoded = Buffer.from(`${value}\0`); u32(encoded.length); raw(encoded); };
	const endProps = () => { u32(0); u32(0); };
	const filterFloat = (name, value) => {
		const payload = [], encoded = Buffer.from(`${name}\0`);
		const pushU32 = number => payload.push((number >>> 24) & 255, (number >>> 16) & 255, (number >>> 8) & 255, number & 255);
		pushU32(encoded.length); payload.push(...encoded); pushU32(3);
		const data = Buffer.alloc(4); data.writeFloatBE(value); payload.push(...data);
		u32(45); u32(payload.length); raw(payload);
	};

	raw(Buffer.from('gimp xcf v020\0'));
	u32(1); u32(1); u32(0); u32(150);
	u32(17); u32(1); raw([0]); endProps();
	pointer('layer'); zeroPointer(); zeroPointer();

	label('layer');
	u32(1); u32(1); u32(1); string('Effect pixels');
	u32(6); u32(4); u32(255); u32(8); u32(4); u32(1); u32(7); u32(4); u32(0); endProps();
	pointer('hierarchy'); zeroPointer(); pointer('effect'); zeroPointer();

	label('effect');
	string('Brightness/Contrast'); string(''); string('gegl:brightness-contrast');
	filterFloat('brightness', 0.25); filterFloat('contrast', 0.5); endProps(); zeroPointer();

	label('hierarchy');
	u32(1); u32(1); u32(4); pointer('level'); zeroPointer();
	label('level');
	u32(1); u32(1); pointer('tile'); zeroPointer();
	label('tile'); raw([64, 64, 64, 255]);

	for (const patch of patches) {
		const value = labels.get(patch.label);
		if (value === undefined) { throw new Error(`Missing XCF label ${patch.label}`); }
		bytes[patch.offset + 4] = (value >>> 24) & 255;
		bytes[patch.offset + 5] = (value >>> 16) & 255;
		bytes[patch.offset + 6] = (value >>> 8) & 255;
		bytes[patch.offset + 7] = value & 255;
	}
	return Uint8Array.from(bytes);
}

async function main() {
	const decoderPath = path.join(__dirname, '..', 'out', 'media', 'modules', 'layered-preview-decoders.js');
	const { decodeLayeredPreview } = await import(decoderPath);
	const writerPath = path.join(__dirname, '..', 'out', 'media', 'modules', 'xcf-writer.js');
	const { writeLayerStackAsXcf } = await import(writerPath);
	const png = rgbaPng(2, 1, [12, 34, 56, 255]);

	const ora = zipSync({
		'mimetype': strToU8('image/openraster'),
		'mergedimage.png': png,
		'stack.xml': strToU8('<image w="2" h="1"><stack><stack name="Group"><layer name="Pixels" src="data/layer0.png"/></stack></stack></image>'),
		'data/layer0.png': png,
	});
	const oraResult = decodeLayeredPreview('ora', asArrayBuffer(ora));
	assert.deepStrictEqual([oraResult.width, oraResult.height, oraResult.document.layerCount], [2, 1, 2]);
	assert.strictEqual(oraResult.document.previewIsAuthoritative, true);
	assert.strictEqual(oraResult.document.root[0].name, 'Group');
	assert.strictEqual(oraResult.document.root[0].children[0].name, 'Pixels');
	assert.strictEqual(oraResult.layerAssets[0].kind, 'group');
	assert.strictEqual(oraResult.layerAssets[1].groupPath[0], 'Group');
	assert.strictEqual(oraResult.layerAssets[1].groupIds.length, 1);
	assert.strictEqual(oraResult.layerAssets[1].parentId, oraResult.layerAssets[0].nodeId);
	assert.strictEqual(oraResult.layerAssets[1].support, 'native');
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

	const kraWithPaint = zipSync({
		'mimetype': strToU8('application/x-krita'),
		'mergedimage.png': png,
		'maindoc.xml': strToU8('<DOC><IMAGE name="Paint Test" colorspacename="RGBA" width="2" height="1"><layers><layer name="Pixels" nodetype="paintlayer" filename="layer2" x="3" y="-2" opacity="255" visible="1" compositeop="multiply"><masks><mask name="Mask" nodetype="transparencymask" filename="mask3" x="1" y="2" visible="1"/></masks></layer></layers></IMAGE></DOC>'),
		'Paint Test/layers/layer2': kraPaintDevice(4, [0, 0, 255, 255, 0, 255, 0, 255]),
		'Paint Test/layers/layer2.defaultpixel': Uint8Array.from([0, 0, 0, 0]),
		'Paint Test/layers/mask3.pixelselection': kraPaintDevice(1, [255, 0]),
		'Paint Test/layers/mask3.pixelselection.defaultpixel': Uint8Array.from([0]),
	});
	const paintedKra = decodeLayeredPreview('kra', asArrayBuffer(kraWithPaint));
	assert.strictEqual(paintedKra.layerAssets.length, 1);
	assert.strictEqual(paintedKra.layerAssets[0].blendMode, 'multiply');
	assert.deepStrictEqual([paintedKra.document.root[0].left, paintedKra.document.root[0].top], [3, -2]);
	assert.deepStrictEqual([paintedKra.layerAssets[0].x, paintedKra.layerAssets[0].y], [0, 0]);
	assert.deepStrictEqual(Array.from(paintedKra.layerAssets[0].data.slice(0, 8)), [255, 0, 0, 255, 0, 255, 0, 255]);
	assert.deepStrictEqual([paintedKra.layerAssets[0].rasterMask.x, paintedKra.layerAssets[0].rasterMask.y], [0, 0]);
	assert.deepStrictEqual(Array.from(paintedKra.layerAssets[0].rasterMask.data.slice(0, 2)), [255, 0]);

	const filteredKra = decodeLayeredPreview('kra', asArrayBuffer(zipSync({
		'mimetype': strToU8('application/x-krita'),
		'mergedimage.png': png,
		'maindoc.xml': strToU8('<DOC><IMAGE name="Filter Test" colorspacename="RGBA" width="2" height="1"><layers><layer name="Global hue" nodetype="adjustmentlayer" filename="layer1" filtername="hsvadjustment" visible="1" opacity="255"/><layer name="Pixels" nodetype="paintlayer" filename="layer2" visible="1" opacity="255"><masks><mask name="Local levels" nodetype="filtermask" filename="mask3" filtername="levels" visible="1"/></masks></layer></layers></IMAGE></DOC>'),
		'Filter Test/layers/layer1.filterconfig': strToU8('<params version="1"><param name="h">45</param><param name="s">20</param><param name="v">-5</param><param name="colorize">false</param></params>'),
		'Filter Test/layers/layer2': kraPaintDevice(4, [0, 0, 255, 255, 0, 255, 0, 255]),
		'Filter Test/layers/mask3.filterconfig': strToU8('<params version="2"><param name="lightness">0.1;0.9;1.2;0;1</param></params>'),
	})));
	const kraAdjustments = filteredKra.layerAssets.filter(asset => asset.kind === 'adjustment');
	assert.deepStrictEqual(kraAdjustments.map(asset => asset.adjustment.type), ['hue/saturation', 'levels']);
	assert.strictEqual(kraAdjustments.find(asset => asset.name === 'Local levels').clipped, true);
	assert.strictEqual(kraAdjustments.find(asset => asset.name === 'Local levels').adjustment.rgb.midtoneInput, 1.2);

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
	assert.strictEqual(psd.layerOrder, 'bottom-to-top');
	assert.strictEqual(psd.layerAssets.length, 1);
	assert.deepStrictEqual(Array.from(psd.layerAssets[0].data), Array.from(imageData.data));
	const adjustedPsdBytes = new Uint8Array(writePsd({
		width: 2, height: 1, imageData,
		children: [
			{ name: 'Levels', adjustment: { type: 'levels', rgb: { shadowInput: 0, highlightInput: 200, shadowOutput: 0, highlightOutput: 255, midtoneInput: 1 } } },
			{ name: 'Pixels', left: 0, top: 0, imageData },
		],
	}));
	const adjustedPsd = decodeLayeredPreview('psd', asArrayBuffer(adjustedPsdBytes));
	const adjustmentAsset = adjustedPsd.layerAssets.find(asset => asset.kind === 'adjustment');
	assert.strictEqual(adjustmentAsset.adjustment.type, 'levels');
	assert.strictEqual(adjustmentAsset.support, 'approximate');
	const colorizedPsdBytes = new Uint8Array(writePsd({
		width: 2, height: 1, imageData,
		children: [{
			name: 'Colorize', clipping: true,
			adjustment: { type: 'hue/saturation', master: { a: 256, b: -131, c: 100, d: -50, hue: 0, saturation: 0, lightness: 0 } },
		}, { name: 'Pixels', left: 0, top: 0, imageData }],
	}));
	const colorizedPsd = decodeLayeredPreview('psd', asArrayBuffer(colorizedPsdBytes));
	const colorizeAsset = colorizedPsd.layerAssets.find(asset => asset.kind === 'adjustment');
	assert.deepStrictEqual(colorizeAsset.adjustment.colorize, { hue: -131, saturation: 100, lightness: -50 });
	assert.strictEqual(colorizeAsset.adjustment.colorizeEnabled, true);
	assert.strictEqual(colorizeAsset.clipped, true);
	const extendedAdjustmentsPsd = decodeLayeredPreview('psd', asArrayBuffer(new Uint8Array(writePsd({
		width: 2, height: 1, imageData,
		children: [
			{ name: 'Exposure', clipping: true, adjustment: { type: 'exposure', exposure: 1, offset: 0, gamma: 1 } },
			{ name: 'Invert', clipping: true, adjustment: { type: 'invert' } },
			{ name: 'Pixels', left: 0, top: 0, imageData },
		],
	}))));
	assert.strictEqual(extendedAdjustmentsPsd.layerAssets.find(asset => asset.name === 'Exposure').adjustment.type, 'exposure');
	assert.strictEqual(extendedAdjustmentsPsd.layerAssets.find(asset => asset.name === 'Invert').adjustment.type, 'invert');
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
	const effectXcf = decodeLayeredPreview('xcf', asArrayBuffer(buildEffectXcf()));
	const xcfEffect = effectXcf.layerAssets.find(asset => asset.kind === 'adjustment');
	assert.strictEqual(xcfEffect.adjustment.type, 'brightness/contrast');
	assert.strictEqual(xcfEffect.adjustment.brightness, 25);
	assert.strictEqual(xcfEffect.adjustment.contrast, 50);
	assert.strictEqual(xcfEffect.clipped, true);

	const exported = writeLayerStackAsXcf([
		{ id: 'background', kind: 'raster', name: 'Background', data: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255]), width: 2, height: 1, channels: 4, typeMax: 255, visible: true, opacity: 1, blendMode: 'normal' },
		{ id: 'group', kind: 'group', name: 'Group', width: 2, height: 1, channels: 4, typeMax: 255, visible: true, opacity: 0.5, blendMode: 'screen' },
		{ id: 'paint', parentId: 'group', kind: 'raster', name: 'Paint', data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]), width: 2, height: 1, channels: 4, typeMax: 255, visible: true, opacity: 1, blendMode: 'multiply', rasterMask: { data: new Uint8Array([255, 0]), width: 2, height: 1, channels: 1, typeMax: 255 } },
	], 2, 1);
	const exportedXcf = decodeLayeredPreview('xcf', asArrayBuffer(exported.data));
	assert.strictEqual(exportedXcf.document.layerCount, 3);
	assert.strictEqual(exportedXcf.layerAssets.find(asset => asset.kind === 'group').blendMode, 'screen');
	const exportedPaint = exportedXcf.layerAssets.find(asset => asset.name === 'Paint');
	assert.strictEqual(exportedPaint.parentId, exportedXcf.layerAssets.find(asset => asset.kind === 'group').nodeId);
	assert.strictEqual(exportedPaint.blendMode, 'multiply');
	assert.deepStrictEqual(Array.from(exportedPaint.data.slice(3, 8)), [255, 0, 255, 0, 0], 'raster mask is baked into exported XCF alpha');
	assert.ok(exported.warnings.some(warning => warning.includes('baked into alpha')));

	console.log('Layered preview decoders passed: ORA, KRA, PSD/PSB, XCF, and Affinity.');
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
