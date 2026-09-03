/**
 * Region decoding must return exactly the pixels the whole-image decode
 * returns for the same rectangle — for every file in the corpus that supports
 * it, through the same WebAssembly module the viewer uses.
 *
 * That equality is the whole contract. A region decode is only worth having
 * because it lets the viewer skip work, and skipping work is only safe if the
 * result is indistinguishable; a region path that was subtly wrong would show
 * different values depending on how far you had zoomed in, which is the kind of
 * bug nobody reports because nobody believes it.
 *
 * The second thing asserted here is the point of the exercise: the number of
 * strips or tiles read follows the RECTANGLE, not the image. A one-pixel read
 * touches one block whether the page is 256 or 40000 pixels wide.
 *
 * Run with: node test/region-decode-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const samplesDir = path.join(__dirname, '..', 'test-samples');
const wasmJs = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.js');
const wasmBin = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.wasm');

/** Rectangles chosen to hit the cases block geometry gets wrong. */
function regionsFor(width, height) {
	const regions = [
		// Block-aligned, the easy case.
		{ x: 0, y: 0, width: Math.min(64, width), height: Math.min(64, height) },
		// Straddling block boundaries both ways, which is what a viewport does.
		{ x: 1, y: 1, width: Math.min(width - 1, 173), height: Math.min(height - 1, 91) },
		// A single pixel: what an exact readout costs.
		{ x: Math.floor(width / 3), y: Math.floor(height / 2), width: 1, height: 1 },
		// The bottom-right corner, where tiles are padded and strips are short.
		{ x: Math.max(0, width - 40), y: Math.max(0, height - 40), width: 40, height: 40 },
		// A full row and a full column.
		{ x: 0, y: Math.floor(height / 2), width, height: 1 },
		{ x: Math.floor(width / 2), y: 0, width: 1, height },
		// And the whole image, which must equal the ordinary decode outright.
		{ x: 0, y: 0, width, height },
	];
	return regions.filter(region =>
		region.width > 0 && region.height > 0 &&
		region.x + region.width <= width && region.y + region.height <= height);
}

async function main() {
	if (!fs.existsSync(wasmBin)) {
		console.log('⚠️  media/wasm/tiff-wasm.wasm not found — run `npm run build:wasm` first. Skipping.');
		return;
	}
	const wasm = await import(wasmJs.replace(/\\/g, '/'));
	await wasm.default({ module_or_path: fs.readFileSync(wasmBin) });

	console.log('🧪 Running TIFF region-decode conformance tests...\n');

	const files = fs.readdirSync(samplesDir)
		.filter(name => /\.tiff?$/i.test(name))
		.sort();

	let checked = 0;
	let skipped = 0;
	for (const name of files) {
		const bytes = new Uint8Array(fs.readFileSync(path.join(samplesDir, name)));
		if (!wasm.tiff_region_decode_available(bytes, 0)) { skipped++; continue; }

		// The reference: the ordinary whole-image decode, which is what every
		// other test in this repo already pins.
		let reference;
		try {
			const decoded = wasm.decode_tiff(bytes);
			reference = {
				width: decoded.width,
				height: decoded.height,
				channels: decoded.channels,
				data: decoded.get_data_as_f32(),
			};
		} catch (error) {
			// A file needing the heavy-codec module has no reference here; the
			// region path would fail the same way, so there is nothing to compare.
			skipped++;
			continue;
		}

		for (const region of regionsFor(reference.width, reference.height)) {
			let part;
			try {
				part = wasm.decode_tiff_region(bytes, 0, region.x, region.y, region.width, region.height);
			} catch (error) {
				throw new Error(`${name} region ${JSON.stringify(region)} failed: ${error?.message || error}`);
			}
			assert.strictEqual(part.width, region.width, `${name}: region width`);
			assert.strictEqual(part.height, region.height, `${name}: region height`);
			assert.strictEqual(part.channels, reference.channels, `${name}: region channel count`);

			const samples = part.take_data_as_f32();
			assert.strictEqual(samples.length, region.width * region.height * reference.channels,
				`${name}: region sample count`);

			const stride = reference.width * reference.channels;
			for (let row = 0; row < region.height; row++) {
				const fromRegion = samples.subarray(
					row * region.width * reference.channels,
					(row + 1) * region.width * reference.channels);
				const start = (region.y + row) * stride + region.x * reference.channels;
				const fromWhole = reference.data.subarray(start, start + region.width * reference.channels);
				for (let i = 0; i < fromRegion.length; i++) {
					if (!Object.is(fromRegion[i], fromWhole[i])) {
						assert.fail(`${name}: region ${JSON.stringify(region)} differs from the whole-image `
							+ `decode at row ${row}, sample ${i}: ${fromRegion[i]} !== ${fromWhole[i]}`);
					}
				}
			}
		}
		checked++;
	}

	assert.ok(checked >= 10, `expected the corpus to exercise region decoding, checked only ${checked}`);
	console.log(`✅ ${checked} files decode identically by region and as a whole (${skipped} not region-capable)`);

	// The cost follows the rectangle, not the image.
	{
		const bytes = new Uint8Array(fs.readFileSync(path.join(samplesDir, 'cog_2band_pyramid.tif')));
		const onePixel = wasm.decode_tiff_region(bytes, 0, 5, 5, 1, 1);
		const whole = wasm.decode_tiff_region(bytes, 0, 0, 0, 256, 256);
		assert.strictEqual(onePixel.blocks_decoded, 1, 'a one-pixel read touches one block');
		assert.ok(whole.blocks_decoded > onePixel.blocks_decoded,
			'the whole image reads more blocks than one pixel does');
		console.log(`✅ Blocks read follow the region: 1 for a pixel, ${whole.blocks_decoded} for the image`);
	}

	// A pyramid's overviews are pages, and a region of one must work too —
	// that is what a viewer showing a reduced level needs.
	{
		const bytes = new Uint8Array(fs.readFileSync(path.join(samplesDir, 'cog_2band_pyramid.tif')));
		assert.ok(wasm.tiff_region_decode_available(bytes, 1), 'overviews are region-capable too');
		const level = wasm.decode_tiff_page(bytes, 1);
		const reference = level.get_data_as_f32();
		const part = wasm.decode_tiff_region(bytes, 1, 10, 10, 20, 20);
		const samples = part.take_data_as_f32();
		for (let row = 0; row < 20; row++) {
			for (let i = 0; i < 20 * level.channels; i++) {
				const start = (10 + row) * level.width * level.channels + 10 * level.channels;
				assert.ok(Object.is(samples[row * 20 * level.channels + i], reference[start + i]),
					'a region of an overview matches that overview decoded whole');
			}
		}
		console.log('✅ A region of a pyramid overview matches that level decoded whole');
	}

	// Rectangles outside the image are refused rather than guessed at.
	{
		const bytes = new Uint8Array(fs.readFileSync(path.join(samplesDir, 'cog_2band_pyramid.tif')));
		assert.throws(() => wasm.decode_tiff_region(bytes, 0, 5000, 5000, 10, 10),
			/outside the image/i, 'a region past the edge is an error');
		// One that merely overhangs is clamped, not refused.
		const clamped = wasm.decode_tiff_region(bytes, 0, 250, 250, 100, 100);
		assert.strictEqual(clamped.width, 6);
		assert.strictEqual(clamped.height, 6);
		console.log('✅ Regions outside the image are refused; overhanging ones are clamped');
	}

	console.log('\n🎉 All TIFF region-decode conformance tests passed.\n');
}

main().catch(error => {
	console.error('❌ TIFF region-decode test failed:');
	console.error(error);
	process.exit(1);
});
