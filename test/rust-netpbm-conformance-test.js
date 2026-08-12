/**
 * Conformance tests for the Rust/WASM PFM and NetPBM (PBM/PGM/PPM) decoders
 * (wasm/tiff-decoder/src/formats/pfm.rs, netpbm.rs) against the existing
 * TypeScript parsers they are meant to be bit-exact replacements for
 * (media/modules/pfm-processor.ts `_parsePfm`, ppm-processor.ts `_parsePpm`).
 *
 * For every *.pfm/*.ppm/*.pgm/*.pbm fixture in test-samples/, decodes with
 * both implementations and asserts identical shape/metadata and
 * element-wise-identical pixel data (Object.is for PFM floats, so NaN/-0 are
 * compared exactly; strict equality for NetPBM integers).
 *
 * Also covers three negative cases where TS and Rust must reject the same
 * malformed input with the same error: a bad magic number, a truncated
 * binary raster, and a P4 (binary PBM) file whose header has no separating
 * whitespace and whose raster incidentally starts with a byte value that is
 * itself a whitespace code point — which fools the "skip one optional
 * separator" logic into swallowing a real data byte, producing a data
 * shortfall that both implementations must report identically.
 *
 * Run with: node test/rust-netpbm-conformance-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const samplesDir = path.join(__dirname, '..', 'test-samples');
const wasmJs = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.js');
const wasmBin = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.wasm');

function bufferToArrayBuffer(buf) {
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function getErrorMessage(fn) {
	try {
		fn();
		return null;
	} catch (e) {
		return String((e && e.message) || e);
	}
}

async function main() {
	if (!fs.existsSync(wasmBin)) {
		console.log('⚠️  media/wasm/tiff-wasm.wasm not found — run `npm run build:wasm` first. Skipping.');
		return;
	}

	const mod = await import(wasmJs.replace(/\\/g, '/'));
	await mod.default({ module_or_path: fs.readFileSync(wasmBin) });

	const { PfmProcessor } = await import(
		path.join('..', 'out', 'media', 'modules', 'pfm-processor.js').replace(/\\/g, '/')
	);
	const { PpmProcessor } = await import(
		path.join('..', 'out', 'media', 'modules', 'ppm-processor.js').replace(/\\/g, '/')
	);
	const pfmParser = new PfmProcessor(/** @type {any} */ (null), null);
	const ppmParser = new PpmProcessor(/** @type {any} */ (null), null);

	console.log('🧪 Running Rust/WASM PFM + NetPBM conformance tests...\n');

	let count = 0;

	// --- PFM fixtures -------------------------------------------------------
	const pfmFiles = fs.readdirSync(samplesDir).filter(f => f.toLowerCase().endsWith('.pfm'));
	for (const file of pfmFiles) {
		const buf = fs.readFileSync(path.join(samplesDir, file));
		const ts = pfmParser._parsePfm(bufferToArrayBuffer(buf), { topDown: true });
		const rust = mod.decode_pfm_fast(new Uint8Array(buf), true);
		const rustData = rust.take_data_as_f32();

		assert.strictEqual(rust.width, ts.width, `${file}: width`);
		assert.strictEqual(rust.height, ts.height, `${file}: height`);
		assert.strictEqual(rust.channels, ts.channels, `${file}: channels`);
		assert.strictEqual(rustData.length, ts.data.length, `${file}: data length`);
		for (let i = 0; i < ts.data.length; i++) {
			assert.ok(Object.is(rustData[i], ts.data[i]),
				`${file}: pixel ${i} mismatch (ts=${ts.data[i]}, rust=${rustData[i]})`);
		}
		console.log(`✅ PFM ${file} -> ${ts.width}x${ts.height} ch=${ts.channels}`);
		count++;
	}

	// --- NetPBM fixtures ------------------------------------------------------
	const netpbmFiles = fs.readdirSync(samplesDir)
		.filter(f => /\.(ppm|pgm|pbm)$/i.test(f));
	for (const file of netpbmFiles) {
		const buf = fs.readFileSync(path.join(samplesDir, file));
		const ts = ppmParser._parsePpm(bufferToArrayBuffer(buf));
		const rust = mod.decode_ppm_fast(new Uint8Array(buf));
		const rustData = rust.is_16bit ? rust.take_data_as_u16() : rust.take_data_as_u8();

		assert.strictEqual(rust.width, ts.width, `${file}: width`);
		assert.strictEqual(rust.height, ts.height, `${file}: height`);
		assert.strictEqual(rust.channels, ts.channels, `${file}: channels`);
		assert.strictEqual(rust.maxval, ts.maxval, `${file}: maxval`);
		assert.strictEqual(rust.format, ts.format, `${file}: format`);
		const tsIs16Bit = ts.data instanceof Uint16Array;
		assert.strictEqual(rust.is_16bit, tsIs16Bit, `${file}: is_16bit`);
		assert.strictEqual(rustData.length, ts.data.length, `${file}: data length`);
		for (let i = 0; i < ts.data.length; i++) {
			assert.strictEqual(rustData[i], ts.data[i], `${file}: pixel ${i} mismatch`);
		}
		console.log(`✅ ${ts.format} ${file} -> ${ts.width}x${ts.height} ch=${ts.channels} maxval=${ts.maxval}`);
		count++;
	}

	// --- Synthesized cases for paths no fixture reaches ---------------------
	//
	// The checked-in fixtures leave the two most error-prone branches of the
	// port completely uncovered: every binary NetPBM fixture has maxval <= 255
	// (so the big-endian 16-bit raster path never runs) and both PFM fixtures
	// have a negative scale (so the big-endian float path never runs). These
	// build the missing inputs in memory rather than adding binary fixtures.

	// Binary 16-bit NetPBM (P5/P6). Samples are big-endian per the NetPBM
	// spec; the TS parser reads them through a Uint16Array view plus an
	// in-place byte swap, and that view has an alignment-dependent branch
	// (`offset % 2 === 0`), so both header parities are built here.
	{
		const build = (magic, channels, comment) => {
			const header = Buffer.from(`${magic}\n${comment}4 3\n65535\n`, 'latin1');
			const values = 4 * 3 * channels;
			const raster = Buffer.alloc(values * 2);
			for (let i = 0; i < values; i++) {
				// Spread across the 16-bit range, including 0 and 65535, and
				// use asymmetric byte pairs so a missing swap cannot pass.
				const v = Math.min(65535, i * 5000 + (i % 2 ? 1 : 0));
				raster.writeUInt16BE(v, i * 2);
			}
			return Buffer.concat([header, raster]);
		};
		const cases = [
			['P5 16-bit, even raster offset', build('P5', 1, '')],
			['P5 16-bit, odd raster offset', build('P5', 1, '# c\n')],
			['P6 16-bit, even raster offset', build('P6', 3, '')],
			['P6 16-bit, odd raster offset', build('P6', 3, '# c\n')],
		];
		for (const [label, bytes] of cases) {
			const ts = ppmParser._parsePpm(bufferToArrayBuffer(bytes));
			const rust = mod.decode_ppm_fast(new Uint8Array(bytes));
			assert.strictEqual(rust.is_16bit, true, `${label}: should use the 16-bit carrier`);
			assert.ok(ts.data instanceof Uint16Array, `${label}: TS should use the 16-bit carrier`);
			assert.strictEqual(rust.maxval, ts.maxval, `${label}: maxval`);
			assert.strictEqual(rust.format, ts.format, `${label}: format`);
			const rustData = rust.take_data_as_u16();
			assert.strictEqual(rustData.length, ts.data.length, `${label}: data length`);
			for (let i = 0; i < ts.data.length; i++) {
				assert.strictEqual(rustData[i], ts.data[i],
					`${label}: sample ${i} mismatch (ts=${ts.data[i]}, rust=${rustData[i]}) — byte order?`);
			}
			console.log(`✅ ${label} matches (${ts.width}x${ts.height} ch=${ts.channels})`);
			count++;
		}
	}

	// PFM: big-endian samples (positive scale), and both topDown orientations.
	// Includes NaN/+-Infinity, which this project treats as a correctness
	// invariant rather than an edge case, and -0 so Object.is has something to
	// distinguish.
	{
		const specials = [NaN, Infinity, -Infinity, -0, 0, 1.5, -2.25, 3.4e38];
		const build = (magic, channels, littleEndian) => {
			const width = 4;
			const height = 3;
			const scale = littleEndian ? '-1.0' : '1.0';
			const header = Buffer.from(`${magic}\n${width} ${height}\n${scale}\n`, 'latin1');
			const values = width * height * channels;
			const raster = Buffer.alloc(values * 4);
			for (let i = 0; i < values; i++) {
				const v = specials[i % specials.length];
				if (littleEndian) { raster.writeFloatLE(v, i * 4); }
				else { raster.writeFloatBE(v, i * 4); }
			}
			return Buffer.concat([header, raster]);
		};
		const cases = [];
		for (const [magic, channels] of [['Pf', 1], ['PF', 3]]) {
			for (const littleEndian of [true, false]) {
				for (const topDown of [true, false]) {
					cases.push([
						`PFM ${magic} ${littleEndian ? 'little' : 'big'}-endian topDown=${topDown}`,
						build(magic, channels, littleEndian),
						topDown,
					]);
				}
			}
		}
		for (const [label, bytes, topDown] of cases) {
			const ts = pfmParser._parsePfm(bufferToArrayBuffer(bytes), { topDown });
			const rust = mod.decode_pfm_fast(new Uint8Array(bytes), topDown);
			assert.strictEqual(rust.width, ts.width, `${label}: width`);
			assert.strictEqual(rust.height, ts.height, `${label}: height`);
			assert.strictEqual(rust.channels, ts.channels, `${label}: channels`);
			const rustData = rust.take_data_as_f32();
			assert.strictEqual(rustData.length, ts.data.length, `${label}: data length`);
			for (let i = 0; i < ts.data.length; i++) {
				assert.ok(Object.is(rustData[i], ts.data[i]),
					`${label}: sample ${i} mismatch (ts=${ts.data[i]}, rust=${rustData[i]})`);
			}
			console.log(`✅ ${label} matches`);
			count++;
		}
	}

	// --- Negative cases ---------------------------------------------------

	// 1. Bad magic number.
	{
		const bytes = Buffer.from('P9\n4 4\n255\n', 'latin1');
		const tsError = getErrorMessage(() => ppmParser._parsePpm(bufferToArrayBuffer(bytes)));
		const rustError = getErrorMessage(() => mod.decode_ppm_fast(new Uint8Array(bytes)));
		assert.ok(tsError, 'TS should reject bad magic');
		assert.ok(rustError, 'Rust should reject bad magic');
		assert.strictEqual(rustError, tsError, 'bad magic error text must match');
		console.log(`✅ Bad magic rejected identically: "${tsError}"`);
		count++;
	}

	// 2. Truncated binary raster (P5, 4x4 8-bit, only 4 of 16 raster bytes present).
	{
		const header = Buffer.from('P5\n4 4\n255\n', 'latin1');
		const raster = Buffer.from([1, 2, 3, 4]); // needs 16 bytes, only 4 given
		const bytes = Buffer.concat([header, raster]);
		const tsError = getErrorMessage(() => ppmParser._parsePpm(bufferToArrayBuffer(bytes)));
		const rustError = getErrorMessage(() => mod.decode_ppm_fast(new Uint8Array(bytes)));
		assert.ok(tsError, 'TS should reject truncated binary raster');
		assert.ok(rustError, 'Rust should reject truncated binary raster');
		assert.strictEqual(rustError, tsError, 'truncated raster error text must match');
		console.log(`✅ Truncated binary raster rejected identically: "${tsError}"`);
		count++;
	}

	// 3. P4 (binary PBM) with no separating whitespace between the header and
	//    the raster, where the raster's first (only) byte happens to equal a
	//    whitespace code point (0x0A / LF). Both implementations' "skip one
	//    optional separator byte" logic mistakes that data byte for the
	//    separator, then find the raster one byte short.
	{
		// "P4\n8 1" + raster byte 0x0A, no header/raster separator.
		const header = Buffer.from('P4\n8 1', 'latin1');
		const raster = Buffer.from([0x0a]);
		const bytes = Buffer.concat([header, raster]);
		const tsError = getErrorMessage(() => ppmParser._parsePpm(bufferToArrayBuffer(bytes)));
		const rustError = getErrorMessage(() => mod.decode_ppm_fast(new Uint8Array(bytes)));
		assert.ok(tsError, 'TS should reject the whitespace-swallowed P4 raster');
		assert.ok(rustError, 'Rust should reject the whitespace-swallowed P4 raster');
		assert.strictEqual(rustError, tsError, 'P4 missing-whitespace error text must match');
		console.log(`✅ P4 missing-whitespace raster shortfall rejected identically: "${tsError}"`);
		count++;
	}

	console.log(`\n🎉 All ${count} Rust/WASM PFM + NetPBM conformance checks passed.\n`);
}

main().catch(err => {
	console.error('❌ Rust/WASM PFM + NetPBM conformance test failed:');
	console.error(err);
	process.exit(1);
});
