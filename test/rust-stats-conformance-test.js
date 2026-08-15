/**
 * Conformance tests for the Rust image-statistics port
 * (crates/image-decoders/src/pipeline/stats.rs's `compute_image_stats_f32/u8/u16`
 * wasm-bindgen entry points, ported from `ImageStatsCalculator` in
 * media/modules/normalization-helper.ts).
 *
 * `ImageStatsCalculator`'s JS loops are no longer routed through WASM at
 * runtime (that routing — `media/modules/wasm-stats.ts` — was deleted once
 * the seven Rust-decoded formats started getting their stats for free from
 * `DecodedArray::finalize_stats` instead of rescanning in JS; see
 * `test/rust-netpbm-conformance-test.js` / `rust-npy-conformance-test.js` /
 * `rust-scientific-conformance-test.js` for that comparison). This suite
 * keeps BOTH implementations under test anyway — `pipeline::stats` is still
 * the shared engine `finalize_stats` calls internally, and `ImageStatsCalculator`
 * still runs for layered/composite previews and settings-change recompute —
 * so it stays a genuine differential check on the underlying stats math, not
 * a production code path. Every case is checked with
 * `Object.is` so -0 and NaN compare correctly (a `===` comparison would
 * treat `NaN !== NaN` as a mismatch and `-0 === 0` as a match, hiding bugs
 * in either direction).
 *
 * Agreement between the two implementations cannot catch a bug they share
 * — that is exactly how the historical '>f8' byte-order bug survived a
 * TS-vs-Rust-only suite elsewhere in this project. Part 3 below adds
 * absolute, independently-computed expectations (plain mean/variance
 * arithmetic and the RGB24 packing formula, computed by hand and verified
 * with a throwaway calculation completely outside both implementations)
 * that neither implementation can pass by agreeing with the other while
 * both being wrong.
 *
 * Run with: node test/rust-stats-conformance-test.js  (after `npm run
 * compile` and `npm run build:wasm`)
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { listCases } = require('./lib/decoder-cases');

const wasmJs = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.js');
const wasmBin = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.wasm');
const OUT = path.join(__dirname, '..', 'out', 'media', 'modules');
const moduleUrl = name => pathToFileURL(path.join(OUT, name)).href;

let passed = 0;
let failed = 0;

function test(name, fn) {
	try {
		fn();
		passed++;
		console.log(`  ✅ ${name}`);
	} catch (error) {
		failed++;
		console.log(`  ❌ ${name}`);
		console.log(`     ${error.stack || error.message}`);
	}
}

/** `Object.is`-based comparison of a {min,max} pair. */
function assertBasicEqual(rust, js, label) {
	assert.ok(Object.is(rust.min, js.min), `${label}: min — rust=${rust.min} js=${js.min}`);
	assert.ok(Object.is(rust.max, js.max), `${label}: max — rust=${rust.max} js=${js.max}`);
}

/** `Object.is`-based comparison of a full extended-stats result. */
function assertExtendedEqual(rust, js, label) {
	assertBasicEqual(rust, js, label);
	assert.ok(Object.is(rust.mean, js.mean), `${label}: mean — rust=${rust.mean} js=${js.mean}`);
	assert.ok(Object.is(rust.std, js.std), `${label}: std — rust=${rust.std} js=${js.std}`);
	assert.ok(Object.is(rust.validCount, js.validCount), `${label}: validCount — rust=${rust.validCount} js=${js.validCount}`);
	assert.ok(Object.is(rust.nonFiniteCount, js.nonFiniteCount), `${label}: nonFiniteCount — rust=${rust.nonFiniteCount} js=${js.nonFiniteCount}`);
	assert.ok(Object.is(rust.totalCount, js.totalCount), `${label}: totalCount — rust=${rust.totalCount} js=${js.totalCount}`);
}

/** Rust's `ImageStats` (wasm-bindgen getters) -> plain {min,max} object. */
function rustBasic(imageStats) {
	return { min: imageStats.min, max: imageStats.max };
}

/** Rust's `ImageStats` -> plain extended-stats object, same shape as JS. */
function rustExtended(imageStats) {
	return {
		min: imageStats.min,
		max: imageStats.max,
		mean: imageStats.mean,
		std: imageStats.std,
		validCount: imageStats.valid_count,
		nonFiniteCount: imageStats.non_finite_count,
		totalCount: imageStats.total_count,
	};
}

async function main() {
	if (!fs.existsSync(wasmBin)) {
		console.log('⚠️  media/wasm/tiff-wasm.wasm not found — run `npm run build:wasm` first. Skipping.');
		return;
	}
	if (!fs.existsSync(path.join(OUT, 'normalization-helper.js'))) {
		console.log('⚠️  out/media/modules/normalization-helper.js not found — run `npm run compile` first. Skipping.');
		return;
	}

	const mod = await import(wasmJs.replace(/\\/g, '/'));
	await mod.default({ module_or_path: fs.readFileSync(wasmBin) });

	// Imported WITHOUT ever calling `initWasm()`/`getWasmModule()` in this
	// process, so `getWasmModuleSync()` (used internally by
	// `ImageStatsCalculator`) stays null and every call below genuinely
	// exercises the JS loop fallback — not a second call into the same wasm
	// module we already loaded above as `mod`.
	const { ImageStatsCalculator } = await import(moduleUrl('normalization-helper.js'));

	console.log('🧪 Running Rust/WASM image-stats conformance tests...\n');

	// -------------------------------------------------------------------
	// Part 1: every decoder fixture already available via decoder-cases.js.
	// Decode with Rust, then run stats through both implementations.
	// -------------------------------------------------------------------
	function decodeCase(kase) {
		let result;
		if (kase.format === 'pfm') { result = mod.decode_pfm_fast(new Uint8Array(kase.bytes), kase.options.topDown !== false); }
		else if (kase.format === 'ppm') { result = mod.decode_ppm_fast(new Uint8Array(kase.bytes)); }
		else if (kase.format === 'npy') { result = mod.decode_npy_fast(new Uint8Array(kase.bytes)); }
		else if (kase.format === 'fits') { result = mod.decode_fits_fast(new Uint8Array(kase.bytes)); }
		else if (kase.format === 'netcdf') { result = mod.decode_netcdf_fast(new Uint8Array(kase.bytes), JSON.stringify(kase.options || {})); }
		else if (kase.format === 'dicom') { result = mod.decode_dicom_fast(new Uint8Array(kase.bytes), (kase.options.frameIndex || 0) >>> 0); }
		else if (kase.format === 'czi') { result = mod.decode_czi_fast(new Uint8Array(kase.bytes), JSON.stringify(kase.options || {})); }
		else { return null; }

		const sampleKind = result.sample_kind;
		const data = sampleKind === 1 ? result.take_data_as_u8()
			: sampleKind === 2 ? result.take_data_as_u16()
			: result.take_data_as_f32();
		return { width: result.width, height: result.height, channels: result.channels, data, sampleKind };
	}

	let fixtureCount = 0;
	for (const kase of listCases()) {
		let decoded;
		try {
			decoded = decodeCase(kase);
		} catch {
			// Cases this decoder legitimately rejects are exercised by the
			// format-specific conformance suites; stats have nothing to
			// scan for them here.
			continue;
		}
		if (!decoded || decoded.width === 0 || decoded.height === 0 || decoded.data.length === 0) { continue; }

		const { width, height, channels, data, sampleKind } = decoded;
		fixtureCount++;

		test(`${kase.id}: fixture basic stats agree`, () => {
			let rust, js;
			if (sampleKind === 0) {
				rust = rustBasic(mod.compute_image_stats_f32(data, width, height, channels, false));
				js = ImageStatsCalculator.calculateFloatStats(data, width, height, channels);
			} else if (sampleKind === 1) {
				rust = rustBasic(mod.compute_image_stats_u8(data, width, height, channels, false));
				js = ImageStatsCalculator.calculateIntegerStats(data, width, height, channels, false);
			} else {
				rust = rustBasic(mod.compute_image_stats_u16(data, width, height, channels, false));
				js = ImageStatsCalculator.calculateIntegerStats(data, width, height, channels, false);
			}
			assertBasicEqual(rust, js, kase.id);
		});

		if (sampleKind === 0) {
			test(`${kase.id}: fixture extended stats agree`, () => {
				const rust = rustExtended(mod.compute_image_stats_f32(data, width, height, channels, true));
				const js = ImageStatsCalculator.calculateExtendedStats(data, width, height, channels);
				assertExtendedEqual(rust, js, kase.id);
			});
		}
	}
	console.log(`  (${fixtureCount} decoder fixtures exercised)\n`);

	// -------------------------------------------------------------------
	// Part 2: synthesized arrays covering the matrix the port must get
	// right — non-finite handling, channel/alpha scanning, rgbAs24Bit,
	// extreme sizes, and type extremes.
	// -------------------------------------------------------------------

	/** Builds `pixelCount` pixels x `channels` samples of Float32Array data
	 * from a per-sample generator `gen(pixelIndex, channelIndex)`. */
	function buildF32(pixelCount, channels, gen) {
		const data = new Float32Array(pixelCount * channels);
		for (let i = 0; i < pixelCount; i++) {
			for (let c = 0; c < channels; c++) { data[i * channels + c] = gen(i, c); }
		}
		return data;
	}

	function buildU(TypedArrayCtor, pixelCount, channels, gen) {
		const data = new TypedArrayCtor(pixelCount * channels);
		for (let i = 0; i < pixelCount; i++) {
			for (let c = 0; c < channels; c++) { data[i * channels + c] = gen(i, c); }
		}
		return data;
	}

	function checkFloat(label, data, width, height, channels, extended) {
		test(`synth f32 ${label} (extended=${extended})`, () => {
			const rust = extended
				? rustExtended(mod.compute_image_stats_f32(data, width, height, channels, true))
				: rustBasic(mod.compute_image_stats_f32(data, width, height, channels, false));
			const js = extended
				? ImageStatsCalculator.calculateExtendedStats(data, width, height, channels)
				: ImageStatsCalculator.calculateFloatStats(data, width, height, channels);
			if (extended) { assertExtendedEqual(rust, js, label); } else { assertBasicEqual(rust, js, label); }
		});
	}

	function checkInt(label, data, width, height, channels, rgbAs24Bit) {
		const isU16 = data instanceof Uint16Array;
		test(`synth ${isU16 ? 'u16' : 'u8'} ${label} (rgbAs24Bit=${rgbAs24Bit})`, () => {
			const rust = rustBasic(isU16
				? mod.compute_image_stats_u16(data, width, height, channels, rgbAs24Bit)
				: mod.compute_image_stats_u8(data, width, height, channels, rgbAs24Bit));
			const js = ImageStatsCalculator.calculateIntegerStats(data, width, height, channels, rgbAs24Bit);
			assertBasicEqual(rust, js, label);
		});
	}

	// All-finite, every channel count.
	for (const channels of [1, 2, 3, 4]) {
		const width = 4, height = 3;
		const data = buildF32(width * height, channels, (i, c) => (i * channels + c) * 0.5 - 3.25);
		checkFloat(`all-finite ${channels}ch`, data, width, height, channels, false);
		checkFloat(`all-finite ${channels}ch`, data, width, height, channels, true);
	}

	// Some NaN.
	{
		const width = 5, height = 2, channels = 1;
		const data = buildF32(width * height, channels, (i) => (i % 3 === 0 ? NaN : i - 4));
		checkFloat('some-nan', data, width, height, channels, false);
		checkFloat('some-nan', data, width, height, channels, true);
	}

	// Some +Infinity.
	{
		const width = 5, height = 2, channels = 1;
		const data = buildF32(width * height, channels, (i) => (i % 4 === 0 ? Infinity : i));
		checkFloat('some-pos-inf', data, width, height, channels, false);
		checkFloat('some-pos-inf', data, width, height, channels, true);
	}

	// Some -Infinity.
	{
		const width = 5, height = 2, channels = 1;
		const data = buildF32(width * height, channels, (i) => (i % 4 === 1 ? -Infinity : -i));
		checkFloat('some-neg-inf', data, width, height, channels, false);
		checkFloat('some-neg-inf', data, width, height, channels, true);
	}

	// ALL non-finite (mix of NaN/+Inf/-Inf) — the "no valid samples" edge
	// case: calculateFloatStats must keep +/-Infinity, calculateExtendedStats
	// must report NaN.
	{
		const width = 3, height = 2, channels = 1;
		const data = buildF32(width * height, channels, (i) => [NaN, Infinity, -Infinity][i % 3]);
		checkFloat('all-non-finite', data, width, height, channels, false);
		checkFloat('all-non-finite', data, width, height, channels, true);
	}

	// Single sample.
	{
		checkFloat('single-sample-finite', new Float32Array([42.5]), 1, 1, 1, false);
		checkFloat('single-sample-finite', new Float32Array([42.5]), 1, 1, 1, true);
		checkFloat('single-sample-nan', new Float32Array([NaN]), 1, 1, 1, false);
		checkFloat('single-sample-nan', new Float32Array([NaN]), 1, 1, 1, true);
	}

	// Empty array.
	{
		checkFloat('empty', new Float32Array(0), 0, 0, 1, false);
		checkFloat('empty', new Float32Array(0), 0, 0, 1, true);
		checkInt('empty', new Uint8Array(0), 0, 0, 1, false);
		checkInt('empty', new Uint16Array(0), 0, 0, 1, false);
	}

	// NaN/Infinity hidden in a non-scanned alpha channel must NOT affect
	// float stats (channels === 2: gray+alpha; channels === 4: RGB+A).
	{
		const width = 3, height = 1, channels = 2;
		const data = buildF32(width * height, channels, (i, c) => (c === 0 ? i + 1 : NaN));
		checkFloat('alpha-hidden-nan-2ch', data, width, height, channels, false);
		checkFloat('alpha-hidden-nan-2ch', data, width, height, channels, true);
	}
	{
		const width = 3, height = 1, channels = 4;
		const data = buildF32(width * height, channels, (i, c) => (c < 3 ? i + c : Infinity));
		checkFloat('alpha-hidden-inf-4ch', data, width, height, channels, false);
		checkFloat('alpha-hidden-inf-4ch', data, width, height, channels, true);
	}

	// uint8/uint16, 1/2/3/4 channels, rgbAs24Bit true and false.
	for (const channels of [1, 2, 3, 4]) {
		const width = 4, height = 2;
		const u8 = buildU(Uint8Array, width * height, channels, (i, c) => (i * channels + c) % 256);
		checkInt(`u8 ${channels}ch`, u8, width, height, channels, false);
		if (channels >= 3) { checkInt(`u8 ${channels}ch`, u8, width, height, channels, true); }

		const u16 = buildU(Uint16Array, width * height, channels, (i, c) => (i * channels + c * 4111) % 65536);
		checkInt(`u16 ${channels}ch`, u16, width, height, channels, false);
		if (channels >= 3) { checkInt(`u16 ${channels}ch`, u16, width, height, channels, true); }
	}

	// Values at type extremes.
	{
		checkInt('u8-extremes', new Uint8Array([0, 255, 0, 255]), 4, 1, 1, false);
		checkInt('u16-extremes', new Uint16Array([0, 65535, 0, 65535]), 4, 1, 1, false);
		checkFloat('f32-extremes', new Float32Array([-3.4028235e38, 3.4028235e38, 0, -0]), 4, 1, 1, false);
		checkFloat('f32-extremes', new Float32Array([-3.4028235e38, 3.4028235e38, 0, -0]), 4, 1, 1, true);
	}

	// -------------------------------------------------------------------
	// Part 3: ABSOLUTE hand-computed expectations. Independently computed
	// (plain mean/variance arithmetic; the RGB24 packing formula), NOT
	// derived from either implementation under test — agreement between
	// Rust and JS cannot catch a bug both share.
	// -------------------------------------------------------------------

	test('absolute: f32 [1,2,3,4], 1ch — mean/std by hand', () => {
		const data = new Float32Array([1, 2, 3, 4]);
		// mean = (1+2+3+4)/4 = 2.5
		// variance = ((1-2.5)^2 + (2-2.5)^2 + (3-2.5)^2 + (4-2.5)^2) / 4
		//          = (2.25 + 0.25 + 0.25 + 2.25) / 4 = 5/4 = 1.25
		// std = sqrt(1.25) = 1.118033988749895...
		const rust = rustExtended(mod.compute_image_stats_f32(data, 4, 1, 1, true));
		assert.strictEqual(rust.min, 1);
		assert.strictEqual(rust.max, 4);
		assert.strictEqual(rust.mean, 2.5);
		assert.ok(Math.abs(rust.std - 1.118033988749895) < 1e-12, `std=${rust.std}`);
		assert.strictEqual(rust.validCount, 4);
		assert.strictEqual(rust.nonFiniteCount, 0);
		assert.strictEqual(rust.totalCount, 4);
	});

	test('absolute: f32 [1,NaN,3,+Inf,-Inf,5], 1ch — non-finite excluded by hand', () => {
		const data = new Float32Array([1, NaN, 3, Infinity, -Infinity, 5]);
		// Valid samples: 1, 3, 5. sum=9, mean=3.
		// sumSq = 1 + 9 + 25 = 35. variance = 35/3 - 9 = 11.666... - 9 = 2.6666...
		// std = sqrt(2.6666...) = 1.6329931618554518...
		const rust = rustExtended(mod.compute_image_stats_f32(data, 6, 1, 1, true));
		assert.strictEqual(rust.min, 1);
		assert.strictEqual(rust.max, 5);
		assert.strictEqual(rust.mean, 3);
		assert.ok(Math.abs(rust.std - 1.6329931618554518) < 1e-12, `std=${rust.std}`);
		assert.strictEqual(rust.validCount, 3);
		assert.strictEqual(rust.nonFiniteCount, 3);
		assert.strictEqual(rust.totalCount, 6);
	});

	test('absolute: u8 rgbAs24Bit — packing formula by hand', () => {
		// Pixel 0: (r=1, g=2, b=3) -> (1<<16) | (2<<8) | 3 = 65536 + 512 + 3 = 66051
		// Pixel 1: (r=255,g=255,b=255) -> 16777215 (0xFFFFFF)
		const data = new Uint8Array([1, 2, 3, 255, 255, 255]);
		const rust = rustBasic(mod.compute_image_stats_u8(data, 2, 1, 3, true));
		assert.strictEqual(rust.min, 66051);
		assert.strictEqual(rust.max, 16777215);
	});

	console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
	if (failed > 0) { process.exitCode = 1; }
}

main().catch(error => {
	console.error('Fatal error:', error);
	process.exitCode = 1;
});
