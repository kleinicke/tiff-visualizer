/**
 * Conformance tests for the Rust/WASM PFM and NetPBM (PBM/PGM/PPM) decoders
 * (crates/image-decoders/src/formats/pfm.rs, netpbm.rs).
 *
 * Every case (file fixture or in-memory synthesized buffer — see
 * test/lib/decoder-cases.js for the full list and the synthesis helpers) is
 * checked two ways:
 *
 *   (a) Rust output == the stored golden snapshot in test/goldens/ (see
 *       test/lib/golden-io.js). This is a REGRESSION check: a golden freezes
 *       whatever Rust produced at capture time, so it proves nothing about
 *       whether that output is correct — only that it has not silently
 *       changed. Regenerate deliberately with `npm run goldens:capture`.
 *
 *   (b) Where a case carries `expectedData` in test/lib/decoder-cases.js,
 *       the decoded samples are checked against independently hand-computed
 *       values. This is the CORRECTNESS check. It matters because goldens
 *       cannot catch a bug that was already present when they were captured.
 *
 * These decoders have no TypeScript counterpart: the `_parsePfm`/`_parsePpm`
 * parsers this port replaced have been deleted, so Rust is the single
 * implementation and the differential check that used to run here is gone.
 *
 * Negative cases assert the exact rejection message against the golden.
 *
 * Run with: node test/rust-netpbm-conformance-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { listCases, bufferToArrayBuffer } = require('./lib/decoder-cases');
const { assertMatchesGolden, expectsRejection } = require('./lib/golden-io');

/** Hand-computed expectations: the only check here that proves correctness
 * rather than mere stability, since goldens freeze whatever was captured. */
function assertExpectedData(kase, data) {
	if (!kase.expectedData) { return; }
	for (let i = 0; i < kase.expectedData.length; i++) {
		assert.ok(Object.is(data[i], kase.expectedData[i]),
			`${kase.id}: sample ${i} = ${data[i]}, expected ${kase.expectedData[i]}`);
	}
}

/**
 * Checks `DecodedArray::finalize_stats` (crates/image-decoders/src/lib.rs) — the
 * stats now carried on every decode result — against `ImageStatsCalculator`
 * run independently on the same taken samples. Not part of the golden
 * comparison (goldens must stay byte-for-byte unchanged by this port), so
 * this is a separate assertion. `ImageStatsCalculator` has no non-finite
 * concept for integer carriers (u8/u16 can't be NaN), so valid_count is
 * every scanned sample and non_finite_count is always 0 for NetPBM/PFM.
 */
function assertDecoderStats(rust, data, width, height, channels, label, ImageStatsCalculator) {
	const isFloat = data instanceof Float32Array;
	const js = isFloat
		? ImageStatsCalculator.calculateFloatStats(data, width, height, channels)
		: ImageStatsCalculator.calculateIntegerStats(data, width, height, channels, false);
	assert.ok(Object.is(rust.data_min, js.min), `${label}: data_min — rust=${rust.data_min} js=${js.min}`);
	assert.ok(Object.is(rust.data_max, js.max), `${label}: data_max — rust=${rust.data_max} js=${js.max}`);
	if (!isFloat) {
		const scanChannels = channels <= 2 ? 1 : Math.min(channels, 3);
		assert.strictEqual(rust.non_finite_count, 0, `${label}: non_finite_count`);
		assert.strictEqual(rust.valid_count, width * height * scanChannels, `${label}: valid_count`);
	}
}

const wasmJs = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.js');
const wasmBin = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.wasm');
const OUT = path.join(__dirname, '..', 'out', 'media', 'modules');
const moduleUrl = name => require('url').pathToFileURL(path.join(OUT, name)).href;

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

	let ImageStatsCalculator = null;
	if (fs.existsSync(path.join(OUT, 'normalization-helper.js'))) {
		({ ImageStatsCalculator } = await import(moduleUrl('normalization-helper.js')));
	} else {
		console.log('⚠️  out/media/modules/normalization-helper.js not found — run `npm run compile` first. Skipping decoder-stats checks.\n');
	}

	console.log('🧪 Running Rust/WASM PFM + NetPBM conformance tests...\n');

	const cases = listCases();
	const pfmCases = cases.filter(c => c.format === 'pfm');
	const ppmCases = cases.filter(c => c.format === 'ppm');

	let count = 0;

	// --- PFM cases --------------------------------------------------------
	for (const kase of pfmCases) {
		let rust = null;
		let rustData = null;
		const rustError = getErrorMessage(() => {
			rust = mod.decode_pfm_fast(new Uint8Array(kase.bytes), !!kase.options.topDown);
			// take_data_as_f32() is destructive (a second call returns an
			// empty vector) — capture it exactly once here and reuse this
			// same reference for every comparison and the golden check below.
			rustData = rust.take_data_as_f32();
		});

		if (rustError !== null) {
			assert.ok(expectsRejection(kase), `${kase.id}: unexpected rejection "${rustError}"`);
			assertMatchesGolden(kase, { error: rustError });
			console.log(`✅ ${kase.id} rejected: "${rustError}"`);
			count++;
			continue;
		}
		assert.ok(!expectsRejection(kase), `${kase.id}: expected a rejection but decoded successfully`);

		assertMatchesGolden(kase, {
			width: rust.width, height: rust.height, channels: rust.channels,
			metadata: JSON.parse(rust.metadata_json),
			numericDomain: {
				bitsPerSample: rust.bits_per_sample,
				sampleFormat: rust.sample_format,
				typeMin: rust.type_min,
				typeMax: rust.type_max,
				sourceNumericType: rust.source_numeric_type,
			},
			formatLabel: rust.format_label, data: rustData,
		});
		assertExpectedData(kase, rustData);
		if (ImageStatsCalculator) {
			assertDecoderStats(rust, rustData, rust.width, rust.height, rust.channels, kase.id, ImageStatsCalculator);
		}

		console.log(`✅ PFM ${kase.id} -> ${rust.width}x${rust.height} ch=${rust.channels}`);
		count++;
	}

	// --- NetPBM cases -------------------------------------------------------
	for (const kase of ppmCases) {
		let rust = null;
		let rustData = null;
		const rustError = getErrorMessage(() => {
			rust = mod.decode_ppm_fast(new Uint8Array(kase.bytes));
			// Same destructive-call hazard as above: capture once, reuse.
			// sample_kind: 0 = f32, 1 = u8, 2 = u16 (see DecodedArray in lib.rs).
			rustData = rust.sample_kind === 2 ? rust.take_data_as_u16() : rust.take_data_as_u8();
		});

		if (rustError !== null) {
			assert.ok(expectsRejection(kase), `${kase.id}: unexpected rejection "${rustError}"`);
			assertMatchesGolden(kase, { error: rustError });
			console.log(`✅ ${kase.id} rejected: "${rustError}"`);
			count++;
			continue;
		}
		assert.ok(!expectsRejection(kase), `${kase.id}: expected a rejection but decoded successfully`);

		assertMatchesGolden(kase, {
			width: rust.width, height: rust.height, channels: rust.channels,
			metadata: JSON.parse(rust.metadata_json),
			numericDomain: {
				bitsPerSample: rust.bits_per_sample,
				sampleFormat: rust.sample_format,
				typeMin: rust.type_min,
				typeMax: rust.type_max,
				sourceNumericType: rust.source_numeric_type,
			},
			formatLabel: rust.format_label, data: rustData,
		});
		assertExpectedData(kase, rustData);
		if (ImageStatsCalculator) {
			assertDecoderStats(rust, rustData, rust.width, rust.height, rust.channels, kase.id, ImageStatsCalculator);
		}

		console.log(`✅ ${rust.format_label} ${kase.id} -> ${rust.width}x${rust.height} ch=${rust.channels} maxval=${rust.type_max}`);
		count++;
	}

	console.log(`\n🎉 All ${count} Rust/WASM PFM + NetPBM conformance checks passed.\n`);
}

main().catch(err => {
	console.error('❌ Rust/WASM PFM + NetPBM conformance test failed:');
	console.error(err);
	process.exit(1);
});
