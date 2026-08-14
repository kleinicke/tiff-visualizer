/**
 * Conformance tests for the Rust/WASM NPY/NPZ decoder
 * (wasm/tiff-decoder/src/formats/npy.rs).
 *
 * Every case (file fixture or in-memory synthesized buffer — see
 * test/lib/decoder-cases.js for the full list and synthesis helpers) is
 * checked two ways:
 *
 *   (a) Rust output == the stored golden snapshot in test/goldens/ (see
 *       test/lib/golden-io.js). This is a REGRESSION check: it freezes
 *       whatever Rust produced at capture time and proves nothing about
 *       whether that output is correct — only that it has not silently
 *       changed. Regenerate deliberately with `npm run goldens:capture`.
 *
 *   (b) Where a case carries `expectedData`, the decoded samples are checked
 *       against independently hand-computed values. This is the CORRECTNESS
 *       check, and it is not redundant: a golden cannot catch a bug that was
 *       already present when it was captured. The historical '>f8'
 *       byte-order bug is the cautionary case — TS and Rust agreed with each
 *       other, and would have agreed with any golden captured from either,
 *       while both were wrong.
 *
 * This decoder has no TypeScript counterpart: the `_parseNpy`/`_parseNpz`
 * parsers it replaced have been deleted, so Rust is the single
 * implementation and the differential check that used to run here is gone.
 *
 * Run with: node test/rust-npy-conformance-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { listCases, bufferToArrayBuffer } = require('./lib/decoder-cases');
const { assertMatchesGolden, expectsRejection } = require('./lib/golden-io');

/**
 * Checks `DecodedArray::finalize_stats` (wasm/tiff-decoder/src/lib.rs)
 * against `ImageStatsCalculator.calculateFloatStats` run independently on the
 * same taken samples. NPY always carries samples as Float32Array regardless
 * of source dtype (see npy-processor.ts), so the decoder always scans via the
 * f32 path — this is the same comparison npy-processor.ts's load path relies
 * on implicitly by trusting the decoder's stats instead of rescanning.
 */
function assertDecoderStats(rust, data, width, height, channels, label, ImageStatsCalculator) {
	const js = ImageStatsCalculator.calculateFloatStats(data, width, height, channels);
	assert.ok(Object.is(rust.data_min, js.min), `${label}: data_min — rust=${rust.data_min} js=${js.min}`);
	assert.ok(Object.is(rust.data_max, js.max), `${label}: data_max — rust=${rust.data_max} js=${js.max}`);
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

	console.log('🧪 Running Rust/WASM NPY/NPZ conformance tests...\n');

	const cases = listCases().filter(c => c.format === 'npy');
	let count = 0;

	for (const kase of cases) {
		let rust = null;
		let rustData = null;
		const rustError = getErrorMessage(() => {
			rust = mod.decode_npy_fast(new Uint8Array(kase.bytes));
			// take_data_as_f32() is destructive (a second call returns an
			// empty vector) — capture it exactly once here and reuse this
			// same reference for every comparison, absolute-value check, and
			// the golden check below.
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

		if (kase.expectedMeta) {
			if (kase.expectedMeta.channels !== undefined) {
				assert.strictEqual(rust.channels, kase.expectedMeta.channels, `${kase.id}: Rust channels must be reported as ${kase.expectedMeta.channels}`);
			}
			if (kase.expectedMeta.dataLength !== undefined) {
				assert.strictEqual(rustData.length, kase.expectedMeta.dataLength, `${kase.id}: Rust data length`);
			}
			if (kase.expectedMeta.width !== undefined) {
				assert.strictEqual(rust.width, kase.expectedMeta.width, `${kase.id}: Rust width`);
			}
		}

		// --- Absolute correctness -----------------------------------------
		// Independently hand-computed expected values, not derived from any
		// implementation. This is the check that would have caught the
		// historical '>f8' byte-order bug; a golden captured from this same
		// Rust build cannot catch such a bug by construction, because it only
		// proves "unchanged", never "correct".
		if (kase.expectedData) {
			for (let i = 0; i < kase.expectedData.length; i++) {
				assert.ok(Object.is(rustData[i], kase.expectedData[i]),
					`${kase.id}: Rust sample ${i} = ${rustData[i]}, expected ${kase.expectedData[i]} — byte-order or decode bug?`);
			}
		}

		// Golden check: proves only that Rust's decoded output hasn't changed
		// since capture — the absolute-value check above is what proves it is
		// correct. The numpy dtype string travels through `metadata.dtype`
		// (see wasm/tiff-decoder/src/formats/npy.rs); numericDomain carries
		// the honest bits/sample-format/type-range Rust derived from it.
		const metadata = JSON.parse(rust.metadata_json);
		assertMatchesGolden(kase, {
			width: rust.width, height: rust.height, channels: rust.channels,
			metadata,
			numericDomain: {
				bitsPerSample: rust.bits_per_sample,
				sampleFormat: rust.sample_format,
				typeMin: rust.type_min,
				typeMax: rust.type_max,
				sourceNumericType: rust.source_numeric_type,
			},
			formatLabel: rust.format_label, data: rustData,
		});
		if (ImageStatsCalculator) {
			assertDecoderStats(rust, rustData, rust.width, rust.height, rust.channels, kase.id, ImageStatsCalculator);
		}

		console.log(`✅ ${kase.id} -> ${rust.width}x${rust.height} ch=${rust.channels} dtype=${metadata.dtype}`);
		count++;
	}

	console.log(`\n🎉 All ${count} Rust/WASM NPY/NPZ conformance checks passed.\n`);
}

main().catch(err => {
	console.error('❌ Rust/WASM NPY/NPZ conformance test failed:');
	console.error(err);
	process.exit(1);
});
