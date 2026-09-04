/**
 * Regression test for the numeric domain of a ScientificArrayProcessor's FIRST
 * render (media/modules/scientific-array-processor.ts).
 *
 * These formats always hand their samples over in a Float32Array, so nothing
 * downstream can infer the type range from the carrier: `_toImageDataFloat`
 * falls back to [0, 1], the float default. `renderWithSettings` always stated
 * the decoded domain, but the INITIAL render is deferred until the extension
 * has applied the per-format defaults, and that path inherited
 * PfmProcessor.performDeferredRender, which passed the caller's options
 * through untouched.
 *
 * The result was visible on exactly one format: an integer JPEG XL is the only
 * member that opens in gamma mode, whose range IS the type range, so a uint16
 * image was normalized against [0, 1] and rendered white above a value of 1.
 * Every other member opens in auto-normalize and took its range from the data
 * statistics, which hid the same omission.
 *
 * Run with: node test/scientific-deferred-render-test.js
 */

const assert = require('assert');
const path = require('path');

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

const UINT16_DOMAIN = {
	bitsPerSample: 16,
	sampleFormat: 1,
	typeMin: 0,
	typeMax: 65535,
	sourceNumericType: 'uint16',
};

// The per-format default an integer .jxl receives from AppStateManager:
// gamma mode, and gamma in === gamma out so the transform is identity.
const gammaModeSettings = {
	normalization: { min: 0, max: 1, autoNormalize: false, gammaMode: true },
	gamma: { in: 2.2, out: 2.2 },
	brightness: { offset: 0 },
	nanColor: 'black',
};

function makeProcessor(ScientificArrayProcessor, settings) {
	const processor = new ScientificArrayProcessor(
		{ settings, updateSettings() { } },
		{ postMessage() { } },
		{ workerFormat: 'jxl', formatLabel: 'JPEG XL', formatType: 'jxl', parse: () => { throw new Error('unused'); } },
	);
	processor.numericDomain = UINT16_DOMAIN;
	return processor;
}

/** Grey level the renderer produced for pixel `index`. */
function grey(imageData, index) {
	return imageData.data[index * 4];
}

async function main() {
	console.log('🧪 Running scientific deferred-render domain tests...\n');

	const { ScientificArrayProcessor } = await import(
		path.join('..', 'out', 'media', 'modules', 'scientific-array-processor.js').replace(/\\/g, '/')
	);

	// One row spanning the uint16 range, including the value from the bug
	// report: 240 out of 65535 is nearly black, but white against [0, 1].
	const data = Float32Array.from([0, 240, 32768, 65535]);
	const pending = { displayData: data, width: 4, height: 1, channels: 1 };

	// 1. The deferred (initial) render must use the decoded uint16 domain.
	{
		const processor = makeProcessor(ScientificArrayProcessor, gammaModeSettings);
		processor._pendingRenderData = { ...pending };
		const imageData = processor.performDeferredRender();

		assert.ok(imageData, 'deferred render returned image data');
		assert.strictEqual(grey(imageData, 0), 0, '0 renders black');
		assert.ok(grey(imageData, 1) <= 2,
			`240/65535 must render near black, got ${grey(imageData, 1)}`);
		assert.ok(grey(imageData, 2) > 100 && grey(imageData, 2) < 160,
			`32768/65535 must render mid grey, got ${grey(imageData, 2)}`);
		assert.strictEqual(grey(imageData, 3), 255, '65535 renders white');
		console.log('✅ initial deferred render normalizes against typeMax, not [0, 1]');
	}

	// 2. It must agree with the re-render path, which was always correct. A
	//    mismatch is what the user saw: white on open, correct after any
	//    settings change.
	{
		const deferredProcessor = makeProcessor(ScientificArrayProcessor, gammaModeSettings);
		deferredProcessor._pendingRenderData = { ...pending };
		const deferred = deferredProcessor.performDeferredRender();

		const rerenderProcessor = makeProcessor(ScientificArrayProcessor, gammaModeSettings);
		rerenderProcessor._lastRaw = { width: 4, height: 1, data, channels: 1 };
		const rerendered = rerenderProcessor.renderWithSettings();

		assert.deepStrictEqual(Array.from(deferred.data), Array.from(rerendered.data),
			'the first render and a later re-render must produce identical pixels');
		console.log('✅ first render matches a subsequent re-render');
	}

	// 3. The caller's own options survive the injection.
	{
		const processor = makeProcessor(ScientificArrayProcessor, gammaModeSettings);
		processor._pendingRenderData = { ...pending };
		processor.performDeferredRender({ collectHistogram: true });
		assert.ok(processor._lastRenderHistogram,
			'collectHistogram passed by the caller still reaches the renderer');
		console.log('✅ caller options are preserved alongside the numeric domain');
	}

	console.log('\n🎉 All scientific deferred-render domain tests passed');
}

main().catch(error => {
	console.error('❌', error);
	process.exit(1);
});
