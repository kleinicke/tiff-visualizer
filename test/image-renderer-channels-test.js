/**
 * Regression tests for ImageRenderer support of channel counts outside
 * {1, 3, 4} (media/modules/normalization-helper.js).
 *
 * Before this fix, all six per-pixel render loops in ImageRenderer
 * (_renderFloatDirect, _renderFloatWithLUT, _renderUint16Direct,
 * _renderUint16WithLUT, _renderUint8Direct, _renderUint8WithLUT) only had
 * branches for channels === 1 / 3 / 4; anything else fell through to the
 * r=g=b=0 initializers and rendered opaque black.
 *
 *   - channels === 2 is gray+alpha (e.g. house.tif): value = data[i*2],
 *     alpha = data[i*2+1]. Expect gray levels with the alpha channel applied.
 *   - channels > 4 (e.g. shapes_hyper.tif, SamplesPerPixel=7): the first 3
 *     samples are used as RGB with stride `channels`; extra samples are
 *     display-ignored (opaque alpha) but remain in `data` for pixel
 *     inspection.
 *
 * Run with: node test/image-renderer-channels-test.js
 */

const assert = require('assert');
const path = require('path');

// Minimal ImageData polyfill for ImageRenderer's CPU paths (same shim used by
// test/tiff-sample-format-test.js).
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

const gammaOffSettings = {
	normalization: { min: 0, max: 255, autoNormalize: false, gammaMode: false },
	gamma: { in: 1.0, out: 1.0 },
	brightness: { offset: 0 },
};

// For float data (typeMax=1.0) manual-range settings must match that scale,
// not the uint8 0-255 range above.
const gammaOffFloatSettings = {
	normalization: { min: 0, max: 1, autoNormalize: false, gammaMode: false },
	gamma: { in: 1.0, out: 1.0 },
	brightness: { offset: 0 },
};

const gammaOnNonIdentitySettings = {
	normalization: { autoNormalize: false, gammaMode: true },
	gamma: { in: 1.0, out: 2.2 }, // non-identity -> exercises the *WithLUT paths
	brightness: { offset: 0 },
};

function pixelAt(imageData, x, y) {
	const p = (y * imageData.width + x) * 4;
	return {
		r: imageData.data[p],
		g: imageData.data[p + 1],
		b: imageData.data[p + 2],
		a: imageData.data[p + 3],
	};
}

async function main() {
	console.log('🧪 Running ImageRenderer channel-count tests...\n');

	const { ImageRenderer } = await import(
		path.join('..', 'out', 'media', 'modules', 'normalization-helper.js').replace(/\\/g, '/')
	);

	// ---------------------------------------------------------------------
	// 1. Synthetic 2-channel (gray+alpha) uint8 data, gamma off (direct path).
	// ---------------------------------------------------------------------
	{
		const width = 2, height = 1;
		// pixel 0: gray=100, alpha=200 ; pixel 1: gray=50, alpha=255
		const data = new Uint8Array([100, 200, 50, 255]);
		const result = ImageRenderer.render(data, width, height, 2, false, { min: 0, max: 255 }, gammaOffSettings, {});
		assert.strictEqual(result.width, width);
		assert.strictEqual(result.height, height);

		const p0 = pixelAt(result, 0, 0);
		assert.deepStrictEqual(p0, { r: 100, g: 100, b: 100, a: 200 },
			'2-channel uint8 direct: gray replicated to RGB, alpha applied from channel 1');
		const p1 = pixelAt(result, 1, 0);
		assert.deepStrictEqual(p1, { r: 50, g: 50, b: 50, a: 255 });
		assert.ok(p0.r !== 0 || p0.g !== 0 || p0.b !== 0, 'must not render opaque black (the pre-fix fallback)');
		console.log('✅ 2-channel (gray+alpha) uint8 direct render: correct gray levels with alpha applied');
	}

	// ---------------------------------------------------------------------
	// 2. Synthetic 2-channel uint8 data, gamma on with non-identity transform
	//    (LUT path) — must still not be black, and alpha must not go through
	//    the gamma LUT (it's a straight passthrough, like the channels===4 path).
	// ---------------------------------------------------------------------
	{
		const width = 1, height = 1;
		const data = new Uint8Array([128, 128]);
		const result = ImageRenderer.render(data, width, height, 2, false, null, gammaOnNonIdentitySettings, {});
		const p0 = pixelAt(result, 0, 0);
		assert.ok(p0.r > 0 && p0.r === p0.g && p0.g === p0.b, '2-channel uint8 LUT render must not be black');
		assert.strictEqual(p0.a, 128, 'alpha channel is a straight passthrough, not gamma-corrected');
		console.log('✅ 2-channel (gray+alpha) uint8 gamma/LUT render: correct gray levels with alpha applied');
	}

	// ---------------------------------------------------------------------
	// 3. Synthetic 2-channel float32 data (typeMax=1.0), gamma off.
	// ---------------------------------------------------------------------
	{
		const width = 2, height = 1;
		const data = new Float32Array([1.0, 0.5, NaN, 1.0]);
		const result = ImageRenderer.render(data, width, height, 2, true, { min: 0, max: 1 }, gammaOffFloatSettings, {
			typeMax: 1.0,
			nanColor: { r: 255, g: 0, b: 255 },
		});
		const p0 = pixelAt(result, 0, 0);
		assert.deepStrictEqual(p0, { r: 255, g: 255, b: 255, a: 128 },
			'2-channel float direct: gray=1.0 -> 255, alpha=0.5 -> 128');
		const p1 = pixelAt(result, 1, 0);
		assert.deepStrictEqual(p1, { r: 255, g: 0, b: 255, a: 255 },
			'2-channel float direct: NaN gray -> nanColor, opaque');
		console.log('✅ 2-channel (gray+alpha) float32 direct render: gray+alpha correct, NaN -> nanColor');
	}

	// ---------------------------------------------------------------------
	// 4. Synthetic 7-channel float32 data (shapes_hyper.tif shape), gamma off.
	//    First 3 samples used as RGB with stride 7; extra 4 are display-ignored.
	// ---------------------------------------------------------------------
	{
		const width = 2, height = 1;
		const channels = 7;
		// pixel 0: R=1.0 G=0.5 B=0.0, extras 0.1/0.2/0.3/0.5
		// pixel 1: R=0.25 G=0.75 B=1.0, extras 0.1/0.2/0.3/0.5
		const data = new Float32Array([
			1.0, 0.5, 0.0, 0.1, 0.2, 0.3, 0.5,
			0.25, 0.75, 1.0, 0.1, 0.2, 0.3, 0.5,
		]);
		assert.strictEqual(data.length, width * height * channels, 'sanity: synthetic buffer matches width*height*channels');
		const result = ImageRenderer.render(data, width, height, channels, true, { min: 0, max: 1 }, gammaOffFloatSettings, {
			typeMax: 1.0,
			nanColor: { r: 255, g: 0, b: 255 },
		});
		const p0 = pixelAt(result, 0, 0);
		assert.deepStrictEqual(p0, { r: 255, g: 128, b: 0, a: 255 },
			'7-channel float direct: first 3 samples as RGB (stride 7), opaque alpha');
		const p1 = pixelAt(result, 1, 0);
		assert.deepStrictEqual(p1, { r: 64, g: 191, b: 255, a: 255 });
		assert.ok(p0.r !== 0 || p0.g !== 0 || p0.b !== 0, 'must not render opaque black (the pre-fix fallback)');
		console.log('✅ 7-channel (RGB + 4 extra) float32 direct render: first 3 as RGB, opaque, not black');
	}

	// ---------------------------------------------------------------------
	// 5. Synthetic 7-channel float32 data, gamma on non-identity (LUT path).
	// ---------------------------------------------------------------------
	{
		const width = 1, height = 1;
		const data = new Float32Array([1.0, 1.0, 1.0, 0.1, 0.2, 0.3, 0.5]);
		const result = ImageRenderer.render(data, width, height, 7, true, null, gammaOnNonIdentitySettings, { typeMax: 1.0 });
		const p0 = pixelAt(result, 0, 0);
		assert.deepStrictEqual(p0, { r: 255, g: 255, b: 255, a: 255 },
			'7-channel float LUT render: full-scale RGB -> white, opaque');
		console.log('✅ 7-channel (RGB + 4 extra) float32 gamma/LUT render: correct, not black');
	}

	// ---------------------------------------------------------------------
	// 6. calculateFloatStats / calculateIntegerStats must scan only the gray
	//    channel for channels === 2 (not alpha), so a wildly different alpha
	//    range can't skew the normalization range computed from gray values.
	// ---------------------------------------------------------------------
	{
		const { ImageStatsCalculator } = await import(
			path.join('..', 'out', 'media', 'modules', 'normalization-helper.js').replace(/\\/g, '/')
		);
		const floatData = new Float32Array([0.2, 0.9, 0.4, 0.9]); // gray: 0.2, 0.4 ; alpha: 0.9, 0.9
		const floatStats = ImageStatsCalculator.calculateFloatStats(floatData, 2, 1, 2);
		const closeEnough = (a, b) => Math.abs(a - b) < 1e-6;
		assert.ok(closeEnough(floatStats.min, 0.2), 'float stats for channels=2 must scan only the gray channel (min)');
		assert.ok(closeEnough(floatStats.max, 0.4), 'float stats for channels=2 must scan only the gray channel (max), excluding alpha=0.9');

		const intData = new Uint8Array([10, 250, 20, 250]); // gray: 10, 20 ; alpha: 250, 250
		const intStats = ImageStatsCalculator.calculateIntegerStats(intData, 2, 1, 2);
		assert.strictEqual(intStats.min, 10, 'integer stats for channels=2 must scan only the gray channel (min)');
		assert.strictEqual(intStats.max, 20, 'integer stats for channels=2 must scan only the gray channel (max), excluding alpha=250');
		console.log('✅ calculateFloatStats/calculateIntegerStats scan only the gray channel for channels=2 (alpha excluded)');
	}

	console.log('\n🎉 All ImageRenderer channel-count tests passed.\n');
}

main().catch(err => {
	console.error('❌ ImageRenderer channel-count test failed:');
	console.error(err);
	process.exit(1);
});
