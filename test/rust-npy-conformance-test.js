/**
 * Conformance tests for the Rust/WASM NPY/NPZ decoder
 * (wasm/tiff-decoder/src/formats/npy.rs) against the existing TypeScript
 * parser it is meant to be a bit-exact replacement for
 * (media/modules/npy-processor.ts `_parseNpy` / `_parseNpz`).
 *
 * For every *.npy/*.npz fixture in test-samples/, decodes with both
 * implementations and asserts identical width/height/channels/dtype/showNorm
 * and element-wise-identical pixel data (Object.is, so NaN/-0 compare
 * exactly).
 *
 * The fixtures cover very little of the dtype matrix (just f32/u16/u8), so
 * this also synthesizes minimal, spec-valid .npy/.npz buffers in memory to
 * exercise every dtype the TS parser special-cases, plus v1/v2 headers,
 * 2D/3D shapes (including the "unsupported channel count -> keep only the
 * first channel but still report the original channel count" quirk), and a
 * handful of negative/error cases that must reject identically.
 *
 * Run with: node test/rust-npy-conformance-test.js
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

// --- .npy synthesis helpers -------------------------------------------------

/**
 * Build a valid numpy v1/v2 header dict string, padded (with spaces, then a
 * trailing '\n') so that `prefixLen + header.length` is a multiple of 64 —
 * exactly as real numpy files are laid out. Keeping the data offset 64-byte
 * aligned means every element offset used below is also aligned to 1/2/4/8
 * bytes, so the TS parser's alignment-sensitive typed-array views (e.g.
 * `new Float32Array(buffer, off, elems)`, which throws a RangeError on
 * misaligned `off`) never hit that path in these fixtures.
 */
function padHeader(dictStr, prefixLen) {
	const totalLen = prefixLen + dictStr.length + 1; // +1 for trailing '\n'
	const padding = (64 - (totalLen % 64)) % 64;
	return dictStr + ' '.repeat(padding) + '\n';
}

function buildNpyRaw(dictStr, version, dataBytes) {
	const prefixLen = version === 1 ? 10 : 12;
	const header = padHeader(dictStr, prefixLen);
	const headerBuf = Buffer.from(header, 'latin1');
	const magic = Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]);
	const versionBuf = Buffer.from([version, 0]);
	let lenBuf;
	if (version === 1) {
		lenBuf = Buffer.alloc(2);
		lenBuf.writeUInt16LE(headerBuf.length, 0);
	} else {
		lenBuf = Buffer.alloc(4);
		lenBuf.writeUInt32LE(headerBuf.length, 0);
	}
	return Buffer.concat([magic, versionBuf, lenBuf, headerBuf, dataBytes || Buffer.alloc(0)]);
}

function buildNpy(dtype, shape, dataBytes, version = 1) {
	const shapeStr = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(', ')})`;
	const dict = `{'descr': '${dtype}', 'fortran_order': False, 'shape': ${shapeStr}, }`;
	return buildNpyRaw(dict, version, dataBytes);
}

/** Encodes `values` (plain JS numbers, or raw uint16 bit patterns for f2) as an npy raster. */
function encodeSamples(dtype, values) {
	if (dtype === '<f4' || dtype === '=f4' || dtype === '>f4') {
		const buf = Buffer.alloc(values.length * 4);
		const little = dtype !== '>f4';
		values.forEach((v, i) => (little ? buf.writeFloatLE(v, i * 4) : buf.writeFloatBE(v, i * 4)));
		return buf;
	}
	if (dtype.endsWith('f8')) {
		const buf = Buffer.alloc(values.length * 8);
		const little = dtype.startsWith('<') || dtype.startsWith('=');
		values.forEach((v, i) => (little ? buf.writeDoubleLE(v, i * 8) : buf.writeDoubleBE(v, i * 8)));
		return buf;
	}
	if (dtype.includes('f2')) {
		// `values` are raw uint16 half-float bit patterns, written directly —
		// avoids needing a float32->float16 encoder, and lets us hit exact
		// special-value bit patterns (subnormal, NaN, +-Inf, -0) precisely.
		const buf = Buffer.alloc(values.length * 2);
		const little = dtype.startsWith('<') || dtype.startsWith('=');
		values.forEach((v, i) => (little ? buf.writeUInt16LE(v, i * 2) : buf.writeUInt16BE(v, i * 2)));
		return buf;
	}
	// Integer dtypes: width is the last character of the dtype string.
	const width = parseInt(dtype.slice(-1), 10);
	const little = dtype.startsWith('<') || dtype.startsWith('=');
	const unsigned = dtype.includes('u');
	const buf = Buffer.alloc(values.length * width);
	values.forEach((v, i) => {
		const off = i * width;
		if (width === 1) {
			unsigned ? buf.writeUInt8(v, off) : buf.writeInt8(v, off);
		} else if (width === 2) {
			if (little) { unsigned ? buf.writeUInt16LE(v, off) : buf.writeInt16LE(v, off); }
			else { unsigned ? buf.writeUInt16BE(v, off) : buf.writeInt16BE(v, off); }
		} else if (width === 4) {
			if (little) { unsigned ? buf.writeUInt32LE(v, off) : buf.writeInt32LE(v, off); }
			else { unsigned ? buf.writeUInt32BE(v, off) : buf.writeInt32BE(v, off); }
		} else if (width === 8) {
			const bv = BigInt(v);
			if (little) { unsigned ? buf.writeBigUInt64LE(bv, off) : buf.writeBigInt64LE(bv, off); }
			else { unsigned ? buf.writeBigUInt64BE(bv, off) : buf.writeBigInt64BE(bv, off); }
		}
	});
	return buf;
}

// --- .npz synthesis helpers -------------------------------------------------

/** A minimal ZIP "stored" (uncompressed) local file header + data — enough for the
 * byte-wise local-header scan both decoders use; no central directory needed. */
function buildNpzEntry(name, npyBuf) {
	const header = Buffer.alloc(30);
	header.writeUInt32LE(0x04034b50, 0);
	header.writeUInt16LE(20, 4); // version needed
	header.writeUInt16LE(0, 6); // flags
	header.writeUInt16LE(0, 8); // compression method = stored
	header.writeUInt16LE(0, 10); // mod time
	header.writeUInt16LE(0, 12); // mod date
	header.writeUInt32LE(0, 14); // crc32 (unchecked by either decoder)
	header.writeUInt32LE(npyBuf.length, 18); // compressed size
	header.writeUInt32LE(npyBuf.length, 22); // uncompressed size
	const nameBuf = Buffer.from(name, 'utf8');
	header.writeUInt16LE(nameBuf.length, 26);
	header.writeUInt16LE(0, 28); // extra field length
	return Buffer.concat([header, nameBuf, npyBuf]);
}

function buildNpz(entries) {
	return Buffer.concat(entries.map(([name, buf]) => buildNpzEntry(name, buf)));
}

async function main() {
	if (!fs.existsSync(wasmBin)) {
		console.log('⚠️  media/wasm/tiff-wasm.wasm not found — run `npm run build:wasm` first. Skipping.');
		return;
	}

	const mod = await import(wasmJs.replace(/\\/g, '/'));
	await mod.default({ module_or_path: fs.readFileSync(wasmBin) });

	const { NpyProcessor } = await import(
		path.join('..', 'out', 'media', 'modules', 'npy-processor.js').replace(/\\/g, '/')
	);
	const tsParser = new NpyProcessor(/** @type {any} */ (null), null);

	console.log('🧪 Running Rust/WASM NPY/NPZ conformance tests...\n');

	let count = 0;

	function compare(label, tsResult, rustResult) {
		const rustData = rustResult.take_data_as_f32();
		assert.strictEqual(rustResult.width, tsResult.width, `${label}: width`);
		assert.strictEqual(rustResult.height, tsResult.height, `${label}: height`);
		assert.strictEqual(rustResult.channels, tsResult.channels, `${label}: channels`);
		assert.strictEqual(rustResult.dtype, tsResult.dtype, `${label}: dtype`);
		assert.strictEqual(rustResult.show_norm, tsResult.showNorm, `${label}: showNorm`);
		assert.strictEqual(rustData.length, tsResult.data.length, `${label}: data length`);
		for (let i = 0; i < tsResult.data.length; i++) {
			assert.ok(Object.is(rustData[i], tsResult.data[i]),
				`${label}: pixel ${i} mismatch (ts=${tsResult.data[i]}, rust=${rustData[i]})`);
		}
		console.log(`✅ ${label} -> ${tsResult.width}x${tsResult.height} ch=${tsResult.channels} dtype=${tsResult.dtype}`);
		count++;
	}

	// --- Fixtures -------------------------------------------------------------
	const npyFiles = fs.readdirSync(samplesDir).filter(f => f.toLowerCase().endsWith('.npy'));
	for (const file of npyFiles) {
		const buf = fs.readFileSync(path.join(samplesDir, file));
		const ts = tsParser._parseNpy(bufferToArrayBuffer(buf));
		const rust = mod.decode_npy_fast(new Uint8Array(buf));
		compare(`fixture ${file}`, ts, rust);
	}
	const npzFiles = fs.readdirSync(samplesDir).filter(f => f.toLowerCase().endsWith('.npz'));
	for (const file of npzFiles) {
		const buf = fs.readFileSync(path.join(samplesDir, file));
		const ts = tsParser._parseNpz(bufferToArrayBuffer(buf));
		const rust = mod.decode_npy_fast(new Uint8Array(buf));
		compare(`fixture ${file}`, ts, rust);
	}

	// --- Synthesized dtype matrix ---------------------------------------------
	// Every dtype branch the TS parser special-cases, each with values chosen
	// to stress it: 0, negatives, type maxima/minima, and (for float types)
	// NaN, +Inf, -Inf, -0.
	const dtypeCases = [
		['<f4', [0, -1.5, 3.4028235e38, -3.4028235e38, NaN, Infinity, -Infinity, -0]],
		['>f4', [0, -1.5, 3.4028235e38, -3.4028235e38, NaN, Infinity, -Infinity, -0]],
		// '>f8' is included deliberately: the TS parser's `endsWith('f8')`
		// branch ignores the '>' prefix and always reads little-endian, so
		// decoding a genuinely big-endian buffer produces "wrong" (garbage)
		// values on both sides identically. That is exactly what this test
		// checks — TS and Rust must be wrong in the SAME way.
		['<f8', [0, -123456.789, 1.7976931348623157e308, -1.7976931348623157e308, NaN, Infinity, -Infinity, -0]],
		['>f8', [0, -123456.789, 1.7976931348623157e308, -1.7976931348623157e308, NaN, Infinity, -Infinity, -0]],
		// f2: raw half-float bit patterns (not JS numbers) — see encodeSamples.
		// 0x0000=+0, 0x8000=-0, 0x7bff=max finite, 0xfbff=-max finite,
		// 0x0001=smallest subnormal, 0x7c00=+Inf, 0xfc00=-Inf, 0x7e00=NaN.
		['<f2', [0x0000, 0x8000, 0x7bff, 0xfbff, 0x0001, 0x7c00, 0xfc00, 0x7e00]],
		['>f2', [0x0000, 0x8000, 0x7bff, 0xfbff, 0x0001, 0x7c00, 0xfc00, 0x7e00]],
		['|u1', [0, 255, 1, 128]],
		['|i1', [0, -128, 127, -1]],
		['<u2', [0, 65535, 1, 32768]],
		['>u2', [0, 65535, 1, 32768]],
		['<i2', [0, -32768, 32767, -1]],
		['<u4', [0, 4294967295, 1, 2147483648]],
		['>u4', [0, 4294967295, 1, 2147483648]],
		['<i4', [0, -2147483648, 2147483647, -1]],
		['<u8', [0, 1, '18446744073709551615', '9007199254740993']],
		['<i8', [0, -1, '9223372036854775807', '-9223372036854775808']],
	];
	for (const [dtype, values] of dtypeCases) {
		const dataBytes = encodeSamples(dtype, values);
		const buf = buildNpy(dtype, [1, values.length], dataBytes);
		const ts = tsParser._parseNpy(bufferToArrayBuffer(buf));
		const rust = mod.decode_npy_fast(new Uint8Array(buf));
		compare(`dtype ${dtype}`, ts, rust);
	}

	// --- v2 header (u32 header length) -----------------------------------------
	{
		const values = [0, -1, 42.5, NaN];
		const dataBytes = encodeSamples('<f4', values);
		const buf = buildNpy('<f4', [1, values.length], dataBytes, 2);
		const ts = tsParser._parseNpy(bufferToArrayBuffer(buf));
		const rust = mod.decode_npy_fast(new Uint8Array(buf));
		compare('v2 header', ts, rust);
	}

	// --- 2D shape (already exercised above, explicit case for clarity) --------
	{
		const values = [1, 2, 3, 4, 5, 6];
		const dataBytes = encodeSamples('<u2', values);
		const buf = buildNpy('<u2', [2, 3], dataBytes);
		const ts = tsParser._parseNpy(bufferToArrayBuffer(buf));
		const rust = mod.decode_npy_fast(new Uint8Array(buf));
		compare('2D shape', ts, rust);
	}

	// --- 3D shape, channels=3 --------------------------------------------------
	{
		const height = 2, width = 3, channels = 3;
		const values = Array.from({ length: height * width * channels }, (_, i) => i);
		const dataBytes = encodeSamples('<f4', values);
		const buf = buildNpy('<f4', [height, width, channels], dataBytes);
		const ts = tsParser._parseNpy(bufferToArrayBuffer(buf));
		const rust = mod.decode_npy_fast(new Uint8Array(buf));
		compare('3D shape channels=3', ts, rust);
		assert.strictEqual(ts.channels, 3);
	}

	// --- 3D shape, channels=4 --------------------------------------------------
	{
		const height = 2, width = 2, channels = 4;
		const values = Array.from({ length: height * width * channels }, (_, i) => i * 1.5);
		const dataBytes = encodeSamples('<f4', values);
		const buf = buildNpy('<f4', [height, width, channels], dataBytes);
		const ts = tsParser._parseNpy(bufferToArrayBuffer(buf));
		const rust = mod.decode_npy_fast(new Uint8Array(buf));
		compare('3D shape channels=4', ts, rust);
		assert.strictEqual(ts.channels, 4);
	}

	// --- 3D shape, channels=2 (the "take first channel only, but still report
	//     channels=2" quirk) ------------------------------------------------
	{
		const height = 2, width = 3, channels = 2;
		const values = Array.from({ length: height * width * channels }, (_, i) => i + 0.25);
		const dataBytes = encodeSamples('<f4', values);
		const buf = buildNpy('<f4', [height, width, channels], dataBytes);
		const ts = tsParser._parseNpy(bufferToArrayBuffer(buf));
		const rust = mod.decode_npy_fast(new Uint8Array(buf));
		compare('3D shape channels=2 (first-channel-only quirk)', ts, rust);
		assert.strictEqual(ts.channels, 2, 'channels must still be reported as 2');
		assert.strictEqual(ts.data.length, height * width, 'TS: data must be only the first channel');
	}

	// --- Negative cases: TS and Rust must reject with the SAME error text ------

	function assertSameError(label, buildBuf) {
		const buf = buildBuf();
		const tsError = getErrorMessage(() => tsParser._parseNpy(bufferToArrayBuffer(buf)));
		const rustError = getErrorMessage(() => mod.decode_npy_fast(new Uint8Array(buf)));
		assert.ok(tsError, `${label}: TS should reject`);
		assert.ok(rustError, `${label}: Rust should reject`);
		assert.strictEqual(rustError, tsError, `${label}: error text must match`);
		console.log(`✅ ${label} rejected identically: "${tsError}"`);
		count++;
	}

	assertSameError('bad magic', () => Buffer.from('NOTNPYFILEDATA0123456789', 'latin1'));

	assertSameError('unsupported version (major=3)', () => {
		const magic = Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]);
		const versionBuf = Buffer.from([3, 0]);
		const lenBuf = Buffer.alloc(2);
		lenBuf.writeUInt16LE(0, 0);
		return Buffer.concat([magic, versionBuf, lenBuf]);
	});

	assertSameError('missing shape', () => {
		const dict = `{'descr': '<f4', 'fortran_order': False, }`;
		return buildNpyRaw(dict, 1, Buffer.alloc(0));
	});

	assertSameError('missing dtype', () => {
		const dict = `{'fortran_order': False, 'shape': (1, 1), }`;
		return buildNpyRaw(dict, 1, Buffer.alloc(0));
	});

	assertSameError('4D shape', () => {
		const dataBytes = encodeSamples('<f4', [1, 2, 3, 4, 5, 6, 7, 8]);
		return buildNpy('<f4', [2, 2, 2, 1], dataBytes);
	});

	// --- NPZ: multi-entry selection (case-insensitive depth|dispar|inv|z|range) -
	{
		const other = buildNpy('<f4', [1, 4], encodeSamples('<f4', [1, 2, 3, 4]));
		const depth = buildNpy('<f4', [1, 4], encodeSamples('<f4', [10, 20, 30, 40]));
		const buf = buildNpz([['other.npy', other], ['DEPTH_map.npy', depth]]);
		const ts = tsParser._parseNpz(bufferToArrayBuffer(buf));
		const rust = mod.decode_npy_fast(new Uint8Array(buf));
		compare('NPZ multi-entry selection (case-insensitive "depth")', ts, rust);
		assert.deepStrictEqual(Array.from(ts.data), [10, 20, 30, 40], 'must have picked the depth-matching entry');
	}

	// --- NPZ: no entry qualifies (all compressed) -> same error -----------------
	{
		const entryNpy = buildNpy('<f4', [1, 2], encodeSamples('<f4', [1, 2]));
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(0, 6);
		header.writeUInt16LE(8, 8); // compression method = 8 (deflate), not stored
		header.writeUInt16LE(0, 10);
		header.writeUInt16LE(0, 12);
		header.writeUInt32LE(0, 14);
		header.writeUInt32LE(entryNpy.length, 18);
		header.writeUInt32LE(entryNpy.length, 22);
		const nameBuf = Buffer.from('compressed.npy', 'utf8');
		header.writeUInt16LE(nameBuf.length, 26);
		header.writeUInt16LE(0, 28);
		const buf = Buffer.concat([header, nameBuf, entryNpy]);

		const tsError = getErrorMessage(() => tsParser._parseNpz(bufferToArrayBuffer(buf)));
		const rustError = getErrorMessage(() => mod.decode_npy_fast(new Uint8Array(buf)));
		assert.ok(tsError, 'TS should reject an NPZ with no uncompressed .npy entries');
		assert.ok(rustError, 'Rust should reject an NPZ with no uncompressed .npy entries');
		assert.strictEqual(rustError, tsError, 'NPZ "no uncompressed .npy arrays" error text must match');
		console.log(`✅ NPZ with only compressed entries rejected identically: "${tsError}"`);
		count++;
	}

	console.log(`\n🎉 All ${count} Rust/WASM NPY/NPZ conformance checks passed.\n`);
	console.log('Note: no case in this suite exercises the TS-only "misaligned typed-array view throws' +
		' RangeError" quirk — every synthesized .npy header here is padded to a 64-byte boundary' +
		' (as real numpy files are), which keeps every element offset aligned to 1/2/4/8 bytes, so' +
		' that TS-specific failure mode is never reached by construction.');
}

main().catch(err => {
	console.error('❌ Rust/WASM NPY/NPZ conformance test failed:');
	console.error(err);
	process.exit(1);
});
