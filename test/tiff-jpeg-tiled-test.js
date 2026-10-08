/**
 * Tiled JPEG-compressed YCbCr TIFF (compression 7, photometric 6) decodes in
 * Rust: the whole-image path, the strip pool's tile-row ranges and the region
 * decode all complete each tile into a JPEG stream and decode it with
 * zune-jpeg. The whole image must match libjpeg-turbo's decode of the same file
 * (the .gt.u8.bin, written by tifffile/imagecodecs) to within IDCT and chroma
 * upsampling differences, and the three Rust paths must agree exactly.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');

async function main() {
	const wasm = await import('../media/wasm/tiff-wasm.js');
	await wasm.default({ module_or_path: fs.readFileSync('media/wasm/tiff-wasm.wasm') });
	const bytes = new Uint8Array(fs.readFileSync('test-samples/jpeg_ycbcr_tiled.tif'));
	const reference = new Uint8Array(fs.readFileSync('test-samples/jpeg_ycbcr_tiled.gt.u8.bin'));

	const whole = wasm.decode_tiff_fast(bytes);
	assert.equal(whole.width, 300);
	assert.equal(whole.height, 200);
	assert.equal(whole.channels, 3);
	assert.equal(whole.photometric_interpretation, 2, 'decoded YCbCr is reported as RGB');
	const data = whole.take_data_as_u8();
	whole.free();
	assert.equal(data.length, reference.length, 'sample count');
	let maxDiff = 0, sumDiff = 0;
	for (let i = 0; i < data.length; i++) {
		const diff = Math.abs(data[i] - reference[i]);
		sumDiff += diff;
		if (diff > maxDiff) maxDiff = diff;
	}
	const meanDiff = sumDiff / data.length;
	assert.ok(maxDiff <= 8 && meanDiff <= 0.5, `differs from libjpeg: max ${maxDiff}, mean ${meanDiff.toFixed(3)}`);

	// The strip pool's path: every tile row as one range, from the plan.
	const plan = wasm.tiff_float_strip_plan(bytes);
	assert.ok(plan, 'tiled JPEG YCbCr has a strip plan');
	const offsets = plan.offsets, counts = plan.counts;
	let length = 0;
	for (let i = 0; i < counts.length; i++) length += counts[i];
	const blob = new Uint8Array(length);
	const rangeCounts = new Uint32Array(counts.length);
	for (let i = 0, at = 0; i < counts.length; i++) {
		blob.set(bytes.subarray(offsets[i], offsets[i] + counts[i]), at);
		at += counts[i];
		rangeCounts[i] = counts[i];
	}
	const ranged = wasm.decode_tiff_strip_range_raw_stats(blob, rangeCounts, 0, plan.width, plan.height, plan.channels,
		plan.bits_per_sample, plan.compression, plan.rows_per_strip, plan.predictor, plan.sample_format, plan.little_endian,
		plan.planar_configuration || 1, plan.orientation || 1, plan.tile_width || 0, plan.tile_length || 0,
		plan.blocks_across || 1, plan.lerc_additional_compression || 0, plan.photometric_interpretation || 1, 0);
	const rangedData = ranged.take_data();
	ranged.free();
	assert.ok(Buffer.from(rangedData).equals(Buffer.from(data)), 'tile-row range decode equals the whole-image decode');

	// The region path, for a rectangle crossing tile boundaries.
	if (typeof wasm.decode_tiff_region === 'function' && wasm.tiff_region_decode_available(bytes, 0)) {
		const rect = { x: 50, y: 40, width: 100, height: 90 };
		const region = wasm.decode_tiff_region(bytes, 0, rect.x, rect.y, rect.width, rect.height);
		const regionData = region.take_data_as_f32();
		region.free();
		for (let y = 0; y < rect.height; y++) {
			for (let x = 0; x < rect.width * 3; x++) {
				const expected = data[((rect.y + y) * 300 + rect.x) * 3 + x];
				if (regionData[y * rect.width * 3 + x] !== expected) {
					assert.fail(`region sample (${x}, ${y}) is ${regionData[y * rect.width * 3 + x]}, whole decode has ${expected}`);
				}
			}
		}
	}
	console.log(`Tiled JPEG YCbCr: matches libjpeg (max ${maxDiff}, mean ${meanDiff.toFixed(3)}); range and region decodes identical to the whole image`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
