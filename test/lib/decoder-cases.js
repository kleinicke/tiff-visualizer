/**
 * Shared case definitions for the Rust/WASM conformance suites:
 *   test/rust-netpbm-conformance-test.js
 *   test/rust-npy-conformance-test.js
 *   test/rust-scientific-conformance-test.js
 *
 * This module is the SINGLE source of truth for every input (file fixture or
 * in-memory synthesized buffer) those suites decode. It intentionally knows
 * nothing about the TS parsers, the Rust/WASM module, or golden files — it
 * only builds bytes + decode options and hands back a flat list of Cases.
 * Both `scripts/capture-goldens.js` (Rust-only) and the three suites
 * (Rust + TS + golden) consume the same list, so there is exactly one
 * definition of "what the inputs are".
 *
 * Case shape:
 *   {
 *     id:       string,   // stable, filesystem-safe, unique — names golden files
 *     format:   'pfm' | 'ppm' | 'npy' | 'fits' | 'netcdf' | 'dicom',
 *     bytes:    Buffer,   // exact input bytes
 *     options:  object,   // decoder options: {topDown} for pfm, {} for ppm,
 *                         // NetCDF option object for netcdf, {frameIndex} for
 *                         // dicom, {} for npy
 *     external: boolean,  // true if sourced from the private corpus at
 *                         // /Users/florian/Projects/cursor/test_data/testfiles
 *     expectError: boolean, // true for cases hand-authored as negative cases
 *                            // that must be rejected. False (the default) for
 *                            // real-file fixtures does NOT guarantee the file
 *                            // decodes cleanly — some corpus files are
 *                            // legitimately refused (e.g. a FITS whose only
 *                            // HDUs are tables). Both the capture script and
 *                            // the suites always determine success/failure
 *                            // empirically (try/catch) rather than trusting
 *                            // this flag blindly; the flag is authoritative
 *                            // only for the explicitly-authored negative cases
 *                            // below, where it is always true.
 *   }
 *
 * A handful of cases carry extra, non-schema fields consumed only by the
 * hand-computed "absolute value" assertions in the three suites (see each
 * suite's Part 3 comments for why those checks exist independently of the
 * golden/TS-vs-Rust comparisons):
 *   - `expectedData`: number[] (may contain NaN/Infinity/-Infinity/-0) — the
 *     full expected decoded sample array, independently computed.
 *   - `expectedMeta`: plain object of extra field checks, e.g.
 *     { firstPlaneOnly: true } or { variable: 'second' }.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const samplesDir = path.join(__dirname, '..', '..', 'test-samples');
const scientificSamplesDir = path.join(samplesDir, 'scientific');
const externalScientificDir = '/Users/florian/Projects/cursor/test_data/testfiles/scientific';

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function bufferToArrayBuffer(buf) {
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Slugifies a human-readable label into a stable, filesystem-safe id
 * fragment: lowercase, non-alnum runs collapsed to single hyphens, no
 * leading/trailing hyphens. */
function slugify(label) {
	return String(label)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** Dtype strings use symbols ('<', '>', '|') that `slugify` would otherwise
 * collapse into indistinguishable dashes (e.g. '<f4' and '>f4' would both
 * become "f4"). Spell out the byte-order/no-order prefix first so ids stay
 * unique and readable. */
function dtypeSlug(dtype) {
	const prefix = dtype[0] === '<' ? 'le-' : dtype[0] === '>' ? 'be-' : dtype[0] === '|' ? 'x-' : '';
	return prefix + slugify(dtype.slice(1));
}

// =============================================================================
// PFM + NetPBM (PBM/PGM/PPM)
// =============================================================================

function buildNetpbm16BitCase(magic, channels, comment) {
	const header = Buffer.from(`${magic}\n${comment}4 3\n65535\n`, 'latin1');
	const values = 4 * 3 * channels;
	const raster = Buffer.alloc(values * 2);
	for (let i = 0; i < values; i++) {
		// Spread across the 16-bit range, including 0 and 65535, and use
		// asymmetric byte pairs so a missing swap cannot pass.
		const v = Math.min(65535, i * 5000 + (i % 2 ? 1 : 0));
		raster.writeUInt16BE(v, i * 2);
	}
	return Buffer.concat([header, raster]);
}

function buildPfmEndianCase(magic, channels, littleEndian) {
	const width = 4;
	const height = 3;
	const specials = [NaN, Infinity, -Infinity, -0, 0, 1.5, -2.25, 3.4e38];
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
}

function listPfmNetpbmCases() {
	const cases = [];

	// --- PFM fixtures -------------------------------------------------------
	if (fs.existsSync(samplesDir)) {
		const pfmFiles = fs.readdirSync(samplesDir).filter(f => f.toLowerCase().endsWith('.pfm'));
		for (const file of pfmFiles) {
			cases.push({
				id: `pfm-fixture-${slugify(file)}`,
				format: 'pfm',
				bytes: fs.readFileSync(path.join(samplesDir, file)),
				options: { topDown: true },
				external: false,
				expectError: false,
				sourceFile: file,
			});
		}

		// --- NetPBM fixtures --------------------------------------------------
		const netpbmFiles = fs.readdirSync(samplesDir).filter(f => /\.(ppm|pgm|pbm)$/i.test(f));
		for (const file of netpbmFiles) {
			cases.push({
				id: `netpbm-fixture-${slugify(file)}`,
				format: 'ppm',
				bytes: fs.readFileSync(path.join(samplesDir, file)),
				options: {},
				external: false,
				expectError: false,
				sourceFile: file,
			});
		}
	}

	// --- Synthesized: big-endian 16-bit NetPBM (P5/P6) ----------------------
	// The checked-in binary fixtures all have maxval <= 255, so the
	// big-endian 16-bit raster path never runs without these. Samples are
	// big-endian per the NetPBM spec; the TS parser reads them through a
	// Uint16Array view plus an in-place byte swap, and that view has an
	// alignment-dependent branch (`offset % 2 === 0`), so both header
	// parities are built here.
	const netpbm16BitCases = [
		['P5 16-bit, even raster offset', 'P5', 1, ''],
		['P5 16-bit, odd raster offset', 'P5', 1, '# c\n'],
		['P6 16-bit, even raster offset', 'P6', 3, ''],
		['P6 16-bit, odd raster offset', 'P6', 3, '# c\n'],
	];
	for (const [label, magic, channels, comment] of netpbm16BitCases) {
		cases.push({
			id: `netpbm-${slugify(label)}`,
			format: 'ppm',
			bytes: buildNetpbm16BitCase(magic, channels, comment),
			options: {},
			external: false,
			expectError: false,
			label,
		});
	}

	// --- Synthesized: PFM big-endian samples + both topDown orientations ----
	// Includes NaN/+-Infinity (a correctness invariant in this project) and
	// -0 so Object.is has something to distinguish. Both checked-in PFM
	// fixtures have a negative scale, so the big-endian float path never
	// runs without this.
	for (const [magic, channels] of [['Pf', 1], ['PF', 3]]) {
		for (const littleEndian of [true, false]) {
			for (const topDown of [true, false]) {
				const label = `PFM ${magic} ${littleEndian ? 'little' : 'big'}-endian topDown=${topDown}`;
				// slugify lowercases, so 'Pf' (1-channel) and 'PF' (3-channel)
				// would otherwise collide on id — spell out the channel count
				// instead of relying on magic-string case.
				cases.push({
					id: `pfm-${channels}ch-${slugify(label.replace(/^PFM \S+ /, ''))}`,
					format: 'pfm',
					bytes: buildPfmEndianCase(magic, channels, littleEndian),
					options: { topDown },
					external: false,
					expectError: false,
					label,
				});
			}
		}
	}

	// --- Negative cases -------------------------------------------------------

	// 1. Bad magic number.
	cases.push({
		id: 'netpbm-bad-magic',
		format: 'ppm',
		bytes: Buffer.from('P9\n4 4\n255\n', 'latin1'),
		options: {},
		external: false,
		expectError: true,
		label: 'Bad magic',
	});

	// 2. Truncated binary raster (P5, 4x4 8-bit, only 4 of 16 raster bytes present).
	cases.push({
		id: 'netpbm-truncated-binary-raster',
		format: 'ppm',
		bytes: Buffer.concat([Buffer.from('P5\n4 4\n255\n', 'latin1'), Buffer.from([1, 2, 3, 4])]),
		options: {},
		external: false,
		expectError: true,
		label: 'Truncated binary raster',
	});

	// 3. P4 (binary PBM) with no separating whitespace between the header and
	//    the raster, where the raster's first (only) byte happens to equal a
	//    whitespace code point (0x0A / LF). Both implementations' "skip one
	//    optional separator byte" logic mistakes that data byte for the
	//    separator, then find the raster one byte short.
	cases.push({
		id: 'netpbm-p4-missing-whitespace',
		format: 'ppm',
		bytes: Buffer.concat([Buffer.from('P4\n8 1', 'latin1'), Buffer.from([0x0a])]),
		options: {},
		external: false,
		expectError: true,
		label: 'P4 missing-whitespace raster shortfall',
	});

	return cases;
}

// =============================================================================
// NPY / NPZ
// =============================================================================

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

/** A minimal ZIP "stored" (uncompressed) local file header + data — enough for the
 * byte-wise local-header scan both decoders use; no central directory needed. */
function buildNpzEntry(name, npyBuf, opts = {}) {
	const header = Buffer.alloc(30);
	header.writeUInt32LE(0x04034b50, 0);
	header.writeUInt16LE(20, 4); // version needed
	header.writeUInt16LE(opts.flags || 0, 6); // flags
	header.writeUInt16LE(opts.compression || 0, 8); // compression method
	header.writeUInt16LE(0, 10); // mod time
	header.writeUInt16LE(0, 12); // mod date
	header.writeUInt32LE(0, 14); // crc32 (unchecked by either decoder)
	const size = opts.sizeOverride !== undefined ? opts.sizeOverride : npyBuf.length;
	header.writeUInt32LE(size, 18); // compressed size
	header.writeUInt32LE(size, 22); // uncompressed size
	const nameBuf = Buffer.from(name, 'utf8');
	header.writeUInt16LE(nameBuf.length, 26);
	header.writeUInt16LE(0, 28); // extra field length
	return Buffer.concat([header, nameBuf, npyBuf]);
}

function buildNpz(entries) {
	return Buffer.concat(entries.map(([name, buf]) => buildNpzEntry(name, buf)));
}

function listNpyCases() {
	const cases = [];

	// --- Fixtures -------------------------------------------------------------
	if (fs.existsSync(samplesDir)) {
		const npyFiles = fs.readdirSync(samplesDir).filter(f => f.toLowerCase().endsWith('.npy'));
		for (const file of npyFiles) {
			cases.push({
				id: `npy-fixture-${slugify(file)}`,
				format: 'npy',
				bytes: fs.readFileSync(path.join(samplesDir, file)),
				options: {},
				external: false,
				expectError: false,
				sourceFile: file,
				npzEntry: false,
			});
		}
		const npzFiles = fs.readdirSync(samplesDir).filter(f => f.toLowerCase().endsWith('.npz'));
		for (const file of npzFiles) {
			cases.push({
				id: `npy-fixture-${slugify(file)}`,
				format: 'npy',
				bytes: fs.readFileSync(path.join(samplesDir, file)),
				options: {},
				external: false,
				expectError: false,
				sourceFile: file,
				npzEntry: true,
			});
		}
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
		// values on both sides identically. That is exactly what this case
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
		cases.push({
			id: `npy-dtype-${dtypeSlug(dtype)}`,
			format: 'npy',
			bytes: buildNpy(dtype, [1, values.length], dataBytes),
			options: {},
			external: false,
			expectError: false,
			npzEntry: false,
			label: `dtype ${dtype}`,
		});
	}

	// --- v2 header (u32 header length) -----------------------------------------
	{
		const values = [0, -1, 42.5, NaN];
		const dataBytes = encodeSamples('<f4', values);
		cases.push({
			id: 'npy-v2-header',
			format: 'npy',
			bytes: buildNpy('<f4', [1, values.length], dataBytes, 2),
			options: {},
			external: false,
			expectError: false,
			npzEntry: false,
			label: 'v2 header',
		});
	}

	// --- 2D shape (already exercised above, explicit case for clarity) --------
	{
		const values = [1, 2, 3, 4, 5, 6];
		cases.push({
			id: 'npy-2d-shape',
			format: 'npy',
			bytes: buildNpy('<u2', [2, 3], encodeSamples('<u2', values)),
			options: {},
			external: false,
			expectError: false,
			npzEntry: false,
			label: '2D shape',
		});
	}

	// --- 3D shape, channels=3 --------------------------------------------------
	{
		const height = 2, width = 3, channels = 3;
		const values = Array.from({ length: height * width * channels }, (_, i) => i);
		cases.push({
			id: 'npy-3d-channels-3',
			format: 'npy',
			bytes: buildNpy('<f4', [height, width, channels], encodeSamples('<f4', values)),
			options: {},
			external: false,
			expectError: false,
			npzEntry: false,
			label: '3D shape channels=3',
			expectedMeta: { channels: 3 },
		});
	}

	// --- 3D shape, channels=4 --------------------------------------------------
	{
		const height = 2, width = 2, channels = 4;
		const values = Array.from({ length: height * width * channels }, (_, i) => i * 1.5);
		cases.push({
			id: 'npy-3d-channels-4',
			format: 'npy',
			bytes: buildNpy('<f4', [height, width, channels], encodeSamples('<f4', values)),
			options: {},
			external: false,
			expectError: false,
			npzEntry: false,
			label: '3D shape channels=4',
			expectedMeta: { channels: 4 },
		});
	}

	// --- 3D shape, channels=2 (the "take first channel only, but still report
	//     channels=2" quirk) ------------------------------------------------
	{
		const height = 2, width = 3, channels = 2;
		const values = Array.from({ length: height * width * channels }, (_, i) => i + 0.25);
		cases.push({
			id: 'npy-3d-channels-2-quirk',
			format: 'npy',
			bytes: buildNpy('<f4', [height, width, channels], encodeSamples('<f4', values)),
			options: {},
			external: false,
			expectError: false,
			npzEntry: false,
			label: '3D shape channels=2 (first-channel-only quirk)',
			expectedMeta: { channels: 2, dataLength: height * width },
		});
	}

	// --- Negative cases: TS and Rust must reject with the SAME error text ------
	cases.push({
		id: 'npy-bad-magic',
		format: 'npy',
		bytes: Buffer.from('NOTNPYFILEDATA0123456789', 'latin1'),
		options: {},
		external: false,
		expectError: true,
		npzEntry: false,
		label: 'bad magic',
	});

	cases.push({
		id: 'npy-unsupported-version-major-3',
		format: 'npy',
		bytes: (() => {
			const magic = Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]);
			const versionBuf = Buffer.from([3, 0]);
			const lenBuf = Buffer.alloc(2);
			lenBuf.writeUInt16LE(0, 0);
			return Buffer.concat([magic, versionBuf, lenBuf]);
		})(),
		options: {},
		external: false,
		expectError: true,
		npzEntry: false,
		label: 'unsupported version (major=3)',
	});

	cases.push({
		id: 'npy-missing-shape',
		format: 'npy',
		bytes: buildNpyRaw(`{'descr': '<f4', 'fortran_order': False, }`, 1, Buffer.alloc(0)),
		options: {},
		external: false,
		expectError: true,
		npzEntry: false,
		label: 'missing shape',
	});

	cases.push({
		id: 'npy-missing-dtype',
		format: 'npy',
		bytes: buildNpyRaw(`{'fortran_order': False, 'shape': (1, 1), }`, 1, Buffer.alloc(0)),
		options: {},
		external: false,
		expectError: true,
		npzEntry: false,
		label: 'missing dtype',
	});

	cases.push({
		id: 'npy-4d-shape',
		format: 'npy',
		bytes: buildNpy('<f4', [2, 2, 2, 1], encodeSamples('<f4', [1, 2, 3, 4, 5, 6, 7, 8])),
		options: {},
		external: false,
		expectError: true,
		npzEntry: false,
		label: '4D shape',
	});

	// --- NPZ: multi-entry selection (case-insensitive depth|dispar|inv|z|range) -
	{
		const other = buildNpy('<f4', [1, 4], encodeSamples('<f4', [1, 2, 3, 4]));
		const depth = buildNpy('<f4', [1, 4], encodeSamples('<f4', [10, 20, 30, 40]));
		cases.push({
			id: 'npy-npz-multientry-selection',
			format: 'npy',
			bytes: buildNpz([['other.npy', other], ['DEPTH_map.npy', depth]]),
			options: {},
			external: false,
			expectError: false,
			npzEntry: true,
			label: 'NPZ multi-entry selection (case-insensitive "depth")',
			expectedData: [10, 20, 30, 40],
		});
	}

	// --- NPZ: no entry qualifies (all compressed) -> same error -----------------
	{
		const entryNpy = buildNpy('<f4', [1, 2], encodeSamples('<f4', [1, 2]));
		cases.push({
			id: 'npy-npz-no-entry-qualifies',
			format: 'npy',
			bytes: buildNpzEntry('compressed.npy', entryNpy, { compression: 8 }),
			options: {},
			external: false,
			expectError: true,
			npzEntry: true,
			label: 'NPZ with only compressed entries',
		});
	}

	// --- Absolute correctness ------------------------------------------------
	//
	// Everything above asserts only that TS and Rust AGREE. That is exactly the
	// blind spot that let a real bug survive: '>f8' was decoded little-endian
	// by both, so they agreed on the wrong answer. These cases assert against
	// known-correct values instead (independently hand-computed), and would
	// fail if both sides regressed together — something a golden capture of
	// "whatever Rust currently outputs" can NEVER catch, since a golden only
	// proves output is unchanged since capture, not that it was correct then.
	{
		const values = [1.5, -2.25, 0, 1e300, -0, NaN, Infinity, -Infinity];
		// 1e300 overflows float32 -> +Inf; -0 must stay -0; NaN must stay NaN.
		const expected = values.map(v => Math.fround(v));
		for (const dtype of ['<f8', '>f8']) {
			cases.push({
				id: `npy-absolute-${dtypeSlug(dtype)}`,
				format: 'npy',
				bytes: buildNpy(dtype, [1, values.length], encodeSamples(dtype, values)),
				options: {},
				external: false,
				expectError: false,
				npzEntry: false,
				label: `${dtype} absolute values`,
				expectedData: expected,
			});
		}
	}

	// A numpy-style archive whose local header carries the data-descriptor flag
	// and a placeholder compressed size. The entry extent is unknown, so a
	// decoder must resume scanning rather than assume the placeholder is a real
	// length — otherwise only the FIRST array is ever found.
	for (const placeholder of [0xffffffff, 0]) {
		// First entry has a non-matching name; the "depth" key we want to
		// select is in the SECOND entry, so it is only reachable if the
		// scan survives the first entry's unknown extent.
		const first = buildNpy('<f4', [1, 2], encodeSamples('<f4', [1, 2]));
		const second = buildNpy('<f4', [1, 3], encodeSamples('<f4', [7, 8, 9]));
		const buf = Buffer.concat([
			buildNpzEntry('other.npy', first, { flags: 0x08, sizeOverride: placeholder }),
			buildNpzEntry('depth.npy', second, { flags: 0x08, sizeOverride: placeholder }),
		]);
		cases.push({
			id: `npy-npz-data-descriptor-placeholder-0x${placeholder.toString(16)}`,
			format: 'npy',
			bytes: buf,
			options: {},
			external: false,
			expectError: false,
			npzEntry: true,
			label: `NPZ data-descriptor placeholder 0x${placeholder.toString(16)}`,
			expectedData: [7, 8, 9],
			expectedMeta: { width: 3 },
		});
	}

	return cases;
}

// =============================================================================
// FITS / NetCDF / DICOM (scientific formats)
// =============================================================================

// --- FITS synthesis helpers -------------------------------------------------

function fitsCard(text) {
	const buf = Buffer.alloc(80, 0x20);
	Buffer.from(text, 'latin1').copy(buf, 0, 0, Math.min(text.length, 80));
	return buf;
}

function fitsKV(key, value, comment) {
	let valStr;
	if (typeof value === 'boolean') { valStr = value ? 'T' : 'F'; }
	else if (typeof value === 'number') { valStr = String(value); }
	else { valStr = `'${String(value).replace(/'/g, "''")}'`; }
	let line = `${key.padEnd(8)}= ${valStr}`;
	if (comment !== undefined) { line += ` / ${comment}`; }
	return fitsCard(line);
}

function fitsEnd() {
	return fitsCard('END');
}

function buildFitsHeader(cards) {
	const all = Buffer.concat([...cards, fitsEnd()]);
	const pad = (2880 - (all.length % 2880)) % 2880;
	return Buffer.concat([all, Buffer.alloc(pad, 0x20)]);
}

function fitsSamples(bitpix, values) {
	const sizeMap = { 8: 1, 16: 2, 32: 4, 64: 8, '-32': 4, '-64': 8 };
	const size = sizeMap[bitpix];
	const buf = Buffer.alloc(values.length * size);
	values.forEach((v, i) => {
		const off = i * size;
		switch (bitpix) {
			case 8: buf.writeUInt8(v & 0xff, off); break;
			case 16: buf.writeInt16BE(v, off); break;
			case 32: buf.writeInt32BE(v, off); break;
			case 64: buf.writeBigInt64BE(BigInt(v), off); break;
			case -32: buf.writeFloatBE(v, off); break;
			case -64: buf.writeDoubleBE(v, off); break;
			default: throw new Error(`test helper: unsupported bitpix ${bitpix}`);
		}
	});
	return buf;
}

/** Builds a minimal single-HDU FITS file. `values` are RAW stored samples
 * (before BSCALE/BZERO), in file order (row-major, first stored row = FITS
 * "bottom" row per the axis-2-increases-upward convention). */
function buildFits({ bitpix, axes, bscale, bzero, blank, object, unit, extraCards = [], includeData = true }, values) {
	const cards = [];
	cards.push(fitsKV('SIMPLE', true));
	cards.push(fitsKV('BITPIX', bitpix));
	cards.push(fitsKV('NAXIS', axes.length));
	axes.forEach((size, i) => cards.push(fitsKV(`NAXIS${i + 1}`, size)));
	if (bscale !== undefined) { cards.push(fitsKV('BSCALE', bscale)); }
	if (bzero !== undefined) { cards.push(fitsKV('BZERO', bzero)); }
	if (blank !== undefined) { cards.push(fitsKV('BLANK', blank)); }
	if (object !== undefined) { cards.push(fitsKV('OBJECT', object)); }
	if (unit !== undefined) { cards.push(fitsKV('BUNIT', unit)); }
	cards.push(...extraCards);
	const header = buildFitsHeader(cards);
	if (!includeData) { return header; }
	const data = fitsSamples(bitpix, values);
	return Buffer.concat([header, data]);
}

// --- NetCDF synthesis helpers (classic CDF-1/CDF-2) -------------------------

function u32be(n) {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(n >>> 0, 0);
	return b;
}
function u64be(n) {
	const b = Buffer.alloc(8);
	b.writeBigUInt64BE(BigInt(n), 0);
	return b;
}
function ncName(name) {
	const nameBuf = Buffer.from(name, 'latin1');
	const pad = (4 - (nameBuf.length % 4)) % 4;
	return Buffer.concat([u32be(nameBuf.length), nameBuf, Buffer.alloc(pad)]);
}
const NC_TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8 };
function ncNumValues(type, values) {
	const size = NC_TYPE_SIZE[type];
	const buf = Buffer.alloc(values.length * size);
	values.forEach((v, i) => {
		const off = i * size;
		switch (type) {
			case 1: buf.writeInt8(v, off); break;
			case 3: buf.writeInt16BE(v, off); break;
			case 4: buf.writeInt32BE(v, off); break;
			case 5: buf.writeFloatBE(v, off); break;
			case 6: buf.writeDoubleBE(v, off); break;
			default: throw new Error(`test helper: unsupported NetCDF type ${type}`);
		}
	});
	const total = values.length * size;
	const pad = (4 - (total % 4)) % 4;
	return Buffer.concat([buf, Buffer.alloc(pad)]);
}
function ncCharValues(str) {
	const buf = Buffer.from(str, 'latin1');
	const pad = (4 - (buf.length % 4)) % 4;
	return Buffer.concat([buf, Buffer.alloc(pad)]);
}
/** attrs: [{ name, type, value (string, type 2) | values (number[], else) }] */
function ncAttrList(attrs) {
	if (!attrs || attrs.length === 0) { return Buffer.concat([u32be(0), u32be(0)]); }
	const parts = [u32be(12), u32be(attrs.length)];
	for (const a of attrs) {
		parts.push(ncName(a.name));
		parts.push(u32be(a.type));
		if (a.type === 2) {
			parts.push(u32be(a.value.length));
			parts.push(ncCharValues(a.value));
		} else {
			parts.push(u32be(a.values.length));
			parts.push(ncNumValues(a.type, a.values));
		}
	}
	return Buffer.concat(parts);
}

/**
 * Builds a classic NetCDF file. `dimensions`: [{ name, size, unlimited }]
 * (at most one unlimited/record dimension, matching the format). `variables`:
 * [{ name, dimIds, attrs, type, data: number[][] }] where `data` has one
 * entry per record for a record variable, or exactly one entry (the whole
 * variable's flat row-major values) for a non-record variable.
 */
function buildNetCdf({ version = 1, numRecords = 0, dimensions = [], variables = [], globalAttrs = [] }) {
	const dimPart = dimensions.length === 0
		? Buffer.concat([u32be(0), u32be(0)])
		: Buffer.concat([
			u32be(10), u32be(dimensions.length),
			...dimensions.flatMap(d => [ncName(d.name), u32be(d.unlimited ? 0 : d.size)]),
		]);
	const globalAttrPart = ncAttrList(globalAttrs);

	const varDefs = variables.map(v => {
		const dimObjs = v.dimIds.map(id => dimensions[id]);
		const isRecord = dimObjs.length > 0 && dimObjs[0].unlimited;
		const nonRecordDims = isRecord ? dimObjs.slice(1) : dimObjs;
		const countPerSlice = nonRecordDims.reduce((p, d) => p * d.size, 1);
		const vsize = Math.ceil((countPerSlice * NC_TYPE_SIZE[v.type]) / 4) * 4;
		return { ...v, isRecord, countPerSlice, vsize };
	});

	function serializeVarList(begins) {
		if (varDefs.length === 0) { return Buffer.concat([u32be(0), u32be(0)]); }
		const parts = [u32be(11), u32be(varDefs.length)];
		varDefs.forEach((v, i) => {
			parts.push(ncName(v.name));
			parts.push(u32be(v.dimIds.length));
			v.dimIds.forEach(id => parts.push(u32be(id)));
			parts.push(ncAttrList(v.attrs || []));
			parts.push(u32be(v.type));
			parts.push(u32be(v.vsize));
			parts.push(version === 1 ? u32be(begins[i]) : u64be(begins[i]));
		});
		return Buffer.concat(parts);
	}

	const preVarBuf = Buffer.concat([dimPart, globalAttrPart]);
	const headerPrefixLen = 4 + 4; // magic+version, numRecords
	const varListZero = serializeVarList(varDefs.map(() => 0));
	const headerLen = headerPrefixLen + preVarBuf.length + varListZero.length;

	let nonRecordCursor = headerLen;
	const begins = new Array(varDefs.length).fill(0);
	varDefs.forEach((v, i) => {
		if (!v.isRecord) {
			begins[i] = nonRecordCursor;
			nonRecordCursor += v.vsize;
		}
	});
	const recordDataStart = nonRecordCursor;
	let recordCursor = recordDataStart;
	const recordVarIndices = [];
	varDefs.forEach((v, i) => {
		if (v.isRecord) {
			begins[i] = recordCursor;
			recordCursor += v.vsize;
			recordVarIndices.push(i);
		}
	});
	const recordSize = recordVarIndices.reduce((s, i) => s + varDefs[i].vsize, 0);
	const totalRecords = Math.max(numRecords, recordVarIndices.length > 0 ? numRecords : 0);
	const dataEnd = recordDataStart + recordSize * totalRecords;

	const varListReal = serializeVarList(begins);
	const header = Buffer.concat([
		Buffer.from([0x43, 0x44, 0x46, version]),
		u32be(numRecords),
		preVarBuf,
		varListReal,
	]);
	if (header.length !== headerLen) { throw new Error('test helper: header length mismatch'); }

	const out = Buffer.alloc(Math.max(dataEnd, headerLen));
	header.copy(out, 0);
	varDefs.forEach((v, i) => {
		if (!v.isRecord) {
			const encoded = ncNumValues(v.type, v.data[0]).subarray(0, v.countPerSlice * NC_TYPE_SIZE[v.type]);
			encoded.copy(out, begins[i]);
		} else {
			v.data.forEach((recordValues, r) => {
				const encoded = ncNumValues(v.type, recordValues).subarray(0, v.countPerSlice * NC_TYPE_SIZE[v.type]);
				encoded.copy(out, begins[i] + r * recordSize);
			});
		}
	});
	return out;
}

// --- DICOM synthesis helpers -------------------------------------------------

const DICOM_LONG_VR = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'UC', 'UR', 'UT', 'UN']);

function dcmU16(value, little) {
	const b = Buffer.alloc(2);
	if (little) { b.writeUInt16LE(value & 0xffff, 0); } else { b.writeUInt16BE(value & 0xffff, 0); }
	return b;
}
function dcmU32(value, little) {
	const b = Buffer.alloc(4);
	if (little) { b.writeUInt32LE(value >>> 0, 0); } else { b.writeUInt32BE(value >>> 0, 0); }
	return b;
}
/** Encodes one data element (tag + VR/length header + value), matching
 * `dicomElement()` in both scientific-format-parsers.ts and dicom.rs. */
function dcmEl(group, element, vr, value, { explicit, little }) {
	const parts = [dcmU16(group, little), dcmU16(element, little)];
	if (explicit) {
		parts.push(Buffer.from(vr, 'latin1'));
		if (DICOM_LONG_VR.has(vr)) {
			parts.push(Buffer.alloc(2)); // reserved
			parts.push(dcmU32(value.length, little));
		} else {
			parts.push(dcmU16(value.length, little));
		}
	} else {
		parts.push(dcmU32(value.length, little));
	}
	parts.push(value);
	return Buffer.concat(parts);
}
/** Pads an ASCII/text VR value to an even length with a trailing space, as
 * DICOM requires (our decoder tolerates unpadded values too, since
 * `text()`/`ascii()` trim trailing NUL/space either way, but real files are
 * padded and the padding-stripping behavior is itself part of what's under
 * test). */
function dcmText(s) {
	let b = Buffer.from(s, 'latin1');
	if (b.length % 2 !== 0) { b = Buffer.concat([b, Buffer.from(' ', 'latin1')]); }
	return b;
}
/** Pads a UI (UID) VR value to an even length with a trailing NUL, per spec. */
function dcmUid(s) {
	let b = Buffer.from(s, 'latin1');
	if (b.length % 2 !== 0) { b = Buffer.concat([b, Buffer.from([0])]); }
	return b;
}
function dcmPreamble(transferSyntaxUID) {
	const meta = dcmEl(0x0002, 0x0010, 'UI', dcmUid(transferSyntaxUID), { explicit: true, little: true });
	return Buffer.concat([Buffer.alloc(128, 0), Buffer.from('DICM', 'latin1'), meta]);
}
/** Encodes `count` fixed-width pixel samples. `values` are the RAW stored
 * (pre Rescale Slope/Intercept) bit patterns — for signed samples, pass the
 * already-two's-complement value (e.g. -100 for a 16-bit signed sample); the
 * `& mask` write ops below reproduce the correct bit pattern the same way
 * `DataView`/`Buffer` truncation does. */
function dcmPixelSamples(values, bitsAllocated, little) {
	const bytesPer = bitsAllocated / 8;
	const buf = Buffer.alloc(values.length * bytesPer);
	values.forEach((v, i) => {
		const off = i * bytesPer;
		if (bitsAllocated === 8) { buf.writeUInt8(v & 0xff, off); }
		else if (bitsAllocated === 16) { little ? buf.writeUInt16LE(v & 0xffff, off) : buf.writeUInt16BE(v & 0xffff, off); }
		else if (bitsAllocated === 32) { little ? buf.writeInt32LE(v, off) : buf.writeInt32BE(v, off); }
		else { throw new Error(`test helper: unsupported bitsAllocated ${bitsAllocated}`); }
	});
	return buf;
}

/**
 * Builds a DICOM object: an optional 128-byte preamble + `DICM` + File Meta
 * group (always explicit VR little endian, per spec, regardless of the
 * dataset's own encoding) declaring `transferSyntaxUID`, followed by the main
 * dataset encoded per `explicit`/`little`.
 */
function buildDicom({
	preamble = true, transferSyntaxUID = '1.2.840.10008.1.2.1', explicit, little,
	rows, columns, samples = 1, planar, bitsAllocated, bitsStored, signed = 0,
	frames, rescaleSlope, rescaleIntercept, windowCenter, windowWidth, photometric,
	pixelDataVR, pixelBytes, extraElements = [],
}) {
	const enc = { explicit, little };
	const parts = [];
	if (preamble) { parts.push(dcmPreamble(transferSyntaxUID)); }
	const push = (group, element, vr, value) => parts.push(dcmEl(group, element, vr, value, enc));
	push(0x0028, 0x0010, 'US', dcmU16(rows, little));
	push(0x0028, 0x0011, 'US', dcmU16(columns, little));
	push(0x0028, 0x0002, 'US', dcmU16(samples, little));
	if (planar !== undefined) { push(0x0028, 0x0006, 'US', dcmU16(planar, little)); }
	push(0x0028, 0x0100, 'US', dcmU16(bitsAllocated, little));
	push(0x0028, 0x0101, 'US', dcmU16(bitsStored, little));
	push(0x0028, 0x0103, 'US', dcmU16(signed, little));
	if (frames !== undefined) { push(0x0028, 0x0008, 'IS', dcmText(String(frames))); }
	if (rescaleSlope !== undefined) { push(0x0028, 0x1053, 'DS', dcmText(String(rescaleSlope))); }
	if (rescaleIntercept !== undefined) { push(0x0028, 0x1052, 'DS', dcmText(String(rescaleIntercept))); }
	if (windowCenter !== undefined) { push(0x0028, 0x1050, 'DS', dcmText(String(windowCenter))); }
	if (windowWidth !== undefined) { push(0x0028, 0x1051, 'DS', dcmText(String(windowWidth))); }
	if (photometric !== undefined) { push(0x0028, 0x0004, 'CS', dcmText(photometric)); }
	for (const [group, element, vr, value] of extraElements) { push(group, element, vr, value); }
	push(0x7fe0, 0x0010, pixelDataVR, pixelBytes);
	return Buffer.concat(parts);
}

/** A real, valid 4x4 RGB baseline-JPEG codestream (quality 90, generated with
 * Pillow), used to prove `decode_dicom_fast` now decodes JPEG Baseline
 * Pixel Data natively instead of rejecting it — see the
 * `dicom-jpeg-baseline-codec-fallback-error` case below. */
const TINY_JPEG_BASELINE_4X4_RGB_HEX = 'ffd8ffe000104a46494600010100000100010000ffdb0043000302020302020303030304030304050805050404050a070706080c0a0c0c0b0a0b0b0d0e12100d0e110e0b0b1016101113141515150c0f171816141812141514ffdb00430103040405040509050509140d0b0d1414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414ffc00011080004000403012200021101031101ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffc4001f0100030101010101010101010000000000000102030405060708090a0bffc400b51100020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9faffda000c03010002110311003f00f2df8d5f1abc49f017c6d71e16f0b5c496fa742f701996f2ead9e678aea7b6f324fb3cd12b3b2dba124afcbc220489228e328a2b2c9723cab1997d2af89c2d39ce4b594a116debd5b5767e4bc45c499de5f9be270983c755a74a126a318d49c6315d924d24bc923fffd9';

/**
 * Builds the DICOM File Meta group WITH the (0002,0000) group-length element
 * dicom-object's `FileMetaTable::read_from` requires as the very first
 * element (the hand-rolled Rust/native path in `dicom.rs` never reads this
 * group at all beyond a linear scan for Transfer Syntax UID, so `dcmPreamble`
 * above — used by every native-path case — deliberately omits it; this
 * stricter variant is only needed for the compressed cases below, which are
 * parsed by `dicom-object` end-to-end). */
function dcmPreambleWithGroupLength(transferSyntaxUID) {
	const ts = dcmEl(0x0002, 0x0010, 'UI', dcmUid(transferSyntaxUID), { explicit: true, little: true });
	const groupLength = dcmEl(0x0002, 0x0000, 'UL', dcmU32(ts.length, true), { explicit: true, little: true });
	return Buffer.concat([Buffer.alloc(128, 0), Buffer.from('DICM', 'latin1'), groupLength, ts]);
}

/** Encodes encapsulated (compressed) DICOM Pixel Data: tag + VR OB +
 * undefined length (0xFFFFFFFF), an empty Basic Offset Table item, one Item
 * per fragment, and a Sequence Delimitation Item — the standard structure
 * `dicom-pixeldata`'s codec adapters (and any conformant DICOM reader)
 * expect, as opposed to the fixed-length non-encapsulated encoding `dcmEl`
 * produces for native Pixel Data. */
function dcmEncapsulatedPixelData(fragments, { little }) {
	const parts = [dcmU16(0x7fe0, little), dcmU16(0x0010, little), Buffer.from('OB', 'latin1'), Buffer.alloc(2), dcmU32(0xffffffff, little)];
	parts.push(dcmU16(0xfffe, little), dcmU16(0xe000, little), dcmU32(0, little)); // empty Basic Offset Table
	for (const frag of fragments) {
		parts.push(dcmU16(0xfffe, little), dcmU16(0xe000, little), dcmU32(frag.length, little));
		parts.push(frag);
	}
	parts.push(dcmU16(0xfffe, little), dcmU16(0xe0dd, little), dcmU32(0, little)); // Sequence Delimitation Item
	return Buffer.concat(parts);
}

/**
 * Builds a compressed (encapsulated Pixel Data) DICOM object: preamble +
 * `DICM` + a spec-complete File Meta group (with group length, since
 * `dicom-object` parses this end-to-end for the compressed decode path,
 * unlike the hand-rolled native-path element walk) + the tags
 * `dicom-pixeldata`'s `ImagingProperties::from_obj` requires (Rows, Columns,
 * Samples Per Pixel, Bits Allocated/Stored, High Bit, Pixel Representation,
 * Photometric Interpretation) + the encapsulated Pixel Data fragments.
 */
function buildEncapsulatedDicom({
	transferSyntaxUID, rows, columns, samples = 1, bitsAllocated, bitsStored, signed = 0,
	photometric, fragments, extraElements = [],
}) {
	const little = true;
	const enc = { explicit: true, little };
	const parts = [dcmPreambleWithGroupLength(transferSyntaxUID)];
	const push = (group, element, vr, value) => parts.push(dcmEl(group, element, vr, value, enc));
	push(0x0028, 0x0010, 'US', dcmU16(rows, little));
	push(0x0028, 0x0011, 'US', dcmU16(columns, little));
	push(0x0028, 0x0002, 'US', dcmU16(samples, little));
	push(0x0028, 0x0100, 'US', dcmU16(bitsAllocated, little));
	push(0x0028, 0x0101, 'US', dcmU16(bitsStored, little));
	push(0x0028, 0x0102, 'US', dcmU16(bitsStored - 1, little));
	push(0x0028, 0x0103, 'US', dcmU16(signed, little));
	push(0x0028, 0x0004, 'CS', dcmText(photometric));
	for (const [group, element, vr, value] of extraElements) { push(group, element, vr, value); }
	parts.push(dcmEncapsulatedPixelData(fragments, { little }));
	return Buffer.concat(parts);
}

/** DICOM files may legitimately have no extension at all (the extension
 * viewer detects them by sniffing), so a fixture with no '.' in its name is
 * sniffed for the 'DICM' magic at byte 128 rather than skipped. */
function looksLikeDicom(fullPath) {
	try {
		const fd = fs.openSync(fullPath, 'r');
		const buf = Buffer.alloc(132);
		const bytesRead = fs.readSync(fd, buf, 0, 132, 0);
		fs.closeSync(fd);
		return bytesRead >= 132 && buf.toString('latin1', 128, 132) === 'DICM';
	} catch {
		return false;
	}
}

function listScientificFixtureCases(dir, external) {
	const cases = [];
	if (!fs.existsSync(dir)) { return cases; }
	const files = fs.readdirSync(dir);
	for (const file of files) {
		const lower = file.toLowerCase();
		const full = path.join(dir, file);
		const isFits = lower.endsWith('.fits');
		const isNetCdf = lower.endsWith('.nc');
		const isDicom = lower.endsWith('.dcm') || lower.endsWith('.dicom')
			|| (!file.includes('.') && looksLikeDicom(full));
		if (!isFits && !isNetCdf && !isDicom) { continue; }
		const format = isFits ? 'fits' : isNetCdf ? 'netcdf' : 'dicom';
		const idPrefix = external ? `${format}-fixture-external` : `${format}-fixture`;
		cases.push({
			id: `${idPrefix}-${slugify(file)}`,
			format,
			bytes: fs.readFileSync(full),
			options: format === 'dicom' ? { frameIndex: 0 } : {},
			external,
			expectError: false, // best-effort default; see file-header comment —
			// real corpus files that are legitimately refused are still
			// handled correctly because outcomes are always determined
			// empirically (try/catch), never by trusting this flag.
			sourceFile: file,
		});
	}
	return cases;
}

function listScientificCases() {
	const cases = [];

	// --- Real/checked-in + external fixtures -----------------------------------
	cases.push(...listScientificFixtureCases(scientificSamplesDir, false));
	cases.push(...listScientificFixtureCases(externalScientificDir, true));

	// --- FITS: BITPIX matrix -----------------------------------------------------
	{
		const bitpixCases = [
			['BITPIX 8 (uint8)', { bitpix: 8, axes: [3, 2] }, [10, 20, 30, 200, 250, 5]],
			['BITPIX 16 (int16)', { bitpix: 16, axes: [3, 2] }, [-100, 200, 300, -400, 32000, -32000]],
			['BITPIX 32 (int32)', { bitpix: 32, axes: [3, 2] }, [-100000, 200000, 2147483647, -2147483648, 0, 12345]],
			['BITPIX 64 (int64)', { bitpix: 64, axes: [3, 2] }, [-1, 1, 9007199254740991, -9007199254740991, 0, 42]],
			['BITPIX -32 (float32)', { bitpix: -32, axes: [3, 2] }, [1.5, -2.25, 0, 3.4028235e38, -3.4028235e38, 0.1]],
			['BITPIX -64 (float64)', { bitpix: -64, axes: [3, 2] }, [1.5, -2.25, 0, 1.7976931348623157e308, -1e300, 0.1]],
		];
		for (const [label, opts, values] of bitpixCases) {
			cases.push({
				id: `fits-${slugify(label)}`,
				format: 'fits',
				bytes: buildFits(opts, values),
				options: {},
				external: false,
				expectError: false,
				label: `FITS ${label}`,
			});
		}
	}

	// --- FITS: BSCALE/BZERO + absolute correctness + big-endian int16 ----------
	{
		const values = [-100, 200, 300, -400]; // stored row-major, file order
		// Hand-computed: FITS axis-2 increases bottom-to-top, so the decoder
		// flips rows; stored row 0 = [-100,200] ends up as the BOTTOM output
		// row, stored row 1 = [300,-400] ends up as the TOP output row.
		const expected = [100 + 2.5 * 300, 100 + 2.5 * -400, 100 + 2.5 * -100, 100 + 2.5 * 200];
		cases.push({
			id: 'fits-bscale-bzero-int16',
			format: 'fits',
			bytes: buildFits({ bitpix: 16, axes: [2, 2], bscale: 2.5, bzero: 100 }, values),
			options: {},
			external: false,
			expectError: false,
			label: 'FITS BSCALE/BZERO int16',
			expectedData: expected,
		});
	}

	// --- FITS: NaN / +-Inf in a float image -------------------------------------
	{
		const values = [NaN, Infinity, -Infinity];
		cases.push({
			id: 'fits-float32-nan-inf',
			format: 'fits',
			bytes: buildFits({ bitpix: -32, axes: [3, 1] }, values),
			options: {},
			external: false,
			expectError: false,
			label: 'FITS float32 NaN/+-Inf',
		});
	}

	// --- FITS: BLANK sentinel -> NaN --------------------------------------------
	{
		const values = [-999, 5, -999, 10];
		cases.push({
			id: 'fits-blank-sentinel',
			format: 'fits',
			bytes: buildFits({ bitpix: 16, axes: [2, 2], blank: -999 }, values),
			options: {},
			external: false,
			expectError: false,
			label: 'FITS BLANK sentinel',
		});
	}

	// --- FITS: multi-2880-byte-block header --------------------------------------
	{
		const extraCards = [];
		for (let i = 0; i < 60; i++) {
			extraCards.push(fitsKV(`FILLER${i}`, i));
		}
		const buf = buildFits({ bitpix: 8, axes: [2, 2], extraCards }, [1, 2, 3, 4]);
		if (buf.length <= 2880 * 2) { throw new Error('test helper: header should span multiple 2880-byte blocks'); }
		cases.push({
			id: 'fits-multi-block-header',
			format: 'fits',
			bytes: buf,
			options: {},
			external: false,
			expectError: false,
			label: 'FITS multi-block header',
		});
	}

	// --- FITS: 3-axis cube (first-plane-only) ------------------------------------
	{
		const width = 3, height = 2, depth = 4;
		const values = Array.from({ length: width * height * depth }, (_, i) => i);
		cases.push({
			id: 'fits-3-axis-cube',
			format: 'fits',
			bytes: buildFits({ bitpix: 16, axes: [width, height, depth] }, values),
			options: {},
			external: false,
			expectError: false,
			label: 'FITS 3-axis cube',
			expectedMeta: { firstPlaneOnly: true, dataLength: width * height },
		});
	}

	// --- FITS negative cases -----------------------------------------------------
	cases.push({
		id: 'fits-missing-end-card',
		format: 'fits',
		bytes: Buffer.concat([fitsKV('SIMPLE', true), fitsKV('BITPIX', 8)]), // no END, no padding: header read runs off the buffer
		options: {},
		external: false,
		expectError: true,
		label: 'FITS missing END card',
	});

	cases.push({
		id: 'fits-truncated-raster',
		format: 'fits',
		bytes: Buffer.concat([buildFits({ bitpix: 8, axes: [10, 10], includeData: false }, []), Buffer.from([1, 2, 3, 4, 5])]), // needs 100 bytes, has 5
		options: {},
		external: false,
		expectError: true,
		label: 'FITS truncated raster',
	});

	cases.push({
		id: 'fits-unsupported-bitpix',
		format: 'fits',
		bytes: buildFits({ bitpix: 24, axes: [2, 2], includeData: false }, []),
		options: {},
		external: false,
		expectError: true,
		label: 'FITS unsupported BITPIX',
	});

	// --- NetCDF: CDF-1 / CDF-2 basic raster --------------------------------------
	for (const version of [1, 2]) {
		const dimensions = [{ name: 'lat', size: 3, unlimited: false }, { name: 'lon', size: 4, unlimited: false }];
		const variables = [{
			name: 'temp', dimIds: [0, 1], type: 5,
			attrs: [{ name: 'units', type: 2, value: 'K' }],
			data: [Array.from({ length: 12 }, (_, i) => i * 1.5)],
		}];
		cases.push({
			id: `netcdf-cdf-${version}-basic-raster`,
			format: 'netcdf',
			bytes: buildNetCdf({ version, dimensions, variables }),
			options: {},
			external: false,
			expectError: false,
			label: `NetCDF CDF-${version} basic raster`,
		});
	}

	// --- NetCDF: scale_factor/add_offset + absolute correctness -----------------
	{
		const dimensions = [{ name: 'y', size: 2, unlimited: false }, { name: 'x', size: 2, unlimited: false }];
		const stored = [0, 100, -50, 32000];
		const variables = [{
			name: 'temp', dimIds: [0, 1], type: 3,
			attrs: [
				{ name: 'scale_factor', type: 5, values: [0.01] },
				{ name: 'add_offset', type: 5, values: [5.0] },
			],
			data: [stored],
		}];
		const expected = stored.map(v => Math.fround(v * 0.01 + 5.0));
		cases.push({
			id: 'netcdf-scale-factor-add-offset',
			format: 'netcdf',
			bytes: buildNetCdf({ version: 1, dimensions, variables }),
			options: {},
			external: false,
			expectError: false,
			label: 'NetCDF scale_factor/add_offset',
			expectedData: expected,
		});
	}

	// --- NetCDF: _FillValue -> NaN ------------------------------------------------
	{
		const dimensions = [{ name: 'y', size: 2, unlimited: false }, { name: 'x', size: 2, unlimited: false }];
		const variables = [{
			name: 'temp', dimIds: [0, 1], type: 4,
			attrs: [{ name: '_FillValue', type: 4, values: [-999] }],
			data: [[-999, 1, 2, -999]],
		}];
		cases.push({
			id: 'netcdf-fillvalue',
			format: 'netcdf',
			bytes: buildNetCdf({ version: 1, dimensions, variables }),
			options: {},
			external: false,
			expectError: false,
			label: 'NetCDF _FillValue',
		});
	}

	// --- NetCDF: every supported element type ------------------------------------
	{
		const dimensions = [{ name: 'y', size: 2, unlimited: false }, { name: 'x', size: 2, unlimited: false }];
		const typeCases = [
			['byte (int8)', 1, [-128, 0, 127, -1]],
			['short (int16)', 3, [-32768, 0, 32767, -1]],
			['int (int32)', 4, [-2147483648, 0, 2147483647, -1]],
			['float', 5, [1.5, -2.5, 0, 3.5]],
			['double', 6, [1.5, -2.5, 0, 1e200]],
		];
		for (const [label, type, values] of typeCases) {
			const variables = [{ name: 'v', dimIds: [0, 1], type, attrs: [], data: [values] }];
			cases.push({
				id: `netcdf-element-type-${slugify(label)}`,
				format: 'netcdf',
				bytes: buildNetCdf({ version: 1, dimensions, variables }),
				options: {},
				external: false,
				expectError: false,
				label: `NetCDF element type ${label}`,
			});
		}
	}

	// --- NetCDF: record dimension + indices option --------------------------------
	{
		const dimensions = [
			{ name: 'time', size: 0, unlimited: true },
			{ name: 'y', size: 2, unlimited: false },
			{ name: 'x', size: 3, unlimited: false },
		];
		const variables = [{
			name: 'temp', dimIds: [0, 1, 2], type: 5, attrs: [],
			data: [
				[0, 1, 2, 3, 4, 5],
				[10, 11, 12, 13, 14, 15],
			],
		}];
		const buf = buildNetCdf({ version: 1, numRecords: 2, dimensions, variables });
		cases.push({
			id: 'netcdf-record-dimension-record0',
			format: 'netcdf',
			bytes: buf,
			options: {},
			external: false,
			expectError: false,
			label: 'NetCDF record dimension (record 0)',
			expectedData: [0, 1, 2, 3, 4, 5],
		});
		cases.push({
			id: 'netcdf-record-dimension-record1',
			format: 'netcdf',
			bytes: buf,
			options: { indices: { time: 1 } },
			external: false,
			expectError: false,
			label: 'NetCDF record dimension (record 1 via indices option)',
			expectedData: [10, 11, 12, 13, 14, 15],
		});
	}

	// --- NetCDF: variableName selection option -------------------------------------
	{
		const dimensions = [{ name: 'y', size: 2, unlimited: false }, { name: 'x', size: 2, unlimited: false }];
		const variables = [
			{ name: 'first', dimIds: [0, 1], type: 5, attrs: [], data: [[1, 2, 3, 4]] },
			{ name: 'second', dimIds: [0, 1], type: 5, attrs: [], data: [[5, 6, 7, 8]] },
		];
		cases.push({
			id: 'netcdf-variablename-selection',
			format: 'netcdf',
			bytes: buildNetCdf({ version: 1, dimensions, variables }),
			options: { variableName: 'second' },
			external: false,
			expectError: false,
			label: 'NetCDF variableName selection',
			expectedData: [5, 6, 7, 8],
			expectedMeta: { variable: 'second' },
		});
	}

	// --- NetCDF negative cases -----------------------------------------------------
	cases.push({
		id: 'netcdf-bad-magic',
		format: 'netcdf',
		bytes: Buffer.from('NOTANETCDFFILE0123456789', 'latin1'),
		options: {},
		external: false,
		expectError: true,
		label: 'NetCDF bad magic',
	});

	cases.push({
		id: 'netcdf-hdf5-signature-unsupported',
		format: 'netcdf',
		bytes: Buffer.from([0x89, 0x48, 0x44, 0x46, 0, 0, 0, 0]),
		options: {},
		external: false,
		expectError: true,
		label: 'NetCDF HDF5 signature reported as unsupported',
	});

	cases.push({
		id: 'netcdf-unsupported-version',
		format: 'netcdf',
		bytes: Buffer.from([0x43, 0x44, 0x46, 9, 0, 0, 0, 0]),
		options: {},
		external: false,
		expectError: true,
		label: 'NetCDF unsupported version',
	});

	cases.push({
		id: 'netcdf-truncated-raster',
		format: 'netcdf',
		bytes: (() => {
			const dimensions = [{ name: 'y', size: 4, unlimited: false }, { name: 'x', size: 4, unlimited: false }];
			const variables = [{ name: 'v', dimIds: [0, 1], type: 5, attrs: [], data: [Array.from({ length: 16 }, (_, i) => i)] }];
			const full = buildNetCdf({ version: 1, dimensions, variables });
			return full.subarray(0, full.length - 20); // chop off the tail of the raster data
		})(),
		options: {},
		external: false,
		expectError: true,
		label: 'NetCDF truncated raster',
	});

	// --- DICOM: VR/endianness encoding matrix ------------------------------------
	{
		// 3x2 MONOCHROME2, 16-bit unsigned, row-major stored values 0..5.
		const values = [0, 1, 2, 3, 4, 5];
		const encMatrix = [
			['implicit VR little endian', { transferSyntaxUID: '1.2.840.10008.1.2', explicit: false, little: true }],
			['explicit VR little endian', { transferSyntaxUID: '1.2.840.10008.1.2.1', explicit: true, little: true }],
			['explicit VR big endian', { transferSyntaxUID: '1.2.840.10008.1.2.2', explicit: true, little: false }],
		];
		for (const [label, enc] of encMatrix) {
			const buf = buildDicom({
				...enc, rows: 2, columns: 3, bitsAllocated: 16, bitsStored: 16, signed: 0,
				photometric: 'MONOCHROME2', pixelDataVR: 'OW',
				pixelBytes: dcmPixelSamples(values, 16, enc.little),
			});
			cases.push({
				id: `dicom-${slugify(label)}`,
				format: 'dicom',
				bytes: buf,
				options: { frameIndex: 0 },
				external: false,
				expectError: false,
				label: `DICOM ${label}`,
			});
		}
	}

	// --- DICOM: no preamble (VR heuristic detection) -----------------------------
	{
		const values = [10, 20, 30, 40];
		for (const [label, explicit] of [['no-preamble explicit VR', true], ['no-preamble implicit VR', false]]) {
			const buf = buildDicom({
				preamble: false, explicit, little: true,
				rows: 2, columns: 2, bitsAllocated: 8, bitsStored: 8, signed: 0,
				photometric: 'MONOCHROME2', pixelDataVR: 'OB',
				pixelBytes: dcmPixelSamples(values, 8, true),
			});
			cases.push({
				id: `dicom-${slugify(label)}`,
				format: 'dicom',
				bytes: buf,
				options: { frameIndex: 0 },
				external: false,
				expectError: false,
				label: `DICOM ${label}`,
			});
		}
	}

	// --- DICOM: signed vs unsigned Pixel Representation, Bits Allocated 8/16 ----
	{
		const matrix = [
			['unsigned 8-bit', { bitsAllocated: 8, bitsStored: 8, signed: 0 }, [0, 127, 255, 1]],
			['signed 8-bit', { bitsAllocated: 8, bitsStored: 8, signed: 1 }, [-128, -1, 0, 127]],
			['unsigned 16-bit', { bitsAllocated: 16, bitsStored: 16, signed: 0 }, [0, 32768, 65535, 100]],
			['signed 16-bit', { bitsAllocated: 16, bitsStored: 16, signed: 1 }, [-32768, -1, 0, 32767]],
		];
		for (const [label, opts, values] of matrix) {
			const buf = buildDicom({
				explicit: true, little: true, rows: 2, columns: 2, ...opts,
				photometric: 'MONOCHROME2', pixelDataVR: opts.bitsAllocated === 8 ? 'OB' : 'OW',
				pixelBytes: dcmPixelSamples(values, opts.bitsAllocated, true),
			});
			cases.push({
				id: `dicom-${slugify(label)}`,
				format: 'dicom',
				bytes: buf,
				options: { frameIndex: 0 },
				external: false,
				expectError: false,
				label: `DICOM ${label}`,
			});
		}
	}

	// --- DICOM: Rescale Slope/Intercept + ABSOLUTE hand-computed values ---------
	{
		const stored = [0, 100, 2048, 4095]; // 12-bit-range values in a 16-bit allocation
		const slope = 2.5, intercept = -1024;
		const buf = buildDicom({
			explicit: true, little: true, rows: 2, columns: 2,
			bitsAllocated: 16, bitsStored: 12, signed: 0,
			rescaleSlope: slope, rescaleIntercept: intercept,
			photometric: 'MONOCHROME2', pixelDataVR: 'OW',
			pixelBytes: dcmPixelSamples(stored, 16, true),
		});
		cases.push({
			id: 'dicom-rescale-slope-intercept',
			format: 'dicom',
			bytes: buf,
			options: { frameIndex: 0 },
			external: false,
			expectError: false,
			label: 'DICOM Rescale Slope/Intercept',
			// Hand-computed independently of either implementation: raw stored
			// value * slope + intercept, in float32 (both sides store the
			// output as Float32Array).
			expectedData: stored.map(v => Math.fround(v * slope + intercept)),
		});
	}

	// --- DICOM: signed 16-bit + ABSOLUTE hand-computed values --------------------
	{
		// Two's-complement 16-bit stored values -1000 and 500 (no rescale, so
		// the decoded output equals the signed interpretation of the raw bits).
		const stored = [-1000, 500, -1, 0];
		const buf = buildDicom({
			explicit: true, little: true, rows: 2, columns: 2,
			bitsAllocated: 16, bitsStored: 16, signed: 1,
			photometric: 'MONOCHROME2', pixelDataVR: 'OW',
			pixelBytes: dcmPixelSamples(stored, 16, true),
		});
		cases.push({
			id: 'dicom-signed-16bit-absolute',
			format: 'dicom',
			bytes: buf,
			options: { frameIndex: 0 },
			external: false,
			expectError: false,
			label: 'DICOM signed 16-bit absolute',
			expectedData: stored.map(v => Math.fround(v)),
		});
	}

	// --- DICOM: big-endian + ABSOLUTE hand-computed values ------------------------
	{
		// Explicit VR Big Endian: stored value 0x0102 (=258) must be read as
		// big-endian, NOT little-endian (0x0201=513) — this is exactly the
		// class of bug a TS-vs-Rust-only comparison can miss if both sides
		// share the same byte-order mistake.
		const stored = [0x0102, 0x0304, 0xabcd, 0x0000];
		const buf = buildDicom({
			transferSyntaxUID: '1.2.840.10008.1.2.2', explicit: true, little: false,
			rows: 2, columns: 2, bitsAllocated: 16, bitsStored: 16, signed: 0,
			photometric: 'MONOCHROME2', pixelDataVR: 'OW',
			pixelBytes: dcmPixelSamples(stored, 16, false),
		});
		cases.push({
			id: 'dicom-big-endian-absolute',
			format: 'dicom',
			bytes: buf,
			options: { frameIndex: 0 },
			external: false,
			expectError: false,
			label: 'DICOM big-endian absolute',
			expectedData: stored.map(v => Math.fround(v)),
		});
	}

	// --- DICOM: multi-frame with frame_index selection ----------------------------
	{
		const frame0 = [1, 2, 3, 4];
		const frame1 = [10, 20, 30, 40];
		const buf = buildDicom({
			explicit: true, little: true, rows: 2, columns: 2, frames: 2,
			bitsAllocated: 16, bitsStored: 16, signed: 0,
			photometric: 'MONOCHROME2', pixelDataVR: 'OW',
			pixelBytes: dcmPixelSamples([...frame0, ...frame1], 16, true),
		});
		cases.push({
			id: 'dicom-multiframe-frame0',
			format: 'dicom',
			bytes: buf,
			options: { frameIndex: 0 },
			external: false,
			expectError: false,
			label: 'DICOM multi-frame (frame 0)',
			expectedData: frame0.map(v => Math.fround(v)),
		});
		cases.push({
			id: 'dicom-multiframe-frame1',
			format: 'dicom',
			bytes: buf,
			options: { frameIndex: 1 },
			external: false,
			expectError: false,
			label: 'DICOM multi-frame (frame 1)',
			expectedData: frame1.map(v => Math.fround(v)),
		});
	}

	// --- DICOM: RGB (Samples Per Pixel 3), both Planar Configurations -----------
	{
		// 2x1 RGB image: pixel A = (10,20,30), pixel B = (40,50,60).
		const interleaved = [10, 20, 30, 40, 50, 60]; // R0 G0 B0 R1 G1 B1
		const planarValues = [10, 40, 20, 50, 30, 60]; // R0 R1 G0 G1 B0 B1
		const expectedRgb = [10, 20, 30, 40, 50, 60].map(v => Math.fround(v));
		for (const [label, planar, values] of [['planar config 0 (interleaved)', 0, interleaved], ['planar config 1 (planar)', 1, planarValues]]) {
			const buf = buildDicom({
				explicit: true, little: true, rows: 1, columns: 2, samples: 3, planar,
				bitsAllocated: 8, bitsStored: 8, signed: 0,
				photometric: 'RGB', pixelDataVR: 'OB',
				pixelBytes: dcmPixelSamples(values, 8, true),
			});
			cases.push({
				id: `dicom-rgb-${slugify(label)}`,
				format: 'dicom',
				bytes: buf,
				options: { frameIndex: 0 },
				external: false,
				expectError: false,
				label: `DICOM RGB ${label}`,
				expectedData: expectedRgb,
			});
		}
	}

	// --- DICOM negative cases -----------------------------------------------------
	cases.push({
		id: 'dicom-no-dicm-preamble-magic',
		format: 'dicom',
		bytes: Buffer.alloc(32, 0),
		options: { frameIndex: 0 },
		external: false,
		expectError: true,
		label: 'DICOM no DICM preamble/magic',
	});

	cases.push({
		id: 'dicom-truncated-pixel-data-element',
		format: 'dicom',
		bytes: buildDicom({
			// Declares a 4x4 16-bit image (needs 32 bytes of Pixel Data) but only
			// supplies 8 bytes.
			explicit: true, little: true, rows: 4, columns: 4,
			bitsAllocated: 16, bitsStored: 16, signed: 0,
			photometric: 'MONOCHROME2', pixelDataVR: 'OW',
			pixelBytes: dcmPixelSamples([1, 2, 3, 4], 16, true),
		}),
		options: { frameIndex: 0 },
		external: false,
		expectError: true,
		label: 'DICOM truncated pixel data element',
	});

	cases.push({
		id: 'dicom-unsupported-compressed-transfer-syntax',
		format: 'dicom',
		// JPEG 2000 Lossless (1.2.840.10008.1.2.4.90) — not in the supported
		// syntax map (only JPEG Baseline 1.2.840.10008.1.2.4.50 is), and not
		// resolvable via the no-preamble heuristic since a preamble is present.
		bytes: dcmPreamble('1.2.840.10008.1.2.4.90'),
		options: { frameIndex: 0 },
		external: false,
		expectError: true,
		label: 'DICOM unsupported compressed transfer syntax',
	});

	// --- DICOM: JPEG Baseline now decodes natively (dicom-object/dicom-pixeldata) --
	// This case used to be named "...-codec-fallback-error" and assert the
	// `requires codec: jpeg-baseline` rejection that routed decode-worker.ts's
	// TS-extraction + shared zune-jpeg fallback (both deleted). `decode_dicom_fast`
	// now decodes JPEG Baseline directly via dicom-object (parsing) +
	// dicom-pixeldata (codec), so this is repurposed into a real success case —
	// a valid 4x4 RGB baseline JPEG codestream, properly encapsulated (Basic
	// Offset Table + one fragment + Sequence Delimitation Item), replaces the old
	// unparseable 4-byte SOI/EOI-only stand-in. The case id (and therefore its
	// golden's path) is kept unchanged since it is one of the two goldens this
	// port is explicitly allowed to change.
	{
		const jpegBytes = Buffer.from(TINY_JPEG_BASELINE_4X4_RGB_HEX, 'hex');
		const buf = buildEncapsulatedDicom({
			transferSyntaxUID: '1.2.840.10008.1.2.4.50',
			rows: 4, columns: 4, samples: 3, bitsAllocated: 8, bitsStored: 8, signed: 0,
			photometric: 'YBR_FULL_422', fragments: [jpegBytes],
		});
		cases.push({
			id: 'dicom-jpeg-baseline-codec-fallback-error',
			format: 'dicom',
			bytes: buf,
			options: { frameIndex: 0 },
			external: false,
			expectError: false,
			label: 'DICOM JPEG Baseline decodes natively via dicom-object/dicom-pixeldata',
		});
	}

	// --- DICOM: RLE Lossless (synthesized) + ABSOLUTE hand-computed values ------
	// 2x2 MONOCHROME2, 16-bit unsigned, one frame. RLE Lossless splits each
	// 16-bit sample into an MSB segment and an LSB segment (see
	// dicom-transfer-syntax-registry's `rle_lossless.rs` adapter); each segment
	// here is encoded as a trivial PackBits literal run (control byte 0 => copy
	// 1 literal byte), which is valid PackBits even though real encoders favor
	// replicate runs for the common case of repeated bytes.
	{
		const stored = [0x0102, 0x0304, 0xfffe, 0x0000]; // row-major, MSB.LSB per sample
		const msbSegment = stored.map(v => (v >> 8) & 0xff);
		const lsbSegment = stored.map(v => v & 0xff);
		const packBitsLiteral = (bytes) => Buffer.concat(bytes.flatMap(b => [Buffer.from([0x00]), Buffer.from([b])]));
		const segments = [packBitsLiteral(msbSegment), packBitsLiteral(lsbSegment)];
		const header = Buffer.alloc(64);
		header.writeUInt32LE(segments.length, 0);
		let segOffset = 64;
		segments.forEach((seg, i) => { header.writeUInt32LE(segOffset, 4 + i * 4); segOffset += seg.length; });
		const fragment = Buffer.concat([header, ...segments]);
		const buf = buildEncapsulatedDicom({
			transferSyntaxUID: '1.2.840.10008.1.2.5',
			rows: 2, columns: 2, samples: 1, bitsAllocated: 16, bitsStored: 16, signed: 0,
			photometric: 'MONOCHROME2', fragments: [fragment],
		});
		cases.push({
			id: 'dicom-rle-lossless',
			format: 'dicom',
			bytes: buf,
			options: { frameIndex: 0 },
			external: false,
			expectError: false,
			label: 'DICOM RLE Lossless (synthesized)',
			// Hand-computed independently of the decoder: each stored 16-bit
			// value reassembled from its MSB/LSB RLE segments, little-endian,
			// no Rescale Slope/Intercept (defaults to identity).
			expectedData: stored.map(v => Math.fround(v)),
		});
	}

	return cases;
}

// =============================================================================
// Public API
// =============================================================================

function listCases() {
	return [
		...listPfmNetpbmCases(),
		...listNpyCases(),
		...listScientificCases(),
	];
}

module.exports = {
	listCases,
	bufferToArrayBuffer,
	slugify,
	dtypeSlug,
	// Synthesis helpers, exported for anything that needs to rebuild inputs
	// directly (kept here so there is exactly one implementation of each).
	buildNpy,
	buildNpyRaw,
	encodeSamples,
	buildNpz,
	buildNpzEntry,
	buildFits,
	buildFitsHeader,
	fitsCard,
	fitsKV,
	fitsSamples,
	buildNetCdf,
	buildDicom,
	dcmPixelSamples,
	looksLikeDicom,
};
