'use strict';
/**
 * Argument matrix for the Nikon ND2 and Leica LIF decoders.
 *
 * `scientific-formats-test.js` checks one committed fixture per format. That
 * pins the common path but says nothing about the axes along which these
 * containers actually vary, and during development every real bug lived on one
 * of those axes: the XML metadata encoding older ND2 writers use, the row
 * padding declared by `uiWidthBytes`, the `DataType` flag that decides whether
 * a LIF channel is integer or float, and the container version that changes a
 * memory block's size field from u32 to u64.
 *
 * The fixtures are built in memory rather than committed, because the point is
 * to cover a combinatorial space cheaply: a file per cell would be ~20 blobs in
 * the repository for bytes that are fully described by the code below. Each
 * sample encodes its own coordinate, so a mis-addressed read fails loudly
 * instead of merely looking plausible.
 *
 * Run with: node test/microscopy-matrix-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let wasm = null;
async function initWasm() {
	if (wasm) { return wasm; }
	const js = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.js');
	const bin = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.wasm');
	wasm = await import(js.replace(/\\/g, '/'));
	await wasm.default({ module_or_path: fs.readFileSync(bin) });
	return wasm;
}

// --------------------------------------------------------------- helpers ---

const u8 = v => Buffer.from([v & 0xff]);
const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const i32 = v => { const b = Buffer.alloc(4); b.writeInt32LE(v | 0); return b; };
const u64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const f64 = v => { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b; };
const utf16 = s => Buffer.from(s, 'utf16le');

/** IEEE binary16 encoder, only for the value range these fixtures use. */
function toHalf(value) {
	const f = new Float32Array([value]);
	const bits = new Uint32Array(f.buffer)[0];
	const sign = (bits >>> 31) & 1;
	let exp = (bits >>> 23) & 0xff;
	let mant = bits & 0x7fffff;
	if (exp === 0xff) { return (sign << 15) | 0x7c00 | (mant ? 0x200 : 0); }
	let e = exp - 127 + 15;
	if (e >= 0x1f) { return (sign << 15) | 0x7c00; }
	if (e <= 0) { return (sign << 15); }         // fixtures avoid subnormals
	return (sign << 15) | (e << 10) | (mant >>> 13);
}

// ------------------------------------------------------------------- ND2 ---

const ND2_MAGIC = 0x0abeceda;
function nd2Chunk(name, payload) {
	const n = Buffer.concat([Buffer.from(name, 'ascii'), Buffer.from([0])]);
	return Buffer.concat([u32(ND2_MAGIC), u32(n.length), u64(payload.length), n, payload]);
}
function lvName(name) {
	const n = Buffer.concat([utf16(name), Buffer.from([0, 0])]);
	return { bytes: n, units: n.length / 2 };
}
const lvU32 = (k, v) => { const n = lvName(k); return Buffer.concat([Buffer.from([3, n.units]), n.bytes, u32(v)]); };
const lvI32 = (k, v) => { const n = lvName(k); return Buffer.concat([Buffer.from([2, n.units]), n.bytes, i32(v)]); };
const lvF64 = (k, v) => { const n = lvName(k); return Buffer.concat([Buffer.from([6, n.units]), n.bytes, f64(v)]); };
function lvMap(key, children, count) {
	const n = lvName(key);
	const header = Buffer.concat([Buffer.from([11, n.units]), n.bytes]);
	const total = header.length + 12 + children.length;
	return Buffer.concat([header, u32(count), u64(total), children]);
}

/**
 * @param {object} o
 *   width,height,channels,bits,pixelType,compression,pad,frames,loopCount,
 *   xmlMetadata (write the older `<variant>` encoding instead of binary LV)
 */
function buildNd2(o) {
	const bytesPerSample = o.bits / 8;
	const packed = o.width * o.channels * bytesPerSample;
	const stride = packed + (o.pad || 0);
	const attrFields = {
		uiWidth: o.width, uiWidthBytes: stride, uiHeight: o.height,
		uiComp: o.channels, uiBpcInMemory: o.bits, uiBpcSignificant: o.bits,
		uiSequenceCount: o.frames, eCompression: o.compression ?? 2,
		ePixelType: o.pixelType ?? 1,
	};
	let attrs, meta;
	if (o.xmlMetadata) {
		const body = Object.entries(attrFields)
			.map(([k, v]) => `<${k} runtype="lx_uint32" value="${v}"/>`).join('');
		attrs = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><variant version="1.0">`
			+ `<no_name runtype="CLxListVariant">${body}</no_name></variant>`, 'utf8');
		meta = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><variant version="1.0">`
			+ `<no_name runtype="RLxExperiment"><eType runtype="lx_uint32" value="${o.loopType ?? 1}"/>`
			+ `<uLoopPars runtype="CLxListVariant"><no_name runtype="RLxExperiment.RLxExpTimeLoop">`
			+ `<uiCount runtype="lx_uint32" value="${o.loopCount}"/></no_name></uLoopPars>`
			+ `</no_name></variant>`, 'utf8');
	} else {
		attrs = lvMap('SLxImageAttributes', Buffer.concat([
			lvU32('uiWidth', o.width), lvU32('uiWidthBytes', stride), lvU32('uiHeight', o.height),
			lvU32('uiComp', o.channels), lvU32('uiBpcInMemory', o.bits),
			lvU32('uiSequenceCount', o.frames), lvI32('eCompression', o.compression ?? 2),
			lvU32('ePixelType', o.pixelType ?? 1),
		]), 8);
		meta = lvMap('SLxExperiment', Buffer.concat([
			lvU32('eType', o.loopType ?? 1),
			lvMap('uLoopPars', lvU32('uiCount', o.loopCount), 1),
		]), 2);
	}
	const calib = o.xmlMetadata ? null : lvMap('SLxCalibration', lvF64('dCalibration', 0.5), 1);

	const frames = [];
	for (let f = 0; f < o.frames; f++) {
		const rows = [];
		for (let y = 0; y < o.height; y++) {
			const row = Buffer.alloc(stride);
			for (let x = 0; x < o.width; x++) {
				for (let c = 0; c < o.channels; c++) {
					const v = 1000 * f + 100 * c + 10 * y + x;
					const at = (x * o.channels + c) * bytesPerSample;
					if (o.bits === 8) { row.writeUInt8(v & 0xff, at); }
					else if (o.bits === 16 && o.pixelType === 2) { row.writeUInt16LE(toHalf(v / 64), at); }
					else if (o.bits === 16) { row.writeUInt16LE(v, at); }
					else if (o.bits === 32 && o.pixelType === 2) { row.writeFloatLE(v, at); }
					else if (o.bits === 32) { row.writeUInt32LE(v, at); }
				}
			}
			rows.push(row);
		}
		frames.push(Buffer.concat([f64(1000 * f), ...rows]));
	}

	let body = nd2Chunk('ND2 FILE SIGNATURE CHUNK NAME01!', Buffer.alloc(64));
	const entries = [];
	const emit = (name, payload) => {
		entries.push([name, body.length, payload.length]);
		body = Buffer.concat([body, nd2Chunk(name, payload)]);
	};
	emit(o.xmlMetadata ? 'ImageAttributes!' : 'ImageAttributesLV!', attrs);
	emit(o.xmlMetadata ? 'ImageMetadata!' : 'ImageMetadataLV!', meta);
	if (calib) { emit('ImageCalibrationLV|0!', calib); }
	frames.forEach((p, i) => emit(`ImageDataSeq|${i}!`, p));

	const map = Buffer.concat([
		...entries.map(([n, off, len]) => Buffer.concat([Buffer.from(n, 'ascii'), u64(off), u64(len)])),
		Buffer.from('ND2 CHUNK MAP SIGNATURE 0000001!', 'ascii'), u64(0), u64(0),
	]);
	const mapOffset = body.length;
	body = Buffer.concat([body, nd2Chunk('ND2 FILEMAP SIGNATURE NAME 0001!', map),
		Buffer.from('ND2 CHUNK MAP SIGNATURE 0000001!', 'ascii'), u64(mapOffset)]);
	return new Uint8Array(body);
}

// ------------------------------------------------------------------- LIF ---

/** @param {object} o width,height,z,channels,resolution,dataType,version,tags */
function buildLif(o) {
	const bytesPerSample = Math.ceil(o.resolution / 8);
	const planeBytes = o.width * o.height * bytesPerSample;
	const volume = planeBytes * o.z;
	const chans = Array.from({ length: o.channels }, (_, c) =>
		`<ChannelDescription DataType="${o.dataType}" ChannelTag="${o.tags ? o.tags[c] : 0}" `
		+ `Resolution="${o.resolution}" LUTName="Ch${c}" BytesInc="${c * volume}" BitInc="0"/>`).join('');
	const dims = [
		`<DimensionDescription DimID="1" NumberOfElements="${o.width}" Length="${(o.width - 1) * 1e-6}" Unit="m" BytesInc="${bytesPerSample}" BitInc="0"/>`,
		`<DimensionDescription DimID="2" NumberOfElements="${o.height}" Length="${(o.height - 1) * 1e-6}" Unit="m" BytesInc="${o.width * bytesPerSample}" BitInc="0"/>`,
		o.z > 1 ? `<DimensionDescription DimID="3" NumberOfElements="${o.z}" Length="0" Unit="m" BytesInc="${planeBytes}" BitInc="0"/>` : '',
	].join('');
	const xml = `<LMSDataContainerHeader Version="${o.version}">`
		+ `<Element Name="root"><Children><Element Name="SeriesA">`
		+ `<Data><Image><ImageDescription><Channels>${chans}</Channels>`
		+ `<Dimensions>${dims}</Dimensions></ImageDescription></Image></Data>`
		+ `<Memory MemoryBlockID="BlockA" Size="${volume * o.channels}"/>`
		+ `</Element></Children></Element></LMSDataContainerHeader>`;
	const xmlBytes = utf16(xml);
	const head = Buffer.concat([u32(0x70), u32(xmlBytes.length + 5), u8(0x2a), u32(xml.length), xmlBytes]);

	const pixels = Buffer.alloc(volume * o.channels);
	let at = 0;
	for (let c = 0; c < o.channels; c++) {
		for (let z = 0; z < o.z; z++) {
			for (let y = 0; y < o.height; y++) {
				for (let x = 0; x < o.width; x++) {
					const v = 1000 * c + 100 * z + 10 * y + x;
					if (bytesPerSample === 1) { pixels.writeUInt8(v & 0xff, at); }
					else if (bytesPerSample === 2 && o.dataType === 1) { pixels.writeUInt16LE(toHalf(v / 64), at); }
					else if (bytesPerSample === 2) { pixels.writeUInt16LE(v, at); }
					else if (o.dataType === 1) { pixels.writeFloatLE(v, at); }
					else { pixels.writeUInt32LE(v, at); }
					at += bytesPerSample;
				}
			}
		}
	}
	const name = utf16('BlockA');
	const size = o.version >= 2 ? u64(pixels.length) : u32(pixels.length);
	const block = Buffer.concat([u32(0x70), u32(0), u8(0x2a), size, u8(0x2a), u32(6), name, pixels]);
	return new Uint8Array(Buffer.concat([head, block]));
}

// ----------------------------------------------------------------- tests ---

const decodeNd2 = (bytes, opts = {}) => wasm.decode_nd2_fast(bytes, JSON.stringify(opts));
const decodeLif = (bytes, opts = {}) => wasm.decode_lif_fast(bytes, JSON.stringify(opts));
const domainOf = r => ({ bitsPerSample: r.bits_per_sample, sampleFormat: r.sample_format, sourceNumericType: r.source_numeric_type });

let checks = 0;
function ok(label) { checks++; console.log('  ✅ ' + label); }

function nd2Matrix() {
	console.log('\n🔬 ND2 pixel-format matrix');
	const base = { width: 4, height: 3, channels: 1, frames: 2, loopCount: 2 };
	const cases = [
		['uint8  1ch',  { ...base, bits: 8,  pixelType: 1 }, { bitsPerSample: 8,  sampleFormat: 1, sourceNumericType: 'uint8' },   1],
		['uint16 1ch',  { ...base, bits: 16, pixelType: 1 }, { bitsPerSample: 16, sampleFormat: 1, sourceNumericType: 'uint16' },  1],
		['uint32 1ch',  { ...base, bits: 32, pixelType: 1 }, { bitsPerSample: 32, sampleFormat: 1, sourceNumericType: 'uint32' },  1],
		['float32 1ch', { ...base, bits: 32, pixelType: 2 }, { bitsPerSample: 32, sampleFormat: 3, sourceNumericType: 'float32' }, 1],
		['float16 1ch', { ...base, bits: 16, pixelType: 2 }, { bitsPerSample: 16, sampleFormat: 3, sourceNumericType: 'float16' }, 1],
		['uint8  3ch RGB', { ...base, bits: 8, pixelType: 1, channels: 3 }, { bitsPerSample: 8, sampleFormat: 1, sourceNumericType: 'uint8' }, 3],
		['uint16 2ch fluorescence', { ...base, bits: 16, pixelType: 1, channels: 2 }, { bitsPerSample: 16, sampleFormat: 1, sourceNumericType: 'uint16' }, 1],
	];
	for (const [label, opts, domain, outChannels] of cases) {
		const r = decodeNd2(buildNd2(opts));
		assert.deepStrictEqual(domainOf(r), domain, label + ': numeric domain');
		assert.strictEqual(r.channels, outChannels, label + ': output channels');
		const data = r.take_data_as_f32();
		// float16 cannot hold the raw coordinate codes exactly, so those
		// fixtures store `code / 64`; every other format stores the code.
		const scale = (opts.bits === 16 && opts.pixelType === 2) ? 1 / 64 : 1;
		const expect = code => code * scale;
		assert.strictEqual(data[0], expect(0), label + ': first sample');
		if (outChannels === 1) {
			assert.strictEqual(data[3], expect(3), label + ': x addressing');
			assert.strictEqual(data[4], expect(10), label + ': row addressing');
		}
		ok(`${label} -> ${domain.sourceNumericType}, ${outChannels}ch`);
	}

	// Row padding must come from uiWidthBytes, not from width*channels*bytes.
	for (const pad of [0, 2, 6]) {
		const r = decodeNd2(buildNd2({ ...base, bits: 16, pixelType: 1, pad }));
		const d = r.take_data_as_f32();
		assert.strictEqual(d[4], 10, `pad=${pad}: row 1 must start at the declared stride`);
		assert.strictEqual(d[11], 23, `pad=${pad}: last pixel`);
	}
	ok('row padding of 0/2/6 bytes all address rows correctly');

	// The older XML `<variant>` metadata encoding must reach the same result.
	const binary = decodeNd2(buildNd2({ ...base, bits: 16, pixelType: 1 }));
	const xmlEnc = decodeNd2(buildNd2({ ...base, bits: 16, pixelType: 1, xmlMetadata: true }));
	assert.deepStrictEqual(
		[xmlEnc.width, xmlEnc.height, xmlEnc.channels, xmlEnc.bits_per_sample],
		[binary.width, binary.height, binary.channels, binary.bits_per_sample]);
	assert.deepStrictEqual(Array.from(xmlEnc.take_data_as_f32()), Array.from(binary.take_data_as_f32()),
		'XML-encoded metadata must decode to identical pixels');
	ok('XML <variant> metadata decodes identically to binary LV metadata');

	// Compression modes are named, not guessed at.
	for (const [mode, pattern] of [[0, /lossless/i], [1, /lossy/i]]) {
		assert.throws(() => decodeNd2(buildNd2({ ...base, bits: 16, pixelType: 1, compression: mode })),
			pattern, `eCompression=${mode} must be rejected by name`);
	}
	ok('lossless and lossy compression are rejected by name');

	// Loop type decides the axis label; 4 is a Z stack, 1 a time series.
	const zStack = decodeNd2(buildNd2({ ...base, bits: 16, pixelType: 1, loopType: 4 }));
	const axes = JSON.parse(zStack.metadata_json).selectors.map(s => s.name);
	assert.ok(axes.includes('Z'), 'loop type 4 is a Z stack');
	const timeSeries = decodeNd2(buildNd2({ ...base, bits: 16, pixelType: 1, loopType: 1 }));
	assert.ok(JSON.parse(timeSeries.metadata_json).selectors.map(s => s.name).includes('T'),
		'loop type 1 is a time series');
	ok('loop types 1 and 4 map to T and Z');
}

function lifMatrix() {
	console.log('\n🔬 LIF pixel-format matrix');
	const base = { width: 4, height: 3, z: 2, channels: 1, version: 2 };
	const cases = [
		['uint8   DataType=0', { ...base, resolution: 8,  dataType: 0 }, { bitsPerSample: 8,  sampleFormat: 1, sourceNumericType: 'uint8' }],
		['uint16  DataType=0', { ...base, resolution: 16, dataType: 0 }, { bitsPerSample: 16, sampleFormat: 1, sourceNumericType: 'uint16' }],
		['uint32  DataType=0', { ...base, resolution: 32, dataType: 0 }, { bitsPerSample: 32, sampleFormat: 1, sourceNumericType: 'uint32' }],
		['float16 DataType=1', { ...base, resolution: 16, dataType: 1 }, { bitsPerSample: 16, sampleFormat: 3, sourceNumericType: 'float16' }],
		['float32 DataType=1', { ...base, resolution: 32, dataType: 1 }, { bitsPerSample: 32, sampleFormat: 3, sourceNumericType: 'float32' }],
		['12-bit stored in 16', { ...base, resolution: 12, dataType: 0 }, { bitsPerSample: 16, sampleFormat: 1, sourceNumericType: 'uint16' }],
	];
	for (const [label, opts, domain] of cases) {
		const r = decodeLif(buildLif(opts));
		assert.deepStrictEqual(domainOf(r), domain, label + ': numeric domain');
		const d = r.take_data_as_f32();
		const scale = (opts.resolution === 16 && opts.dataType === 1) ? 1 / 64 : 1;
		const expect = code => code * scale;
		assert.strictEqual(d[0], expect(0), label + ': first sample');
		assert.strictEqual(d[3], expect(3), label + ': x addressing');
		assert.strictEqual(d[4], expect(10), label + ': row addressing');
		ok(`${label} -> ${domain.sourceNumericType}`);
	}

	// DataType is what separates a 32-bit integer channel from a float one;
	// reading the same bytes both ways must NOT give the same numbers.
	const asInt = decodeLif(buildLif({ ...base, resolution: 32, dataType: 0 })).take_data_as_f32();
	assert.strictEqual(asInt[3], 3, 'uint32 channel reads as an integer');
	ok('DataType=0 at 32 bits is uint32, not float32');

	// Container version changes the memory-block size field width.
	for (const version of [1, 2]) {
		const r = decodeLif(buildLif({ ...base, resolution: 16, dataType: 0, version }));
		const d = r.take_data_as_f32();
		assert.strictEqual(d[11], 23, `version ${version}: block chain must stay in sync`);
	}
	ok('container versions 1 (u32 sizes) and 2 (u64 sizes) both parse');

	// Planar channels: channel 1 is a whole volume further into the block.
	const twoCh = buildLif({ ...base, resolution: 16, dataType: 0, channels: 2 });
	assert.strictEqual(decodeLif(twoCh, { indices: { C: 1 } }).take_data_as_f32()[0], 1000,
		'channel 1 is selected by its BytesInc');
	assert.strictEqual(decodeLif(twoCh, { indices: { Z: 1 } }).take_data_as_f32()[0], 100,
		'Z steps by its own BytesInc');
	ok('planar channel and Z offsets address independently');

	// RGB tagging: 1/2/3 means a colour image, not three measurements.
	const rgb = decodeLif(buildLif({ ...base, resolution: 8, dataType: 0, channels: 3, tags: [1, 2, 3] }));
	assert.strictEqual(rgb.channels, 3, 'R/G/B tagged channels compose into one colour image');
	const grey = decodeLif(buildLif({ ...base, resolution: 8, dataType: 0, channels: 3, tags: [0, 0, 0] }));
	assert.strictEqual(grey.channels, 1, 'untagged channels stay separate measurements');
	ok('ChannelTag 1/2/3 yields RGB; untagged yields per-channel planes');
}

/**
 * A compressed CZI whose plane extent is large must report the codec, not
 * abort. The check used to sit *after* the raster allocation, so on wasm32
 * (32-bit usize) a large JPEG XR mosaic panicked with a capacity overflow —
 * a module abort — while the same file on a 64-bit build returned a clean
 * error. Panics are not recoverable in the webview, so the two targets have
 * to agree.
 */
function cziLargeCompressedPlane() {
	console.log('\n🔬 CZI oversized-plane guard');
	const file = path.join('/Users/florian/Projects/cursor/test_data/testfiles/scientific',
		'openmicroscopy-czi/zenodo-10577186/2023_11_30__RecognizedCode-27.czi');
	if (!fs.existsSync(file)) {
		console.log('  ⏭  skipped (corpus file not present)');
		return;
	}
	const bytes = new Uint8Array(fs.readFileSync(file));
	assert.throws(() => wasm.decode_czi_fast(bytes, '{}'),
		e => /^\[external-codec:JPEG XR\] CZI subblock needs the JPEG XR decoder/.test(
			String(e && e.message || e)),
		'a large compressed CZI must report its codec rather than abort');
	ok('a large compressed CZI reports its codec instead of panicking');
}

async function main() {
	await initWasm();
	nd2Matrix();
	lifMatrix();
	cziLargeCompressedPlane();
	console.log('\n' + '─'.repeat(60));
	console.log(`🎉 All ${checks} ND2/LIF matrix checks passed.`);
}

main().catch(e => { console.error(e); process.exit(1); });
