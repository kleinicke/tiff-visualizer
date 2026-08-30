/**
 * The parallel decode path must produce EXACTLY what the single-threaded one
 * does — otherwise a file's pixels depend on how many workers were free.
 *
 * `tiff_float_strip_plan` splits a TIFF into units of work: one strip, or one
 * whole tile ROW. This test does what media/modules/strip-parallel-decode.ts
 * does — slice the file into per-range blobs, decode each range on its own,
 * assemble — and asserts the result is identical to `decode_tiff` on the whole
 * file, sample for sample, for every eligible file in test-samples.
 *
 * Both worker entry points are covered: `decode_tiff_float_strip_range` (f32
 * samples) and `decode_tiff_strip_range_raw` (native little-endian bytes in the
 * carrier the renderer wants).
 *
 * Run with: node test/strip-parallel-conformance-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const samplesDir = path.join(__dirname, '..', 'test-samples');
const wasmJs = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.js');
const wasmBin = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.wasm');
const codecJs = path.join(__dirname, '..', 'media', 'wasm', 'codec-wasm.js');
const codecBin = path.join(__dirname, '..', 'media', 'wasm', 'codec-wasm.wasm');

/** Mirrors `carrierFor` in strip-parallel-decode.ts. */
function carrierFor(bitsPerSample, sampleFormat) {
	if (sampleFormat === 1 && bitsPerSample === 8) { return 'u8'; }
	if (sampleFormat === 1 && bitsPerSample === 16) { return 'u16'; }
	if (sampleFormat === 3 && bitsPerSample === 32) { return 'f32'; }
	return null;
}

/** Split `unitCount` units into `parts` contiguous ranges, as the pool does. */
function splitRanges(unitCount, parts) {
	const ranges = [];
	const per = Math.max(1, Math.floor(unitCount / parts));
	let cursor = 0;
	while (cursor < unitCount) {
		const last = ranges.length === parts - 1 ? unitCount : Math.min(unitCount, cursor + per);
		ranges.push({ first: cursor, last });
		cursor = last;
		if (ranges.length === parts) { break; }
	}
	if (cursor < unitCount) { ranges[ranges.length - 1].last = unitCount; }
	return ranges;
}

async function main() {
	if (!fs.existsSync(wasmBin)) {
		console.log('⚠️  media/wasm/tiff-wasm.wasm not found — run `npm run build:wasm` first. Skipping.');
		return;
	}

	console.log('🧪 Running strip/tile-parallel conformance tests...\n');

	// Both builds are swept, because each pool decodes with the module that
	// produced its plan. The core module's plan must never claim a codec that
	// build cannot decode (every worker would then fail on the file), and the
	// codec module has to hold the equality for the heavy codecs too.
	const totals = { eligible: 0, tiled: 0, codecs: new Set() };
	for (const [label, js, bin] of [
		['core module', wasmJs, wasmBin],
		['codec module', codecJs, codecBin],
	]) {
		if (!fs.existsSync(bin)) {
			console.log(`⚠️  ${path.basename(bin)} not found — skipping the ${label} sweep.`);
			continue;
		}
		const mod = await import(js.replace(/\\/g, '/'));
		await mod.default({ module_or_path: fs.readFileSync(bin) });
		console.log(`— ${label} —`);
		const swept = await sweep(mod);
		totals.eligible += swept.eligible;
		totals.tiled += swept.tiled;
		for (const codec of swept.codecs) { totals.codecs.add(codec); }
	}

	assert.ok(totals.eligible >= 10,
		`expected the plan to accept a decent share of the corpus, got ${totals.eligible}`);
	assert.ok(totals.tiled >= 3, `expected tiled files to be eligible, got ${totals.tiled}`);
	// The point of the change: the block-only codecs are no longer excluded.
	for (const compression of [50000, 34925, 34887]) {
		assert.ok(totals.codecs.has(compression),
			`compression ${compression} should be eligible for parallel decode`);
	}

	console.log(`\n🎉 Parallel decode matches the single-threaded decode on ${totals.eligible} files (${totals.tiled} tiled), codecs: ${[...totals.codecs].sort((a, b) => a - b).join(', ')}.\n`);
}

async function sweep(mod) {

	const files = fs.readdirSync(samplesDir).filter(name => /\.(tif|tiff)$/i.test(name)).sort();
	let eligible = 0;
	let tiled = 0;
	const codecs = new Set();

	for (const file of files) {
		const bytes = new Uint8Array(fs.readFileSync(path.join(samplesDir, file)));

		let plan;
		try { plan = mod.tiff_float_strip_plan(bytes); } catch { plan = null; }
		if (!plan) { continue; }

		// Ground truth: the ordinary whole-file decode.
		let reference;
		try { reference = Array.from(mod.decode_tiff(bytes).get_data_as_f32()); } catch (error) {
			// A file the plan accepts but the normal path rejects would mean the
			// two disagree about what is decodable, which is itself a bug.
			assert.fail(`${file}: plan accepted the file but decode_tiff failed: ${error}`);
		}

		const blocksPerUnit = plan.blocks_per_unit;
		const unitCount = plan.strip_count;
		const offsets = plan.offsets;
		const counts = plan.counts;
		const { width, height, channels, bits_per_sample: bits, sample_format: format } = plan;
		const isTiled = plan.tile_length > 0;
		eligible++;
		if (isTiled) { tiled++; }
		codecs.add(plan.compression);

		// Three ranges, so the split lands mid-image rather than on a boundary
		// that happens to be safe.
		const ranges = splitRanges(unitCount, 3);
		const carrier = carrierFor(bits, format);

		for (const raw of carrier ? [false, true] : [false]) {
			const total = width * height * channels;
			const assembled = raw
				? (carrier === 'u8' ? new Uint8Array(total)
					: carrier === 'u16' ? new Uint16Array(total) : new Float32Array(total))
				: new Float32Array(total);

			for (const range of ranges) {
				const firstBlock = range.first * blocksPerUnit;
				const lastBlock = range.last * blocksPerUnit;
				let blobLength = 0;
				for (let i = firstBlock; i < lastBlock; i++) { blobLength += counts[i]; }
				const blob = new Uint8Array(blobLength);
				const rangeCounts = new Uint32Array(lastBlock - firstBlock);
				let position = 0;
				for (let i = firstBlock; i < lastBlock; i++) {
					blob.set(bytes.subarray(offsets[i], offsets[i] + counts[i]), position);
					position += counts[i];
					rangeCounts[i - firstBlock] = counts[i];
				}

				const args = [
					blob, rangeCounts, range.first,
					width, height, channels, bits, plan.compression,
					plan.rows_per_strip, plan.predictor, format, plan.little_endian,
					plan.tile_width, plan.tile_length, plan.blocks_across,
					plan.lerc_additional_compression,
				];
				const part = raw
					? mod.decode_tiff_strip_range_raw(...args)
					: mod.decode_tiff_float_strip_range(...args);
				const samples = !raw ? part
					: carrier === 'u8' ? part
						: carrier === 'f32'
							? new Float32Array(part.buffer, part.byteOffset, part.byteLength / 4)
							: new Uint16Array(part.buffer, part.byteOffset, part.byteLength / 2);
				assembled.set(samples, range.first * plan.rows_per_strip * width * channels);
			}

			const label = `${file} (${isTiled ? `tiled ${plan.tile_width}x${plan.tile_length}` : 'strips'}, compression ${plan.compression}, ${raw ? 'raw bytes' : 'f32'})`;
			assert.strictEqual(assembled.length, reference.length, `${label}: sample count`);
			for (let i = 0; i < reference.length; i++) {
				if (assembled[i] !== reference[i]) {
					assert.fail(`${label}: sample ${i} is ${assembled[i]}, whole-file decode says ${reference[i]}`);
				}
			}
			console.log(`✅ ${label} matches the whole-file decode exactly`);
		}
	}

	return { eligible, tiled, codecs };
}

main().catch(error => {
	console.error('❌ Strip-parallel conformance test failed:', error);
	process.exit(1);
});
