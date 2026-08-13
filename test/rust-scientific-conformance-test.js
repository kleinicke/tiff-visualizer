/**
 * Conformance tests for the Rust/WASM FITS, NetCDF, and DICOM decoders
 * (wasm/tiff-decoder/src/formats/fits.rs, netcdf.rs, dicom.rs).
 *
 * Every case (real fixture, external-corpus fixture, or in-memory
 * synthesized buffer — see test/lib/decoder-cases.js for the full list and
 * synthesis helpers) is checked two ways:
 *
 *   (a) Rust output == the stored golden snapshot in test/goldens/ (see
 *       test/lib/golden-io.js; external-corpus cases' goldens live under
 *       test/goldens/external/). This is a REGRESSION check: it freezes
 *       whatever Rust produced at capture time and proves nothing about
 *       whether that output is correct — only that it has not silently
 *       changed. Regenerate deliberately with `npm run goldens:capture`.
 *
 *   (b) Where a case carries `expectedData`, samples are checked against
 *       independently hand-computed values (BSCALE/BZERO, scale_factor/
 *       add_offset, Rescale Slope/Intercept, signed and big-endian decoding).
 *       This is the CORRECTNESS check, and it is not redundant: a golden
 *       cannot flag a bug that was already present when it was captured.
 *
 * These decoders have no TypeScript counterpart: the `parseFits`,
 * `parseNetCdf` and `parseDicom` parsers they replaced have been deleted, so
 * Rust is the single implementation and the differential check that used to
 * run here is gone. (`extractDicomJpegFrame` and the CZI parser remain in
 * TypeScript — CZI has not been ported.)
 *
 * A real corpus file the decoder legitimately refuses (e.g. a FITS whose only
 * HDUs are tables, not images) is still a case: it is marked `expectError` and
 * its exact rejection message is asserted against the golden.
 *
 * Run with: node test/rust-scientific-conformance-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { listCases, bufferToArrayBuffer } = require('./lib/decoder-cases');
const { assertMatchesGolden, expectsRejection } = require('./lib/golden-io');

const wasmJs = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.js');
const wasmBin = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.wasm');

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

	console.log('🧪 Running Rust/WASM FITS/NetCDF/DICOM conformance tests...\n');
	let count = 0;

	/** Decodes with Rust and captures the destructive take_data_as_f32()
	 * result exactly once, returning { rust, rustData } so every subsequent
	 * comparison, absolute-value check, and golden check reuses the same
	 * typed-array reference rather than re-calling the destructive method. */
	function decodeRust(kase) {
		let rust;
		if (kase.format === 'fits') { rust = mod.decode_fits_fast(new Uint8Array(kase.bytes)); }
		else if (kase.format === 'netcdf') { rust = mod.decode_netcdf_fast(new Uint8Array(kase.bytes), JSON.stringify(kase.options)); }
		else { rust = mod.decode_dicom_fast(new Uint8Array(kase.bytes), (kase.options.frameIndex || 0) >>> 0); }
		const rustData = rust.take_data_as_f32();
		return { rust, rustData };
	}

	for (const kase of listCases().filter(c => c.format === 'fits' || c.format === 'netcdf' || c.format === 'dicom')) {
		let rust = null;
		let rustData = null;
		const rustError = getErrorMessage(() => {
			const decoded = decodeRust(kase);
			rust = decoded.rust;
			rustData = decoded.rustData;
		});

		if (rustError !== null) {
			assert.ok(expectsRejection(kase), `${kase.id}: unexpected rejection "${rustError}"`);
			assertMatchesGolden(kase, { error: rustError });
			console.log(`✅ ${kase.id} rejected: "${rustError}"`);
			count++;
			continue;
		}
		assert.ok(!expectsRejection(kase), `${kase.id}: expected a rejection but decoded successfully`);

		const rustMeta = JSON.parse(rust.metadata_json);

		if (kase.expectedMeta) {
			if (kase.expectedMeta.firstPlaneOnly !== undefined) {
				assert.strictEqual(rustMeta.firstPlaneOnly, kase.expectedMeta.firstPlaneOnly, `${kase.id}: firstPlaneOnly`);
			}
			if (kase.expectedMeta.dataLength !== undefined) {
				assert.strictEqual(rustData.length, kase.expectedMeta.dataLength, `${kase.id}: data length`);
			}
			if (kase.expectedMeta.variable !== undefined) {
				assert.strictEqual(rustMeta.variable, kase.expectedMeta.variable, `${kase.id}: metadata.variable`);
			}
		}

		// --- Absolute correctness -----------------------------------------
		// Independently hand-computed expected values (BSCALE/BZERO,
		// scale_factor/add_offset, Rescale Slope/Intercept, signed/
		// big-endian bit decoding, etc.) — NOT derived from either
		// implementation. This is what would catch a bug both TS and Rust
		// share (or a bug that was already present when a golden was
		// captured, which a golden comparison can never flag, since a
		// golden only proves output is unchanged since capture — it has no
		// opinion on whether that output was ever right).
		if (kase.expectedData) {
			for (let i = 0; i < kase.expectedData.length; i++) {
				assert.ok(Object.is(rustData[i], kase.expectedData[i]),
					`${kase.id}: Rust sample ${i} = ${rustData[i]}, expected ${kase.expectedData[i]} — decode bug?`);
			}
		}

		// Golden check: only proves Rust's decoded output/metadata hasn't
		// changed since capture, not that it's correct — that's what the
		// TS-vs-Rust and (where present) absolute-value checks above do.
		assertMatchesGolden(kase, {
			width: rust.width, height: rust.height, channels: rust.channels, data: rustData,
			metadata: rustMeta,
			numericDomain: {
				bitsPerSample: rust.bits_per_sample,
				sampleFormat: rust.sample_format,
				typeMin: rust.type_min,
				typeMax: rust.type_max,
				sourceNumericType: rust.source_numeric_type,
			},
		});

		console.log(`✅ ${kase.id} -> ${rust.width}x${rust.height} ch=${rust.channels} type=${rust.source_numeric_type}`);
		count++;
	}

	console.log(`\n🎉 All ${count} Rust/WASM FITS/NetCDF/DICOM conformance checks passed.\n`);
}

main().catch(err => {
	console.error('❌ Rust/WASM FITS/NetCDF conformance test failed:');
	console.error(err);
	process.exit(1);
});
