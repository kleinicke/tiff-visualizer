const assert = require('node:assert/strict');
const fs = require('node:fs');
const { buildSync } = require('esbuild');

function load(file) {
	const result = buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false });
	const loaded = { exports: {} };
	new Function('module', 'exports', 'require', result.outputFiles[0].text)(loaded, loaded.exports, require);
	return loaded.exports;
}

const { placeScaleBar, clampScaleBarPosition } = load('media/modules/scale-bar.ts');

const base = {
	visibleWidth: 2000,
	pixelScale: 1,
	calibration: { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'µm', origin: 'imported' },
	area: { left: 0, bottom: 800 },
	position: null,
	viewportWidth: 1000,
	viewportHeight: 800,
	bottomInset: 0,
};

function testRoundLengthAndAutomaticPlacement() {
	const placed = placeScaleBar(base);
	assert.equal(placed.label, '200 µm', 'a 1-2-5 length near a fifth of the width, in the calibrated unit');
	assert.equal(placed.length, 400, 'its length on screen is the physical length over the pixel size');
	assert.deepEqual([placed.x, placed.y], [16, 778], 'it sits in the lower-left corner of the image');
}

function testUncalibratedAndOversizedBarsAreNotDrawn() {
	assert.equal(placeScaleBar({ ...base, calibration: { ...base.calibration, origin: 'none' } }), null);
	assert.equal(placeScaleBar({ ...base, viewportWidth: 500 }), null, 'a bar wider than 60% of the viewport is dropped');
	assert.equal(placeScaleBar({ ...base, pixelScale: 0.01 }), null, 'a bar under 20 px is dropped');
}

function testBottomInsetKeepsTheBarAboveHostChrome() {
	assert.equal(placeScaleBar({ ...base, bottomInset: 28 }).y, 750, 'the site reserves its status bar height');
}

function testCustomPositionIsViewportRelativeAndClamped() {
	const middle = placeScaleBar({ ...base, position: { x: 0.5, y: 0.5 } });
	assert.deepEqual([middle.x, middle.y], [500, 400]);
	const corner = placeScaleBar({ ...base, position: { x: 1, y: 1 } });
	assert.deepEqual([corner.x, corner.y], [592, 792], 'the bar stays fully inside the viewport');
}

function testPositionsAreSanitised() {
	assert.equal(clampScaleBarPosition(null), null);
	assert.equal(clampScaleBarPosition({ x: Number.NaN, y: 0.5 }), null);
	assert.deepEqual(clampScaleBarPosition({ x: -1, y: 2 }), { x: 0, y: 1 });
}

function testViewersShareTheModuleAndTheCommandUsesTheActiveViewer() {
	const read = file => fs.readFileSync(file, 'utf8');
	assert.match(read('media/modules/measure/roi-overlay.ts'), /from '\.\.\/scale-bar\.js'/, 'the image viewer draws through the shared module');
	assert.match(read('media/modules/scene/scene-viewer.ts'), /from '\.\.\/scale-bar\.js'/, 'the Xenium scene draws through the shared module');
	assert.match(read('src/imagePreview/commands.ts'), /registerCommand\('tiffVisualizer\.toggleScaleBar'[\s\S]{0,300}?previewManager\.activeViewer/,
		'Toggle Scale Bar acts on whichever viewer is in front, not only on image previews');
	assert.match(read('src/extension.ts'), /registerXeniumSupport\(context, registration\.previewManager\)/, 'the Xenium viewer registers with the manager');
}

testRoundLengthAndAutomaticPlacement();
testUncalibratedAndOversizedBarsAreNotDrawn();
testBottomInsetKeepsTheBarAboveHostChrome();
testCustomPositionIsViewportRelativeAndClamped();
testPositionsAreSanitised();
testViewersShareTheModuleAndTheCommandUsesTheActiveViewer();
console.log('Shared scale bar placement and routing passed.');
