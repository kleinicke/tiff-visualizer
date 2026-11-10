const assert = require('node:assert/strict');
const fs = require('node:fs');
const { buildSync } = require('esbuild');

function load(file) {
	const result = buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false });
	const loaded = { exports: {} };
	new Function('module', 'exports', 'require', result.outputFiles[0].text)(loaded, loaded.exports, require);
	return loaded.exports;
}

const { placeScaleBar, clampScaleBarPosition, SCALE_BAR_PAD_TOP } = load('media/modules/scale-bar.ts');

const base = {
	visibleWidth: 2000,
	pixelScale: 1,
	calibration: { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'µm', origin: 'imported' },
	position: null,
	viewportWidth: 1000,
	viewportHeight: 800,
	bottomInset: 0,
};

function testRoundLengthAndAutomaticPlacement() {
	const placed = placeScaleBar(base);
	assert.equal(placed.label, '200 µm', 'a 1-2-5 length near a fifth of the width, in the calibrated unit');
	assert.equal(placed.length, 400, 'its length on screen is the physical length over the pixel size');
	assert.deepEqual([placed.x, placed.y], [16, 778], 'it sits in the lower-left corner of the viewer');
}

function testUncalibratedAndOversizedBarsAreNotDrawn() {
	assert.equal(placeScaleBar({ ...base, calibration: { ...base.calibration, origin: 'none' } }), null);
	assert.equal(placeScaleBar({ ...base, viewportWidth: 500 }), null, 'a bar wider than 60% of the viewport is dropped');
	assert.equal(placeScaleBar({ ...base, pixelScale: 0.01 }), null, 'a bar under 20 px is dropped');
}

function testAutomaticPlacementIsAnchoredToTheViewerNotTheImage() {
	assert.deepEqual(['x', 'y'].map(key => placeScaleBar({ ...base, visibleWidth: 4000, pixelScale: 0.25 })[key]), [16, 778],
		'zooming changes the bar but not where it sits');
	assert.equal(placeScaleBar({ ...base, bottomClearance: 26 }).y, 752, 'a viewer can keep room for its own readout');
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

function testChannelsPanelStopsAboveTheScaleBar() {
	const css = fs.readFileSync('media/imagePreview.css', 'utf8');
	const reserved = Number(/--scale-bar-reserved-height:\s*(\d+)px/.exec(css)?.[1]);
	const clearance = Number(/const HUD_CLEARANCE = (\d+);/.exec(fs.readFileSync('media/modules/scene/scene-viewer.ts', 'utf8'))?.[1]);
	assert.ok(reserved > 0 && clearance > 0, 'both values can be read from the source');
	const viewportHeight = 800;
	for (const bottomClearance of [0, clearance]) {
		const placed = placeScaleBar({ ...base, bottomClearance });
		const topEdge = viewportHeight - (placed.y - SCALE_BAR_PAD_TOP);
		assert.ok(reserved >= topEdge, `${reserved}px reserved must cover a bar whose top edge is ${topEdge}px from the bottom`);
	}
	assert.match(css, /\.channels-panel \{[^}]*max-height: calc\(100vh - 20px - var\(--scale-bar-reserved-height[^}]*var\(--measure-scale-bar-bottom-inset/,
		'the Channels window is capped by the reserved height and the host inset');
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
testAutomaticPlacementIsAnchoredToTheViewerNotTheImage();
testBottomInsetKeepsTheBarAboveHostChrome();
testCustomPositionIsViewportRelativeAndClamped();
testPositionsAreSanitised();
testChannelsPanelStopsAboveTheScaleBar();
testViewersShareTheModuleAndTheCommandUsesTheActiveViewer();
console.log('Shared scale bar placement and routing passed.');
