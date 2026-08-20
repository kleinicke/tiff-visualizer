'use strict';
/**
 * Regression matrix for the TIFF sample-layout paths.
 *
 * Every case here is a bug that shipped or nearly shipped, reduced to the
 * smallest file that reproduces it. The fixtures are built in memory because
 * the point is combinatorial coverage of layout (strip/tile, contiguous/
 * planar), depth (4/8/24-bit), sign, byte order and photometric — committing a
 * blob per cell would add ~20 opaque files for bytes fully described here.
 *
 * Each sample encodes its own coordinate, so a mis-addressed read fails loudly
 * rather than merely looking plausible.
 *
 * Run with: node test/tiff-bitdepth-matrix-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const wasmJs = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.js');
const wasmBin = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.wasm');

// --------------------------------------------------------------- TIFF writer

const T = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4 };

/**
 * Build a single-IFD TIFF. `big` selects MM byte order, which is what exposed
 * the endianness bug: reading multi-byte samples MSB-first is only correct for
 * big-endian files.
 */
function buildTiff({ big = false, width, height, tags, strips }) {
	const bo = big ? 'BE' : 'LE';
	const w16 = (b, o, v) => big ? b.writeUInt16BE(v, o) : b.writeUInt16LE(v, o);
	const w32 = (b, o, v) => big ? b.writeUInt32BE(v, o) : b.writeUInt32LE(v, o);

	const entries = [...tags].sort((a, b) => a.tag - b.tag);
	const header = 8;
	const ifdSize = 2 + entries.length * 12 + 4;
	// Values longer than 4 bytes live after the IFD.
	let extra = 0;
	for (const e of entries) {
		const size = e.values.length * (e.type === T.SHORT ? 2 : e.type === T.LONG ? 4 : 1);
		if (size > 4) { e.outOfLine = extra; extra += size + (size % 2); }
	}
	const dataStart = header + ifdSize + extra;
	const stripOffsets = [];
	let at = dataStart;
	for (const s of strips) { stripOffsets.push(at); at += s.length; }

	const buf = Buffer.alloc(at);
	buf.write(big ? 'MM' : 'II', 0, 'ascii');
	w16(buf, 2, 42);
	w32(buf, 4, header);
	w16(buf, header, entries.length);

	// Patch in the offsets now that they are known.
	for (const e of entries) {
		if (e.tag === 273) { e.values = stripOffsets; }
	}

	let p = header + 2;
	for (const e of entries) {
		w16(buf, p, e.tag);
		w16(buf, p + 2, e.type);
		w32(buf, p + 4, e.values.length);
		const unit = e.type === T.SHORT ? 2 : e.type === T.LONG ? 4 : 1;
		const size = e.values.length * unit;
		const writeAt = (base) => e.values.forEach((v, i) => {
			if (unit === 2) { w16(buf, base + i * 2, v); }
			else if (unit === 4) { w32(buf, base + i * 4, v); }
			else { buf.writeUInt8(v, base + i); }
		});
		if (size <= 4) {
			// Short values are left-justified in the value field.
			writeAt(p + 8);
		} else {
			const off = header + ifdSize + e.outOfLine;
			w32(buf, p + 8, off);
			writeAt(off);
		}
		p += 12;
	}
	w32(buf, p, 0);
	strips.forEach((s, i) => s.copy(buf, stripOffsets[i]));
	return { bytes: new Uint8Array(buf), bo };
}

const tag = (tag, type, values) => ({ tag, type, values: [].concat(values) });

/**
 * Pack one row of samples the way a TIFF writer would.
 *
 * Whole-byte depths are written in the FILE's byte order; sub-byte and odd
 * depths are a continuous MSB-first bit stream regardless of byte order. Rows
 * are padded to a byte boundary either way.
 */
function packRow(values, bits, big = true) {
	if (bits % 8 === 0) {
		const width = bits / 8;
		const out = Buffer.alloc(values.length * width);
		values.forEach((v, i) => {
			for (let b = 0; b < width; b++) {
				const byte = (v >> (8 * b)) & 0xff;
				out[i * width + (big ? width - 1 - b : b)] = byte;
			}
		});
		return out;
	}
	const out = Buffer.alloc(Math.ceil(values.length * bits / 8));
	let bitPos = 0;
	for (const v of values) {
		for (let b = bits - 1; b >= 0; b--) {
			if ((v >> b) & 1) { out[bitPos >> 3] |= 0x80 >> (bitPos & 7); }
			bitPos++;
		}
	}
	return out;
}

// ------------------------------------------------------------------- helpers

let mod = null;
const decode = bytes => {
	const r = mod.decode_tiff_fast(bytes);
	return { w: r.width, h: r.height, ch: r.channels, bps: r.bits_per_sample, sf: r.sample_format, d: Array.from(r.get_data_as_f32()) };
};
let checks = 0;
const ok = m => { checks++; console.log('  ✅ ' + m); };

const W = 4, H = 3;
const code = (x, y, c = 0) => 100 * c + 10 * y + x;

// --------------------------------------------------------------------- cases

function stripRowsExceedingHeight() {
	// RowsPerStrip larger than the image is legal (one strip covering
	// everything) and the strip then holds only the rows that exist. Demanding
	// RowsPerStrip rows rejected valid planar files outright.
	const planes = [0, 1, 2].map(c => Buffer.from(
		Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => code(x, y, c))).flat()));
	const { bytes } = buildTiff({
		big: true, width: W, height: H,
		tags: [
			tag(256, T.SHORT, W), tag(257, T.SHORT, H),
			tag(258, T.SHORT, [8, 8, 8]), tag(259, T.SHORT, 1), tag(262, T.SHORT, 2),
			tag(273, T.LONG, [0, 0, 0]), tag(277, T.SHORT, 3),
			tag(278, T.SHORT, 999), // deliberately far larger than H
			tag(279, T.LONG, planes.map(p => p.length)), tag(284, T.SHORT, 2),
		],
		strips: planes,
	});
	const r = decode(bytes);
	assert.deepStrictEqual([r.w, r.h, r.ch], [W, H, 3]);
	assert.strictEqual(r.d[0], code(0, 0, 0));
	assert.strictEqual(r.d[1], code(0, 0, 1), 'planes interleave into channels');
	assert.strictEqual(r.d[(1 * W + 2) * 3], code(2, 1, 0), 'row/col addressing');
	ok('planar strips with RowsPerStrip > height decode (strips are not padded)');
}

function oddDepth(bits, big) {
	const rows = Array.from({ length: H }, (_, y) =>
		packRow(Array.from({ length: W }, (_, x) => code(x, y) % (1 << Math.min(bits, 20))), bits, big));
	const { bytes } = buildTiff({
		big, width: W, height: H,
		tags: [
			tag(256, T.SHORT, W), tag(257, T.SHORT, H),
			tag(258, T.SHORT, bits), tag(259, T.SHORT, 1), tag(262, T.SHORT, 1),
			tag(273, T.LONG, rows.map(() => 0)), tag(277, T.SHORT, 1),
			tag(278, T.SHORT, 1), tag(279, T.LONG, rows.map(r => r.length)),
		],
		strips: rows,
	});
	const r = decode(bytes);
	assert.strictEqual(r.d.length, W * H, `${bits}-bit: every pixel must be present`);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			assert.strictEqual(r.d[y * W + x], code(x, y) % (1 << Math.min(bits, 20)),
				`${bits}-bit ${big ? 'BE' : 'LE'} sample at (${x},${y})`);
		}
	}
	ok(`${String(bits).padStart(2)}-bit ${big ? 'big' : 'little'}-endian grayscale decodes every sample`);
}

function signedSamples() {
	// Signed samples were read back as unsigned, turning every negative into a
	// huge positive value.
	const values = [-128, -1, 0, 127, -64, 64, -2, 2, 5, -5, 100, -100];
	const row = Buffer.alloc(W * H);
	values.forEach((v, i) => row.writeInt8(v, i));
	const { bytes } = buildTiff({
		big: false, width: W, height: H,
		tags: [
			tag(256, T.SHORT, W), tag(257, T.SHORT, H),
			tag(258, T.SHORT, 8), tag(259, T.SHORT, 1), tag(262, T.SHORT, 1),
			tag(273, T.LONG, [0]), tag(277, T.SHORT, 1), tag(278, T.SHORT, H),
			tag(279, T.LONG, [row.length]), tag(284, T.SHORT, 2), tag(339, T.SHORT, 2),
		],
		strips: [row],
	});
	const r = decode(bytes);
	assert.strictEqual(r.sf, 2, 'sample format is reported as signed');
	assert.deepStrictEqual(r.d, values, 'negative samples survive the round trip');
	ok('signed 8-bit samples keep their sign');
}

function paletteSubByte() {
	// A 2/4-bit palette packs several indices per byte; expanding the packed
	// BYTES through the ColorMap produced one pixel per byte.
	const bits = 4, colors = 16;
	const rows = Array.from({ length: H }, (_, y) =>
		packRow(Array.from({ length: W }, (_, x) => (y * W + x) % colors), bits));
	const cmap = [];
	for (const ch of [0, 1, 2]) {
		for (let i = 0; i < colors; i++) { cmap.push(((i * 17 + ch * 5) & 0xff) << 8); }
	}
	const { bytes } = buildTiff({
		big: true, width: W, height: H,
		tags: [
			tag(256, T.SHORT, W), tag(257, T.SHORT, H),
			tag(258, T.SHORT, bits), tag(259, T.SHORT, 1), tag(262, T.SHORT, 3),
			tag(273, T.LONG, rows.map(() => 0)), tag(277, T.SHORT, 1),
			tag(278, T.SHORT, 1), tag(279, T.LONG, rows.map(r => r.length)),
			tag(320, T.SHORT, cmap),
		],
		strips: rows,
	});
	const r = decode(bytes);
	assert.deepStrictEqual([r.w, r.h, r.ch], [W, H, 3]);
	assert.strictEqual(r.d.length, W * H * 3, 'one RGB triple per PIXEL, not per byte');
	for (let i = 0; i < W * H; i++) {
		const index = i % colors;
		assert.strictEqual(r.d[i * 3], (index * 17) & 0xff, `palette red at index ${index}`);
		assert.strictEqual(r.d[i * 3 + 1], (index * 17 + 5) & 0xff, `palette green at index ${index}`);
	}
	ok('4-bit palette indices unpack before the ColorMap lookup');
}

function ycbcrSubsampled() {
	// 4:2:2 groups samples into units of 2 luma + 1 Cb + 1 Cr; the tiff crate
	// rejects any subsampling, and the layout is not a plain raster.
	const unitsAcross = W / 2;
	const body = [];
	for (let y = 0; y < H; y++) {
		for (let u = 0; u < unitsAcross; u++) { body.push(60, 200, 128, 128); }
	}
	const strip = Buffer.from(body);
	const { bytes } = buildTiff({
		big: true, width: W, height: H,
		tags: [
			tag(256, T.SHORT, W), tag(257, T.SHORT, H),
			tag(258, T.SHORT, [8, 8, 8]), tag(259, T.SHORT, 1), tag(262, T.SHORT, 6),
			tag(273, T.LONG, [0]), tag(277, T.SHORT, 3), tag(278, T.SHORT, H),
			tag(279, T.LONG, [strip.length]), tag(530, T.SHORT, [2, 1]),
		],
		strips: [strip],
	});
	const r = decode(bytes);
	assert.deepStrictEqual([r.w, r.h, r.ch], [W, H, 3]);
	assert.strictEqual(r.d.length, W * H * 3);
	// Neutral chroma means the RGB triple equals the luma of that pixel, and
	// the two luma values alternate across each unit.
	for (let i = 0; i < W * H; i++) {
		const expected = (i % 2 === 0) ? 60 : 200;
		for (let c = 0; c < 3; c++) {
			assert.ok(Math.abs(r.d[i * 3 + c] - expected) <= 1,
				`pixel ${i} channel ${c}: ${r.d[i * 3 + c]} vs ${expected}`);
		}
	}
	ok('4:2:2 subsampled YCbCr expands luma per pixel with shared chroma');
}

/**
 * SGI Log HDR files (photometric 32844/32845). Verified against the real
 * corpus when present: the crate refuses the photometric in `Decoder::new`, so
 * both page counting and decoding have to route around it, and the luminance
 * has to come out physical rather than as an exponent blow-up.
 */
function sgiLogCorpus() {
	const dir = '/Users/florian/Projects/cursor/test_data/testfiles/scientific/openmicroscopy-tiff/libtiff';
	if (!fs.existsSync(path.join(dir, 'off_l16.tif'))) {
		console.log('  ⏭  SGI Log corpus not present, skipped');
		return;
	}
	const read = name => new Uint8Array(fs.readFileSync(path.join(dir, name)));
	const l16 = read('off_l16.tif');
	// Page counting must not fail on a photometric the crate rejects.
	assert.strictEqual(mod.tiff_page_count(l16), 1, 'page count works for SGI Log');
	const a = decode(l16);
	assert.deepStrictEqual([a.w, a.h, a.ch], [333, 225, 1]);
	assert.strictEqual(a.sf, 3, 'log luminance is delivered as float');
	const max = Math.max(...a.d), min = Math.min(...a.d);
	// A wrong byte-plane assembly produces exponents in the thousands; real
	// luminance for this scene is single/double digits.
	assert.ok(min > 0 && max > 1 && max < 1e3, `luminance range [${min}, ${max}] must be physical`);

	// The same scene stored as full LogLuv must agree on luminance.
	const luv = decode(read('off_luv32.tif'));
	assert.deepStrictEqual([luv.w, luv.h, luv.ch], [333, 225, 3]);
	let luvMax = 0;
	for (let i = 0; i < luv.d.length; i += 3) {
		luvMax = Math.max(luvMax, (luv.d[i] + luv.d[i + 1] + luv.d[i + 2]) / 3);
	}
	assert.ok(Math.abs(luvMax - max) / max < 0.25,
		`LogL max ${max} and LogLuv max ${luvMax} describe the same scene`);
	ok('SGI Log16 and LogLuv32 decode to consistent physical luminance');
}

async function main() {
	if (!fs.existsSync(wasmBin)) {
		console.log('⚠️  media/wasm/tiff-wasm.wasm not found — run `npm run build:wasm` first. Skipping.');
		return;
	}
	mod = await import(wasmJs.replace(/\\/g, '/'));
	await mod.default({ module_or_path: fs.readFileSync(wasmBin) });

	console.log('🧪 TIFF sample-layout matrix\n');
	stripRowsExceedingHeight();
	for (const bits of [4, 8, 16, 24]) { oddDepth(bits, true); }
	for (const bits of [16, 24]) { oddDepth(bits, false); }
	signedSamples();
	paletteSubByte();
	ycbcrSubsampled();
	sgiLogCorpus();
	console.log('\n' + '─'.repeat(60));
	console.log(`🎉 All ${checks} TIFF layout checks passed.\n`);
}

main().catch(err => { console.error('❌ TIFF layout matrix failed:'); console.error(err); process.exit(1); });
