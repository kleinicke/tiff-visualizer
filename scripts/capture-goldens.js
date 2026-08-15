#!/usr/bin/env node
/**
 * Captures golden JSON snapshots of the Rust/WASM decoders' output for every
 * case in test/lib/decoder-cases.js, writing one file per case to
 * test/goldens/<id>.json (or test/goldens/external/<id>.json for cases
 * sourced from the private corpus at
 * /Users/florian/Projects/cursor/test_data/testfiles).
 *
 * This is a ONE-WAY freeze of "whatever the Rust decoder currently outputs".
 * It does not prove correctness — a golden only proves output hasn't changed
 * since capture, even if that output shares a bug with (or differs
 * incorrectly from) the TypeScript reference. The TS-vs-Rust differential
 * checks and the hand-computed absolute-value assertions in the three
 * conformance suites are what catch correctness bugs; this script exists so
 * those suites keep catching REGRESSIONS after the TS parsers this compares
 * against are eventually deleted.
 *
 * Re-runnable and idempotent: run twice with nothing changed and `git
 * status` shows no diff (see test/lib/golden-io.js for the fixed-key-order,
 * deterministic-number-formatting serialization that guarantees this).
 *
 * Run with: npm run goldens:capture
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { listCases } = require('../test/lib/decoder-cases');
const { writeGolden, spreadIndices, buildSamples, computeDigest } = require('../test/lib/golden-io');

const wasmJs = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.js');
const wasmBin = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.wasm');

const DATA_INLINE_LIMIT = 4096;

/**
 * Decodes one case with the Rust/WASM module and returns the raw result
 * fields needed to build a golden record, PLUS the typed array reference
 * captured exactly once (take_data_as_* is destructive: a second call on the
 * same result object returns an empty vector, not the same data again).
 *
 * All seven formats now return the same `DecodedArray` struct (see
 * `crates/image-decoders/src/lib.rs`), so there is one field-reading path here
 * instead of one per format; only which bytes to feed the decoder differs.
 */
function decodeWithRust(mod, kase) {
	const decodeFns = {
		pfm: () => mod.decode_pfm_fast(new Uint8Array(kase.bytes), !!kase.options.topDown),
		ppm: () => mod.decode_ppm_fast(new Uint8Array(kase.bytes)),
		npy: () => mod.decode_npy_fast(new Uint8Array(kase.bytes)),
		fits: () => mod.decode_fits_fast(new Uint8Array(kase.bytes)),
		netcdf: () => mod.decode_netcdf_fast(new Uint8Array(kase.bytes), JSON.stringify(kase.options)),
		dicom: () => mod.decode_dicom_fast(new Uint8Array(kase.bytes), (kase.options.frameIndex || 0) >>> 0),
		czi: () => mod.decode_czi_fast(new Uint8Array(kase.bytes), JSON.stringify(kase.options)),
	};
	const decodeFn = decodeFns[kase.format];
	if (!decodeFn) { throw new Error(`capture-goldens: unknown format ${kase.format}`); }

	const r = decodeFn();
	// sample_kind: 0 = f32, 1 = u8, 2 = u16 — see DecodedArray in lib.rs.
	const data = r.sample_kind === 1 ? r.take_data_as_u8()
		: r.sample_kind === 2 ? r.take_data_as_u16()
			: r.take_data_as_f32();
	return {
		width: r.width, height: r.height, channels: r.channels, data,
		metadata: JSON.parse(r.metadata_json),
		numericDomain: {
			bitsPerSample: r.bits_per_sample,
			sampleFormat: r.sample_format,
			typeMin: r.type_min,
			typeMax: r.type_max,
			sourceNumericType: r.source_numeric_type,
		},
		formatLabel: r.format_label,
	};
}

function buildGoldenRecord(kase, decoded) {
	const { data } = decoded;
	const dataLength = data.length;
	const indices = spreadIndices(dataLength);
	const record = {
		id: kase.id,
		format: kase.format,
		width: decoded.width,
		height: decoded.height,
		channels: decoded.channels,
		dataLength,
		dataDigest: computeDigest(data),
		samples: buildSamples(data, indices),
	};
	if (decoded.metadata !== undefined) { record.metadata = decoded.metadata; }
	if (decoded.numericDomain !== undefined) { record.numericDomain = decoded.numericDomain; }
	if (decoded.formatLabel !== undefined) { record.formatLabel = decoded.formatLabel; }
	if (dataLength <= DATA_INLINE_LIMIT) {
		record.data = buildSamples(data, Array.from({ length: dataLength }, (_, i) => i)).map(s => s.v);
	}
	return record;
}

async function main() {
	if (!fs.existsSync(wasmBin)) {
		console.error('❌ media/wasm/tiff-wasm.wasm not found — run `npm run build:wasm` first.');
		process.exit(1);
	}

	const mod = await import(wasmJs.replace(/\\/g, '/'));
	await mod.default({ module_or_path: fs.readFileSync(wasmBin) });

	const cases = listCases();
	console.log(`🧊 Capturing ${cases.length} golden(s)...\n`);

	let captured = 0;
	let errors = 0;
	for (const kase of cases) {
		try {
			const decoded = decodeWithRust(mod, kase);
			const record = buildGoldenRecord(kase, decoded);
			writeGolden(kase.id, kase.external, record);
			captured++;
		} catch (e) {
			const error = String((e && e.message) || e);
			writeGolden(kase.id, kase.external, { id: kase.id, format: kase.format, error });
			errors++;
		}
	}

	console.log(`✅ Captured ${captured} golden(s), ${errors} error-case golden(s) (${cases.length} total).`);
}

main().catch(err => {
	console.error('❌ Golden capture failed:');
	console.error(err);
	process.exit(1);
});
