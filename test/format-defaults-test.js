/**
 * Per-format default visualization settings.
 *
 * `AppStateManager` picks a starting normalization mode from the image format.
 * Getting this wrong does not throw or fail any decode — the image simply
 * renders black, white, or washed out, and the user has to fix it by hand every
 * time they open that kind of file. That makes it exactly the sort of rule
 * worth pinning down in a test rather than rediscovering from a bug report.
 *
 * The distinction being asserted is between AUTHORED PICTURES and COMPUTED
 * ARRAYS. A uint8 PNG spans 0..255 by construction, so gamma mode's
 * [0, typeMax] assumption fits it. A uint8 NumPy array might be a label map
 * holding 0..3, and a uint64 one normalized against 2^64-1 renders completely
 * black — so arrays auto-normalize to their actual data range instead.
 *
 * Run with: node test/format-defaults-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

// `appStateManager.js` is bundled with `vscode` left external, so it must be
// stubbed before the module is required. Only EventEmitter is used, and only
// for change notifications this test does not subscribe to.
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
	if (request === 'vscode') {
		return {
			EventEmitter: class {
				constructor() { this.event = () => ({ dispose() {} }); }
				fire() {}
				dispose() {}
			},
		};
	}
	return originalLoad.call(this, request, ...rest);
};

const AUTO_NORMALIZE = [
	// NumPy arrays: computed data, arbitrary range, either sample type.
	'npy-float', 'npy-uint',
	// Signed and wide-unsigned TIFFs: gamma mode's unsigned [0, typeMax]
	// assumption does not hold for either.
	'tiff-int-signed', 'tiff-int-wide', 'tiff-uint16',
	// Scientific containers: values are measurements, not display levels.
	'fits', 'dicom', 'netcdf', 'czi',
	// JPEG XR, and a FLOAT JPEG XL, carry scene-referred values that gamma
	// mode's [0, 1] would clip. Their integer siblings stay in GAMMA_MODE
	// below — the decoder reports which it produced, so the two formats do
	// not have to share one compromise.
	'jxr', 'jxl-float',
];

const GAMMA_MODE = [
	// Authored pictures whose integer samples do span the type's range.
	'png', 'jpg', 'ppm', 'tiff-int', 'tga', 'webp', 'avif', 'bmp', 'ico', 'jxl',
	// Layered creative documents are authored pictures too.
	'ora', 'kra', 'psd', 'psb', 'xcf', 'affinity',
	// Float images conventionally stored in 0..1.
	'tiff-float', 'pfm', 'hdr',
];

async function main() {
	const modulePath = path.join(__dirname, '..', 'out', 'src', 'imagePreview', 'appStateManager.js');
	if (!fs.existsSync(modulePath)) {
		console.log('⚠️  out/src/imagePreview/appStateManager.js not found — run `npm run compile` first. Skipping.');
		return;
	}
	const { AppStateManager } = require(modulePath);

	console.log('🧪 Running per-format default settings tests...\n');
	let count = 0;

	const settingsFor = (format) => {
		const manager = new AppStateManager();
		manager.setImageFormat(format);
		return manager.imageSettings;
	};

	for (const format of AUTO_NORMALIZE) {
		const { normalization } = settingsFor(format);
		assert.strictEqual(normalization.autoNormalize, true,
			`'${format}' holds computed values of arbitrary range and must auto-normalize`);
		assert.strictEqual(normalization.gammaMode, false,
			`'${format}' must not start in gamma mode: normalizing against the full type range `
			+ `renders typical data black (a uint64 array against 2^64-1 is the extreme case)`);
		count++;
	}
	console.log(`✅ ${AUTO_NORMALIZE.length} computed-array formats default to auto-normalize`);

	for (const format of GAMMA_MODE) {
		const { normalization } = settingsFor(format);
		assert.strictEqual(normalization.gammaMode, true,
			`'${format}' is an authored picture whose samples span the type range; it should start in gamma mode`);
		assert.strictEqual(normalization.autoNormalize, false,
			`'${format}' must not auto-normalize: stretching an authored image to its own min/max `
			+ `changes how it is meant to look`);
		count++;
	}
	console.log(`✅ ${GAMMA_MODE.length} authored-image formats default to gamma mode`);

	// The two modes are mutually exclusive by construction; a format in both
	// (or neither) would leave the renderer's behaviour ambiguous.
	for (const format of [...AUTO_NORMALIZE, ...GAMMA_MODE]) {
		const { normalization } = settingsFor(format);
		assert.notStrictEqual(normalization.autoNormalize, normalization.gammaMode,
			`'${format}': autoNormalize and gammaMode must not agree — exactly one applies`);
	}
	console.log('✅ every format selects exactly one of auto-normalize / gamma mode');
	count++;

	// The host chooses the initial HTML fast path before the webview reports its
	// format. Looking up another format must therefore be side-effect free and
	// must not leak the settings from the currently open document.
	const manager = new AppStateManager();
	manager.setImageFormat('png');
	manager.updateGamma(1.4, 2.2);
	const pngSettings = manager.getSettingsForFormat('png');
	const jpegSettings = manager.getSettingsForFormat('jpg');
	assert.deepStrictEqual(pngSettings.gamma, { in: 1.4, out: 2.2 },
		'the active format lookup must return its current settings');
	assert.deepStrictEqual(jpegSettings.gamma, { in: 2.2, out: 2.2 },
		'a different format lookup must return that format\'s defaults');
	assert.strictEqual(manager.currentFormat, 'png',
		'looking up initial settings for another document must not switch the active format');
	jpegSettings.gamma.in = 9;
	assert.strictEqual(manager.getSettingsForFormat('jpg').gamma.in, 2.2,
		'callers must receive a copy rather than mutate the cached/default settings');
	console.log('✅ side-effect-free per-format lookup preserves active and cached settings');
	count++;

	console.log(`\n🎉 All ${count} per-format default checks passed.\n`);
}

main().catch(error => {
	console.error('❌ Per-format defaults test failed:');
	console.error(error);
	process.exit(1);
});
