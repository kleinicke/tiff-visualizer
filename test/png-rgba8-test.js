/**
 * The layered document decoders (ORA, KRA, Affinity previews and layers) read
 * embedded PNGs as UPNG's `toRGBA8` output. Where the core WebAssembly is
 * loaded they use Rust's `decode_png_rgba8` instead, ~3.5x faster, so the two
 * must agree byte for byte on everything Rust accepts, and Rust must refuse
 * what it would get different (grayscale below 8 bits, interlaced below 8
 * bits, where UPNG misplaces 1-bit pixels, and animated PNGs).
 *
 * PNGs come from a minimal encoder below (every color type and depth,
 * palettes and tRNS, Adam7, odd sizes) and from every PNG in test-samples.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const UPNG = require('upng-js');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
function crc32(bytes) {
	let c = 0xffffffff;
	for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'latin1');
	Buffer.from(data).copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

/** `sample(x, y, channel)` returns values in `0 .. 2^depth - 1`. */
function encodePng({ width, height, ctype, depth, interlace = false, palette, trns, sample }) {
	const channels = CHANNELS[ctype];
	const rowsOf = (x0, y0, dx, dy) => {
		const rows = [];
		for (let y = y0; y < height; y += dy) {
			const xs = [];
			for (let x = x0; x < width; x += dx) xs.push(x);
			if (!xs.length) continue;
			const bits = xs.length * channels * depth;
			const row = Buffer.alloc(1 + Math.ceil(bits / 8));
			let bit = 0;
			for (const x of xs) {
				for (let c = 0; c < channels; c++) {
					const value = sample(x, y, c);
					if (depth === 16) { row.writeUInt16BE(value, 1 + bit / 8); }
					else if (depth === 8) { row[1 + bit / 8] = value; }
					else { row[1 + (bit >> 3)] |= value << (8 - depth - (bit & 7)); }
					bit += depth;
				}
			}
			rows.push(row);
		}
		return rows;
	};
	const rows = interlace ? ADAM7.flatMap(([x0, y0, dx, dy]) => rowsOf(x0, y0, dx, dy)) : rowsOf(0, 0, 1, 1);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = depth; ihdr[9] = ctype; ihdr[12] = interlace ? 1 : 0;
	return new Uint8Array(Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		...(palette ? [chunk('PLTE', palette)] : []),
		...(trns ? [chunk('tRNS', trns)] : []),
		chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
		chunk('IEND', Buffer.alloc(0)),
	]));
}

function upngRgba8(bytes) {
	const png = UPNG.decode(bytes.slice().buffer);
	return new Uint8Array(UPNG.toRGBA8(png)[0]);
}

async function main() {
	const wasm = await import('../media/wasm/tiff-wasm.js');
	await wasm.default({ module_or_path: fs.readFileSync('media/wasm/tiff-wasm.wasm') });
	const rust = bytes => {
		const result = wasm.decode_png_rgba8(bytes);
		const out = { width: result.width, height: result.height, data: result.take_data() };
		result.free();
		return out;
	};
	const same = (name, bytes) => {
		const expected = upngRgba8(bytes);
		const actual = rust(bytes);
		assert.ok(Buffer.from(actual.data).equals(Buffer.from(expected)), `${name}: differs from UPNG`);
	};

	const width = 37, height = 23;
	const hash = (x, y, c) => (Math.imul(x * 73856093 ^ y * 19349663 ^ c * 83492791, 2654435761) >>> 0);
	let encoded = 0;
	for (const interlace of [false, true]) {
		for (const depth of [8, 16]) {
			const max = 2 ** depth - 1;
			const value = (x, y, c) => hash(x, y, c) % (max + 1);
			for (const ctype of [0, 2, 4, 6]) {
				same(`ctype ${ctype} ${depth}-bit${interlace ? ' Adam7' : ''}`, encodePng({ width, height, ctype, depth, interlace, sample: value }));
				encoded++;
			}
			// tRNS: one gray / RGB value is fully transparent. Use values that occur.
			const grayKey = value(3, 4, 0);
			const trnsGray = Buffer.alloc(2); trnsGray.writeUInt16BE(grayKey);
			same(`gray ${depth}-bit tRNS`, encodePng({ width, height, ctype: 0, depth, interlace, trns: trnsGray, sample: (x, y, c) => (x + y) % 3 === 0 ? grayKey : value(x, y, c) }));
			const rgbKey = [value(5, 6, 0), value(5, 6, 1), value(5, 6, 2)];
			const trnsRgb = Buffer.alloc(6); rgbKey.forEach((v, i) => trnsRgb.writeUInt16BE(v, i * 2));
			same(`RGB ${depth}-bit tRNS`, encodePng({ width, height, ctype: 2, depth, interlace, trns: trnsRgb, sample: (x, y, c) => (x * y) % 4 === 0 ? rgbKey[c] : value(x, y, c) }));
			// A 16-bit key that differs from a sample only in its low byte stays opaque.
			encoded += 2;
		}
		// UPNG misplaces 1-bit Adam7 pixels; Rust leaves interlaced low depths to it.
		for (const depth of interlace ? [8] : [1, 2, 4, 8]) {
			const entries = 2 ** depth;
			const palette = Buffer.from(Array.from({ length: entries * 3 }, (_, i) => (i * 97 + 13) & 0xff));
			const index = (x, y) => hash(x, y, 9) % entries;
			same(`palette ${depth}-bit`, encodePng({ width, height, ctype: 3, depth, interlace, palette, sample: index }));
			// tRNS shorter than the palette: later entries stay opaque.
			const trns = Buffer.from(Array.from({ length: Math.max(1, entries >> 1) }, (_, i) => (i * 61) & 0xff));
			same(`palette ${depth}-bit tRNS`, encodePng({ width, height, ctype: 3, depth, interlace, palette, trns, sample: index }));
			encoded += 2;
		}
	}
	// Refused: grayscale below 8 bits (UPNG ignores the row padding there) and
	// interlaced images below 8 bits.
	for (const depth of [1, 2, 4]) {
		const gray = encodePng({ width, height, ctype: 0, depth, sample: (x, y) => hash(x, y, 0) % 2 ** depth });
		assert.throws(() => rust(gray), `${depth}-bit gray must be left to UPNG`);
		const palette = Buffer.alloc(3 * 2 ** depth, 7);
		const interlaced = encodePng({ width, height, ctype: 3, depth, interlace: true, palette, sample: (x, y) => hash(x, y, 0) % 2 ** depth });
		assert.throws(() => rust(interlaced), `${depth}-bit Adam7 must be left to UPNG`);
	}

	let fixtures = 0, refused = 0;
	for (const name of fs.readdirSync('test-samples').filter(file => /\.png$/i.test(file))) {
		const bytes = new Uint8Array(fs.readFileSync(path.join('test-samples', name)));
		let actual;
		try { actual = rust(bytes); } catch { refused++; continue; }
		const expected = upngRgba8(bytes);
		assert.ok(Buffer.from(actual.data).equals(Buffer.from(expected)), `${name}: differs from UPNG`);
		fixtures++;
	}
	assert.ok(fixtures >= 2, `only ${fixtures} PNG fixtures compared`);
	// Through the layered decoders: an ORA whose merged image and layers are
	// PNGs of several kinds decodes identically with the Rust hook installed.
	const { zipSync, strToU8 } = require('fflate');
	const decoders = await import('../out/media/modules/layered-preview-decoders.js');
	const layerPng = (ctype, depth, seed) => encodePng({ width, height, ctype, depth, palette: ctype === 3 ? Buffer.from(Array.from({ length: 768 }, (_, i) => (i * seed) & 0xff)) : undefined, sample: (x, y, c) => hash(x + seed, y, c) % (ctype === 3 ? 256 : 2 ** depth) });
	const ora = zipSync({
		mimetype: strToU8('image/openraster'),
		'stack.xml': strToU8(`<?xml version="1.0"?><image w="${width}" h="${height}"><stack><layer name="a" src="data/a.png"/><layer name="b" src="data/b.png" opacity="0.5"/><layer name="c" src="data/c.png"/></stack></image>`),
		'data/a.png': layerPng(6, 8, 3), 'data/b.png': layerPng(3, 8, 5), 'data/c.png': layerPng(2, 16, 7),
		'mergedimage.png': layerPng(6, 8, 11),
	});
	const decodeOra = () => decoders.decodeLayeredPreview('ora', ora.slice().buffer, {});
	decoders.setFastPngRgbaDecoder(null);
	const reference = decodeOra();
	let hookCalls = 0;
	decoders.setFastPngRgbaDecoder(bytes => { hookCalls++; try { return rust(bytes); } catch { return null; } });
	const viaRust = decodeOra();
	decoders.setFastPngRgbaDecoder(null);
	assert.ok(hookCalls >= 4, `the hook decoded ${hookCalls} PNGs`);
	assert.ok(Buffer.from(viaRust.data).equals(Buffer.from(reference.data)), 'ORA merged image differs');
	assert.equal(viaRust.layerAssets.length, reference.layerAssets.length);
	viaRust.layerAssets.forEach((layer, i) => {
		assert.ok(Buffer.from(layer.data).equals(Buffer.from(reference.layerAssets[i].data)), `ORA layer ${i} differs`);
	});

	console.log(`PNG RGBA8: Rust equals UPNG on ${encoded} encoded variants and ${fixtures} fixtures (${refused} left to UPNG); low-bit gray and Adam7 refused; an ORA decodes identically through the hook`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
