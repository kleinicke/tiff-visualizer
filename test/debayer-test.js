/**
 * End-to-end tests for the Rust/WASM demosaic path (wasm/tiff-decoder/src/demosaic.rs).
 *
 * Decodes the generated Bayer test files with the real WASM TIFF decoder,
 * demosaics them with the real WASM demosaic entry point, and measures PSNR
 * against the ground-truth RGB stored alongside each mosaic. This is the
 * counterpart to the Rust unit tests: those check the kernels on synthetic
 * data, this checks the whole chain on actual files.
 *
 * Test data lives outside the repo (see BACKLOG "Testdata"); the suite skips
 * cleanly when it is absent so CI without the data directory still passes.
 * Regenerate it with:
 *   cd <testfiles>/bayer && uv run make_bayer_testdata.py
 *
 * Run with: node test/debayer-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const bayerDir = path.join(__dirname, '..', '..', 'test_data', 'testfiles', 'bayer');
const wasmJs = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.js');
const wasmBin = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.wasm');

function decode(mod, file) {
	const buffer = fs.readFileSync(path.join(bayerDir, file));
	const result = mod.decode_tiff(new Uint8Array(buffer));
	return {
		width: result.width,
		height: result.height,
		channels: result.channels,
		photometric: result.photometric_interpretation,
		data: result.get_data_as_f32(),
	};
}

function demosaic(mod, plane, width, height, opts = {}) {
	const o = {
		pattern: 'rggb', algorithm: 'malvar', offsetX: 0, offsetY: 0,
		black: 0, white: 0, autoWb: false, gainR: 1, gainG: 1, gainB: 1, ...opts,
	};
	const r = mod.demosaic(
		plane, width, height, o.pattern, o.algorithm, o.offsetX, o.offsetY,
		o.black, o.white, o.autoWb, o.gainR, o.gainG, o.gainB,
	);
	return { data: r.take_data(), channels: r.channels, gains: { r: r.gain_r, g: r.gain_g, b: r.gain_b } };
}

/** PSNR over a region, comparing `channels`-interleaved output to 3ch truth. */
function psnr(out, outCh, truth, width, height, region) {
	const { x0 = 3, y0 = 3, x1 = width - 3, y1 = height - 3 } = region || {};
	let mse = 0;
	let n = 0;
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			for (let c = 0; c < 3; c++) {
				// Truth is uint8 0..255; demosaic output is in the same units
				// because no black/white levelling was requested.
				const d = out[(y * width + x) * outCh + c] / 255 - truth[(y * width + x) * 3 + c] / 255;
				mse += d * d;
				n++;
			}
		}
	}
	mse /= n;
	return mse <= 0 ? Infinity : 10 * Math.log10(1 / mse);
}


/**
 * ImageRenderer integration: the debayer hook must actually fire inside the
 * shared render path and produce colour.
 *
 * This is deliberately separate from the WASM checks above. Those prove the
 * kernels are right; this proves they are *reached*. The first build shipped
 * working kernels that no renderer ever called, because the GPU path bypassed
 * ImageRenderer.render() -- every control looked like a no-op.
 */
async function renderIntegrationTests() {
	global.ImageData = class ImageData {
		constructor(dataOrWidth, widthOrHeight, maybeHeight) {
			if (typeof dataOrWidth === 'number') {
				this.width = dataOrWidth;
				this.height = widthOrHeight;
				this.data = new Uint8ClampedArray(this.width * this.height * 4);
			} else {
				this.data = dataOrWidth;
				this.width = widthOrHeight;
				this.height = maybeHeight;
			}
		}
	};

	const rendererPath = path.join(__dirname, '..', 'out', 'media', 'modules', 'normalization-helper.js');
	if (!fs.existsSync(rendererPath)) {
		console.log('⚠️  out/media not built — run `npm run compile:quick`. Skipping render integration.');
		return;
	}
	const { ImageRenderer } = await import(rendererPath.replace(/\\/g, '/'));
	const { DEFAULT_DEBAYER } = await import(
		path.join(__dirname, '..', 'out', 'media', 'modules', 'debayer.js').replace(/\\/g, '/'));

	const settings = {
		normalization: { min: 0, max: 255, autoNormalize: false, gammaMode: false },
		gamma: { in: 1, out: 1 },
		brightness: { offset: 0 },
	};

	// A 4x4 RGGB mosaic of a saturated red field: red sites bright, others 0.
	// Demosaiced it must read as red, not as grey.
	const w = 4, h = 4;
	const plane = new Float32Array(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (y % 2 === 0 && x % 2 === 0) { plane[y * w + x] = 255; }
		}
	}

	// Without debayer: grey (r === g === b) everywhere.
	{
		const out = ImageRenderer.render(plane, w, h, 1, true, { min: 0, max: 255 }, settings, { typeMax: 255 });
		const p = (1 * w + 1) * 4;
		assert.strictEqual(out.data[p], out.data[p + 1], 'without debayer the output must be grey');
		assert.strictEqual(out.data[p + 1], out.data[p + 2], 'without debayer the output must be grey');
	}

	// With debayer: red channel must dominate.
	{
		const debayer = { ...DEFAULT_DEBAYER, enabled: true, pattern: 'rggb', algorithm: 'bilinear', view: 'rgb' };
		const out = ImageRenderer.render(plane, w, h, 1, true, { min: 0, max: 255 },
			{ ...settings, debayer }, { typeMax: 255 });
		const p = (1 * w + 1) * 4;
		assert.ok(out.data[p] > out.data[p + 1] + 20,
			`debayer must produce red-dominant output, got rgb(${out.data[p]},${out.data[p + 1]},${out.data[p + 2]})`);
		console.log('✅ ImageRenderer applies debayer (grey mosaic renders as colour)');
	}

	// Single-channel views collapse to channels === 1 so colormaps still apply.
	{
		const debayer = { ...DEFAULT_DEBAYER, enabled: true, pattern: 'rggb', algorithm: 'bilinear', view: 'g' };
		const out = ImageRenderer.render(plane, w, h, 1, true, { min: 0, max: 255 },
			{ ...settings, debayer }, { typeMax: 255 });
		const p = (1 * w + 1) * 4;
		assert.strictEqual(out.data[p], out.data[p + 1], 'a single-channel view must render as grey');
		console.log('✅ Single-channel view renders as one channel');
	}

	// The mosaic view must leave the plane alone.
	{
		const debayer = { ...DEFAULT_DEBAYER, enabled: true, view: 'mosaic' };
		const plain = ImageRenderer.render(plane, w, h, 1, true, { min: 0, max: 255 }, settings, { typeMax: 255 });
		const raw = ImageRenderer.render(plane, w, h, 1, true, { min: 0, max: 255 },
			{ ...settings, debayer }, { typeMax: 255 });
		assert.deepStrictEqual(Array.from(raw.data), Array.from(plain.data),
			'the mosaic view must be identical to rendering with debayer off');
		console.log('✅ Raw mosaic view is untouched');
	}
}

async function main() {
	if (!fs.existsSync(wasmBin)) {
		console.log('⚠️  media/wasm/tiff-wasm.wasm not found — run `npm run build:wasm` first. Skipping.');
		return;
	}
	if (!fs.existsSync(bayerDir)) {
		console.log(`⚠️  Bayer test data not found at ${bayerDir} — skipping.`);
		return;
	}

	const mod = await import(wasmJs.replace(/\\/g, '/'));
	await mod.default({ module_or_path: fs.readFileSync(wasmBin) });

	console.log('🧪 Running debayer tests...\n');

	const truth = decode(mod, 'ground_truth_chart_rgb.tif');
	assert.strictEqual(truth.channels, 3, 'ground truth should be RGB');

	// 1. Each of the four 2x2 phases reconstructs its own ground truth. A
	//    pattern mix-up swaps colour channels and tanks PSNR, so this is the
	//    guard against off-by-one phase bugs.
	for (const pattern of ['rggb', 'bggr', 'grbg', 'gbrg']) {
		const m = decode(mod, `chart_${pattern}_8bit.tif`);
		assert.strictEqual(m.channels, 1, `${pattern} mosaic must be single-channel`);
		const out = demosaic(mod, m.data, m.width, m.height, { pattern });
		// Flat-patch quadrant only: the chart's other quadrants are deliberately
		// past Nyquist, where no linear demosaic can score well.
		const flat = psnr(out.data, out.channels, truth.data, m.width, m.height,
			{ x0: 3, y0: 3, x1: 253, y1: 253 });
		assert.ok(flat > 20, `${pattern}: flat-patch PSNR ${flat.toFixed(2)} dB too low`);
		console.log(`✅ ${pattern.toUpperCase()} reconstructs flat patches (${flat.toFixed(2)} dB)`);
	}

	// 2. Using the WRONG pattern must be clearly worse, otherwise the pattern
	//    control is not actually doing anything.
	{
		const m = decode(mod, 'chart_rggb_8bit.tif');
		const right = psnr(demosaic(mod, m.data, m.width, m.height, { pattern: 'rggb' }).data, 3,
			truth.data, m.width, m.height, { x0: 3, y0: 3, x1: 253, y1: 253 });
		const wrong = psnr(demosaic(mod, m.data, m.width, m.height, { pattern: 'bggr' }).data, 3,
			truth.data, m.width, m.height, { x0: 3, y0: 3, x1: 253, y1: 253 });
		assert.ok(right > wrong + 5, `correct pattern (${right.toFixed(2)}) must beat wrong (${wrong.toFixed(2)})`);
		console.log(`✅ Wrong pattern degrades output (${right.toFixed(2)} vs ${wrong.toFixed(2)} dB)`);
	}

	// 3. Offset is the phase control: rggb+1 in x must equal grbg exactly.
	{
		const m = decode(mod, 'chart_rggb_8bit.tif');
		const shifted = demosaic(mod, m.data, m.width, m.height, { pattern: 'rggb', offsetX: 1 });
		const named = demosaic(mod, m.data, m.width, m.height, { pattern: 'grbg' });
		assert.deepStrictEqual(Array.from(shifted.data), Array.from(named.data),
			'phase offset must be equivalent to the correspondingly named pattern');
		console.log('✅ Phase offset ≡ renamed pattern for 2×2 CFAs');
	}

	// 4. Real photograph: the number that tracks overall quality.
	{
		const gt = decode(mod, 'ground_truth_underwater_bmx_rgb.tif');
		const m = decode(mod, 'underwater_bmx_rggb_8bit.tif');
		assert.strictEqual(m.photometric, 32803, 'file should declare itself CFA');
		const malvar = demosaic(mod, m.data, m.width, m.height, { pattern: 'rggb', algorithm: 'malvar' });
		const bilinear = demosaic(mod, m.data, m.width, m.height, { pattern: 'rggb', algorithm: 'bilinear' });
		const pm = psnr(malvar.data, 3, gt.data, m.width, m.height);
		const pb = psnr(bilinear.data, 3, gt.data, m.width, m.height);
		assert.ok(pm > 35, `real photo Malvar PSNR ${pm.toFixed(2)} dB too low`);
		assert.ok(pm > pb, `Malvar (${pm.toFixed(2)}) should beat bilinear (${pb.toFixed(2)})`);
		console.log(`✅ Real photo: Malvar ${pm.toFixed(2)} dB > bilinear ${pb.toFixed(2)} dB`);
	}

	// 5. Nearest-neighbour must reproduce sampled sites exactly — that is the
	//    entire point of offering it for measurement work.
	{
		const m = decode(mod, 'chart_rggb_8bit.tif');
		const out = demosaic(mod, m.data, m.width, m.height, { pattern: 'rggb', algorithm: 'nearest' });
		const grid = [0, 1, 1, 2];
		let checked = 0;
		for (let y = 0; y < m.height; y += 7) {
			for (let x = 0; x < m.width; x += 7) {
				const c = grid[(y % 2) * 2 + (x % 2)];
				assert.strictEqual(out.data[(y * m.width + x) * 3 + c], m.data[y * m.width + x],
					`nearest must preserve the sampled site at ${x},${y}`);
				checked++;
			}
		}
		console.log(`✅ Nearest preserves all ${checked} sampled sites exactly`);
	}

	// 6. Black level: 12-bit-in-uint16 with a pedestal normalises into 0..1.
	{
		const m = decode(mod, 'chart_rggb_12in16_blacklevel256.tif');
		const out = demosaic(mod, m.data, m.width, m.height,
			{ pattern: 'rggb', black: 256, white: 4351 });
		let lo = Infinity;
		let hi = -Infinity;
		for (const v of out.data) { if (v < lo) { lo = v; } if (v > hi) { hi = v; } }
		assert.ok(lo >= -0.02 && hi <= 1.02, `levelled range ${lo.toFixed(3)}..${hi.toFixed(3)} should be ~0..1`);
		assert.ok(hi > 0.9, 'levelled data should reach near the top of the range');
		console.log(`✅ Black/white level normalises to ${lo.toFixed(3)}..${hi.toFixed(3)}`);
	}

	// 7. Auto white balance recovers the known applied gains. The generator
	//    applied R=0.50 B=0.60, so the corrective gains are R=2.00 B=1.67.
	//    Gray-world is only approximate on this non-neutral chart, hence the
	//    loose bound -- it must move decisively in the right direction.
	{
		const m = decode(mod, 'chart_rggb_8bit_unbalanced.tif');
		const out = demosaic(mod, m.data, m.width, m.height, { pattern: 'rggb', autoWb: true });
		assert.ok(out.gains.r > 1.2, `auto WB should boost red, got ${out.gains.r.toFixed(2)}`);
		assert.ok(out.gains.b > 1.2, `auto WB should boost blue, got ${out.gains.b.toFixed(2)}`);
		assert.ok(Math.abs(out.gains.g - 1) < 1e-6, 'green is the reference and must stay 1.0');
		console.log(`✅ Auto WB gains R=${out.gains.r.toFixed(2)} G=${out.gains.g.toFixed(2)} B=${out.gains.b.toFixed(2)}`);
	}

	// 8. RGB-IR yields four channels, and the IR channel is genuinely distinct
	//    from green (the generator put an IR-exclusive ring marker in it).
	{
		// The IR plane is read from its own single-channel file: this decoder
		// compacts RGB-plus-extrasample images down to 3 channels, so the 4th
		// band of the interleaved ground truth is not reachable through it.
		const gtIr = decode(mod, 'ground_truth_chart_ir.tif');
		const m = decode(mod, 'chart_rgbi_4x4_8bit.tif');
		const out = demosaic(mod, m.data, m.width, m.height, { pattern: 'rgbi_4x4', algorithm: 'bilinear' });
		assert.strictEqual(out.channels, 4, 'RGB-IR must produce 4 channels');
		assert.strictEqual(gtIr.channels, 1, 'IR ground truth should be single-channel');

		let irErr = 0;
		let irVsGreen = 0;
		let n = 0;
		for (let y = 4; y < m.height - 4; y++) {
			for (let x = 4; x < m.width - 4; x++) {
				const i = (y * m.width + x) * 4;
				const ir = out.data[i + 3] / 255;
				const g = out.data[i + 1] / 255;
				const truthIr = gtIr.data[y * m.width + x] / 255;
				irErr += (ir - truthIr) ** 2;
				irVsGreen += (ir - g) ** 2;
				n++;
			}
		}
		const irPsnr = 10 * Math.log10(1 / (irErr / n));
		assert.ok(irPsnr > 20, `IR channel PSNR ${irPsnr.toFixed(2)} dB too low`);
		assert.ok(irVsGreen / n > 0.01, 'IR channel must differ from green, not mirror it');
		console.log(`✅ RGB-IR: 4 channels, IR reconstructed at ${irPsnr.toFixed(2)} dB and distinct from G`);
	}

	// 9. Every supported pattern produces a full, finite buffer of the right
	//    shape. Cheap guard against a new pattern being added with a bad grid.
	{
		const m = decode(mod, 'chart_rggb_8bit.tif');
		const expected = {
			rggb: 3, bggr: 3, grbg: 3, gbrg: 3, rgbi_4x4: 4,
			xtrans: 3, rccb: 4, rccc: 4, rgbw: 4, quad_rggb: 3,
		};
		for (const [pattern, channels] of Object.entries(expected)) {
			const out = demosaic(mod, m.data, m.width, m.height, { pattern, algorithm: 'bilinear' });
			assert.strictEqual(out.channels, channels, `${pattern} channel count`);
			assert.strictEqual(out.data.length, m.width * m.height * channels, `${pattern} buffer size`);
			assert.ok(out.data.every(Number.isFinite), `${pattern} produced non-finite values`);
		}
		console.log(`✅ All ${Object.keys(expected).length} CFA patterns produce well-formed output`);
	}

	// 10. Every WASM entry point the load path touches must survive a CFA tag.
	//     The tiff crate rejects PhotometricInterpretation 32803 in Decoder::new,
	//     so any entry point missing the neutralization throws and the file shows
	//     nothing at all -- decode_tiff alone working is not enough.
	{
		const cfaFiles = [
			'chart_rggb_8bit_cfa_tagged.tif',
			'underwater_bmx_rggb_8bit.tif',
			'underwater_bmx_bggr_16bit_unbalanced.tif',
			'chart_rgbi_4x4_8bit.tif',
		];
		for (const file of cfaFiles) {
			const bytes = new Uint8Array(fs.readFileSync(path.join(bayerDir, file)));
			assert.strictEqual(mod.tiff_page_count(bytes), 1, `${file}: tiff_page_count must not throw`);
			const r = mod.decode_tiff(bytes);
			assert.strictEqual(r.photometric_interpretation, 32803, `${file}: CFA tag must be reported`);
			assert.ok(r.width > 0 && r.height > 0, `${file}: must decode`);
			const tags = JSON.parse(r.all_tags_json);
			assert.ok(Array.isArray(tags) && tags.length > 0,
				`${file}: metadata tags must not come back empty`);
		}
		console.log(`✅ All WASM entry points handle CFA-tagged files (${cfaFiles.length} files)`);
	}

	await renderIntegrationTests();

	console.log('\n🎉 All debayer tests passed');
}

main().catch(err => {
	console.error('❌ Debayer tests failed:', err);
	process.exit(1);
});
