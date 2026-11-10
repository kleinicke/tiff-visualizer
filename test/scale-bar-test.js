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
	assert.deepEqual([placed.x, placed.y], [16, 784], 'it sits in the lower-left corner of the viewer');
}

function testUncalibratedAndOversizedBarsAreNotDrawn() {
	assert.equal(placeScaleBar({ ...base, calibration: { ...base.calibration, origin: 'none' } }), null);
	assert.equal(placeScaleBar({ ...base, viewportWidth: 500 }), null, 'a bar wider than 60% of the viewport is dropped');
	assert.equal(placeScaleBar({ ...base, pixelScale: 0.01 }), null, 'a bar under 20 px is dropped');
}

function testAutomaticPlacementIsAnchoredToTheViewerNotTheImage() {
	assert.deepEqual(['x', 'y'].map(key => placeScaleBar({ ...base, visibleWidth: 4000, pixelScale: 0.25 })[key]), [16, 784],
		'zooming changes the bar but not where it sits');
	assert.equal(placeScaleBar({ ...base, bottomClearance: 26 }).y, 758, 'a viewer can keep room for its own readout');
}

function testBottomInsetKeepsTheBarAboveHostChrome() {
	assert.equal(placeScaleBar({ ...base, bottomInset: 28 }).y, 756, 'the site reserves its status bar height');
}

function testCustomPositionIsViewportRelativeAndClamped() {
	const middle = placeScaleBar({ ...base, position: { x: 0.5, y: 0.5 } });
	assert.deepEqual([middle.x, middle.y], [500, 400]);
	const corner = placeScaleBar({ ...base, position: { x: 1, y: 1 } });
	assert.deepEqual([corner.x, corner.y], [600, 800], 'the bar stays fully inside the viewport');
}

function testPositionsAreSanitised() {
	assert.equal(clampScaleBarPosition(null), null);
	assert.equal(clampScaleBarPosition({ x: Number.NaN, y: 0.5 }), null);
	assert.deepEqual(clampScaleBarPosition({ x: -1, y: 2 }), { x: 0, y: 1 });
}

const read = file => fs.readFileSync(file, 'utf8');
const rect = { left: 100, top: 50, width: 600, height: 400 };

function testAnchoredToImageStartsAtTheImageBottomAndStaysInTheViewer() {
	const anchored = { ...base, anchorToImage: true };
	const placed = placeScaleBar({ ...anchored, imageRect: rect });
	assert.deepEqual([placed.x, placed.y], [106, 441], 'the dark box sits flush in the lower-left corner of the image');
	assert.deepEqual([placeScaleBar({ ...base, imageRect: rect }).x, placeScaleBar({ ...base, imageRect: rect }).y], [16, 784], 'off: the viewer corner wherever the image is');
	const panned = placeScaleBar({ ...anchored, imageRect: { left: -300, top: 500, width: 1200, height: 900 } });
	assert.deepEqual([panned.x, panned.y], [6, 784], 'an image running past the viewer keeps the bar inside the viewport');
	assert.equal(placeScaleBar({ ...anchored, imageRect: rect, bottomClearance: 26 }).y, 441,
		'a viewer readout does not lift the bar off an image that ends above it');
	assert.equal(placeScaleBar({ ...anchored, imageRect: { ...rect, top: 400 }, bottomClearance: 26 }).y, 758,
		'but once the image reaches the viewer bottom the bar stays above the readout');
}

function testTheBarKeepsItsPlaceAtTheImageCornerWhateverTheZoom() {
	const gaps = size => {
		const image = { left: 300, top: 100, width: size, height: size * 0.75 };
		const placed = placeScaleBar({ ...base, visibleWidth: 2000, pixelScale: 0.25, anchorToImage: true, imageRect: image });
		return [placed.x - 6 - image.left, image.top + image.height - (placed.y + 9)];
	};
	for (const size of [800, 400, 120, 20]) {
		assert.deepEqual(gaps(size), gaps(800), 'the gap to the image corner does not depend on the zoom');
	}
}

function testAMovedImageAnchoredBarFollowsTheImage() {
	const position = { x: 0.5, y: 0.25, anchor: 'image' };
	const first = placeScaleBar({ ...base, anchorToImage: true, imageRect: rect, position });
	assert.deepEqual([first.x, first.y], [400, 150], 'a fraction of the image rectangle');
	const panned = placeScaleBar({ ...base, anchorToImage: true, imageRect: { ...rect, left: 140, top: 10 }, position });
	assert.deepEqual([panned.x, panned.y], [440, 110], 'panning carries the bar with the image');
	const zoomed = placeScaleBar({ ...base, anchorToImage: true, imageRect: { left: 0, top: 0, width: 800, height: 800 }, position: { ...position, x: 0.25 } });
	assert.deepEqual([zoomed.x, zoomed.y], [200, 200], 'zooming keeps the same point of the image under the bar');
	const viewerFrame = placeScaleBar({ ...base, anchorToImage: false, imageRect: rect, position: { x: 0.5, y: 0.25 } });
	assert.deepEqual([viewerFrame.x, viewerFrame.y], [500, 200], 'a viewer-frame position ignores the image');
}

function testAPinnedBarMayLeaveTheViewportButTheAutomaticOneNever() {
	const pinned = { ...base, anchorToImage: true, position: { x: 0.5, y: 0.5, anchor: 'image' } };
	const away = placeScaleBar({ ...pinned, imageRect: { left: -900, top: -700, width: 600, height: 400 } });
	assert.deepEqual([away.x, away.y], [-600, -500], 'panned out of view with the image');
	const automatic = placeScaleBar({ ...base, anchorToImage: true, position: null, imageRect: { left: -900, top: -700, width: 600, height: 400 } });
	assert.ok(automatic.x >= 0 && automatic.y >= 20 && automatic.y <= 800, 'the automatic bar is held inside the viewer');
	const viewerFrame = placeScaleBar({ ...base, position: { x: 1, y: 1 } });
	assert.deepEqual([viewerFrame.x, viewerFrame.y], [600, 800], 'viewer-anchored bars are still clamped');
}

function testPositionsKeepTheirFrameWhenSanitised() {
	assert.deepEqual(clampScaleBarPosition({ x: 2, y: -1, anchor: 'image' }), { x: 1, y: 0, anchor: 'image' });
	assert.deepEqual(clampScaleBarPosition({ x: 0.2, y: 0.3 }), { x: 0.2, y: 0.3 }, 'older saved positions stay viewer-relative');
}

function testSettingIsDeclaredAndReachesTheWebview() {
	const pkg = JSON.parse(read('package.json')).contributes.configuration;
	const properties = (Array.isArray(pkg) ? Object.assign({}, ...pkg.map(entry => entry.properties)) : pkg.properties);
	const setting = properties['tiffVisualizer.scaleBar.anchorToImage'];
	assert.equal(setting.type, 'boolean');
	assert.equal(setting.default, false, 'the viewer-anchored placement stays the default');
	const host = read('src/imagePreview/imagePreview.ts');
	assert.equal((host.match(/scaleBarAnchorToImage: this\.getScaleBarAnchorToImage\(\)/g) || []).length, 3, 'all three settings messages carry it');
	assert.match(host, /affectsConfiguration\('tiffVisualizer\.scaleBar\.anchorToImage'\)/, 'changing it updates open previews');
	const webview = read('media/imagePreview.ts');
	assert.equal((webview.match(/setAnchorScaleBarToImage\(settingsManager\.settings\.scaleBarAnchorToImage === true\)/g) || []).length, 2, 'bootstrap and update messages apply it');
}

function withFakeDom(run) {
	const listeners = {};
	const handleListeners = {};
	const handle = { style: {}, className: '', title: '', addEventListener: (type, fn) => { handleListeners[type] = fn; }, remove() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
	const saved = { window: global.window, document: global.document, getComputedStyle: global.getComputedStyle };
	global.window = { innerWidth: 1000, innerHeight: 800, addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener() {} };
	global.document = { createElement: () => handle, body: { appendChild() {} }, documentElement: {} };
	global.getComputedStyle = () => ({ getPropertyValue: () => '' });
	try { run({ handle, listeners, handleListeners }); } finally { Object.assign(global, saved); }
}

function testDraggingWhileAnchoredToTheImageStoresAnImagePosition() {
	withFakeDom(({ handle, listeners }) => {
		const { ScaleBarControl } = load('media/modules/scale-bar.ts');
		const events = [];
		const control = new ScaleBarControl({ onMove: () => events.push('move'), onChange: () => events.push('change') });
		const ctx = new Proxy({}, { get: () => () => {} });
		const input = { visibleWidth: 2000, pixelScale: 1, calibration: base.calibration, anchorToImage: true };
		control.draw(ctx, { ...input, imageRect: rect });
		assert.equal(control.hasCustomPosition(), false);
		handle.getBoundingClientRect = () => ({ left: 110, top: 412 });
		control.beginDrag({ button: 0, clientX: 126, clientY: 440, preventDefault() {}, stopPropagation() {} });
		listeners.mousemove({ clientX: 400, clientY: 250 });
		listeners.mouseup({});
		const saved = control.getPosition();
		assert.equal(saved.anchor, 'image', 'a bar dragged under the option is saved against the image');
		assert.ok(Math.abs(saved.x - 290 / 600) < 1e-9 && Math.abs(saved.y - 188 / 400) < 1e-9, 'as fractions of the image rectangle, not the viewport');
		assert.deepEqual(events.slice(-1), ['change']);

		control.draw(ctx, { ...input, imageRect: { ...rect, left: rect.left + 50 } });
		assert.equal(control.getPosition().x, saved.x, 'panning does not rewrite the stored position');

		control.draw(ctx, { ...input, anchorToImage: false, imageRect: rect });
		assert.equal(control.getPosition().anchor, undefined, 'turning the option off re-expresses it against the viewer');
		control.draw(ctx, { ...input, imageRect: rect });
		assert.equal(control.getPosition().anchor, 'image', 'and turning it on again goes back');
	});
}

function testWheelOverTheBarReachesTheViewer() {
	withFakeDom(({ handleListeners }) => {
		const { ScaleBarControl } = load('media/modules/scale-bar.ts');
		const wheels = [];
		new ScaleBarControl({ onMove() {}, onChange() {}, onWheel: event => wheels.push(event) });
		const event = { deltaY: 100 };
		handleListeners.wheel(event);
		assert.deepEqual(wheels, [event], 'a viewer whose wheel handler is not above the handle receives the wheel');
		assert.doesNotThrow(() => {
			new ScaleBarControl({ onMove() {}, onChange() {} });
			handleListeners.wheel(event);
		}, 'without a handler the event is left to bubble');
	});
	assert.match(read('media/modules/scene/scene-viewer.ts'), /onWheel: event => this\.onWheel\(event\)/, 'the Xenium scene zooms with the cursor over the bar');
}

function testDroppingTheBarOnTheImageCornerSnapsItBack() {
	withFakeDom(({ handle, listeners }) => {
		const { ScaleBarControl } = load('media/modules/scale-bar.ts');
		const control = new ScaleBarControl({ onMove() {}, onChange() {} });
		const ctx = new Proxy({}, { get: () => () => {} });
		const input = { visibleWidth: 2000, pixelScale: 1, calibration: base.calibration, anchorToImage: true, imageRect: rect };
		control.draw(ctx, input);
		handle.getBoundingClientRect = () => ({ left: 110, top: 412 });
		const dragTo = (x, y) => {
			control.beginDrag({ button: 0, clientX: 126, clientY: 440, preventDefault() {}, stopPropagation() {} });
			listeners.mousemove({ clientX: x, clientY: y });
			listeners.mouseup({});
		};
		dragTo(300, 300);
		assert.equal(control.hasCustomPosition(), true, 'away from the corner it stays where it is dropped');
		dragTo(130, 450);
		assert.equal(control.hasCustomPosition(), false, 'close to the image corner it snaps back to automatic placement');
		dragTo(200, 445);
		assert.equal(control.hasCustomPosition(), true, 'further than the snap distance it does not');
	});
}

function testXeniumViewerAnchorsToTheTissueImage() {
	const scene = read('media/modules/scene/scene-viewer.ts');
	assert.match(scene, /imageRect: \{ left: this\.camera\.x, top: this\.camera\.y, width: this\.scene\.width \* this\.camera\.scale, height: this\.scene\.height \* this\.camera\.scale \}/,
		'the tissue image is the scene rectangle under the camera');
	assert.match(scene, /anchorToImage: this\.anchorScaleBarToImage/);
	const viewer = read('media/xenium-viewer.ts');
	assert.equal((viewer.match(/setAnchorScaleBarToImage\(/g) || []).length, 2, 'startup and settings messages both apply it');
	assert.match(viewer, /anchorScaleBarToImage: startup\.scaleBarAnchorToImage === true/);
	const host = read('src/xenium/xeniumEditor.ts');
	assert.match(host, /scaleBarAnchorToImage: this\.getScaleBarAnchorToImage\(\)/);
	assert.match(host, /affectsConfiguration\('tiffVisualizer\.scaleBar\.anchorToImage'\)/);
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
testAnchoredToImageStartsAtTheImageBottomAndStaysInTheViewer();
testTheBarKeepsItsPlaceAtTheImageCornerWhateverTheZoom();
testAMovedImageAnchoredBarFollowsTheImage();
testAPinnedBarMayLeaveTheViewportButTheAutomaticOneNever();
testWheelOverTheBarReachesTheViewer();
testDroppingTheBarOnTheImageCornerSnapsItBack();
testPositionsKeepTheirFrameWhenSanitised();
testSettingIsDeclaredAndReachesTheWebview();
testDraggingWhileAnchoredToTheImageStoresAnImagePosition();
testXeniumViewerAnchorsToTheTissueImage();
testChannelsPanelStopsAboveTheScaleBar();
testViewersShareTheModuleAndTheCommandUsesTheActiveViewer();
console.log('Shared scale bar placement and routing passed.');
