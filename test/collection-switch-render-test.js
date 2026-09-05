/**
 * Regression tests for the "collection switch renders solid black" bug:
 * switching between two images in an image-collection preview (t/r keys)
 * left the newly-shown image solid black on the very first render, and only
 * an unrelated settings change (e.g. toggling normalization mode) fixed it.
 *
 * Root cause (two independent things had to both hold):
 *
 *   1. media/imagePreview.js's deferred-render completion path (the
 *      `case 'updateSettings':` handler, reached once the extension replies
 *      to a processor's initial `formatInfo` post with per-format settings)
 *      tried a WebGL2 fast-path render first. When `canRender()` returns
 *      true but the render then fails after `_ensureContext()` has already
 *      called `canvas.getContext('webgl2', ...)`, that canvas element is
 *      permanently locked to the webgl2 context type by the browser —
 *      `canvas.getContext('2d', ...)` on it returns null forever, even
 *      though a fresh canvas of the same size would work fine.
 *   2. The deferred-render CPU fallback used a raw
 *      `canvas.getContext('2d', {...})` instead of the existing
 *      `ensure2dCanvasContext()` helper (which detects exactly this and
 *      replaces the canvas element with a fresh one). Every *other* render
 *      path in the file (updateImageWithNewSettings, for every processor)
 *      already used `ensure2dCanvasContext()` — only the deferred-render
 *      completion branch was missed. So the 2D paint was silently skipped,
 *      leaving the placeholder (solid black, from `new ImageData(w, h)`)
 *      on screen, until any subsequent settings change routed through
 *      `updateImageWithNewSettings` and its `ensure2dCanvasContext()` call
 *      swapped in a working canvas.
 *
 * This file covers:
 *   - Part 1 (extension host): AppStateManager.setImageFormat() no-ops when
 *     the incoming formatType matches the current one (by design, to avoid
 *     a redundant settings push) — but FormatInfoMessageHandler must *still*
 *     unconditionally reply with an isInitialRender `updateSettings`
 *     message on every isInitialLoad formatInfo post, same-formatType or
 *     not, since that reply is what triggers the webview's deferred render
 *     at all. Verified by driving the real compiled MessageRouter +
 *     AppStateManager (out/imagePreview/*.js) through two formatInfo posts
 *     of the same 'tiff-int' formatType (12-bit then 14-bit, mirroring
 *     shapes_lzw_12bps.tif / shapes_lzw_14bps.tif in an image collection).
 *     When the standalone test modules are not emitted, the same invariant is
 *     checked directly in the TypeScript source instead of silently skipping.
 *   - Part 2 (webview source invariant): the deferred-render completion
 *     branch in media/imagePreview.js must acquire its 2D context via
 *     ensure2dCanvasContext(), not a raw canvas.getContext('2d', ...), so
 *     a canvas left webgl2-locked by a failed fast-path attempt is swapped
 *     out instead of silently never being painted.
 *
 * Run with: node test/collection-switch-render-test.js
 * (requires `npm run compile` first, for out/imagePreview/*.js — mirrors
 * test:behavior's own "npm run compile && node test/..." pattern)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

function testMessageFlowReplaysOnSameFormatTypeSwitch() {
	const appStateModulePath = path.join(__dirname, '..', 'out', 'imagePreview', 'appStateManager.js');
	const messageHandlersModulePath = path.join(__dirname, '..', 'out', 'imagePreview', 'messageHandlers.js');
	const extensionJsPath = path.join(__dirname, '..', 'out', 'extension.js');

	if (!fs.existsSync(appStateModulePath) || !fs.existsSync(messageHandlersModulePath)) {
		const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'imagePreview', 'messageHandlers.ts'), 'utf8');
		const handlerStart = source.indexOf('class FormatInfoMessageHandler');
		const handlerEnd = source.indexOf('class ReadyMessageHandler', handlerStart);
		assert.ok(handlerStart !== -1 && handlerEnd > handlerStart, 'expected FormatInfoMessageHandler source');
		const handler = source.slice(handlerStart, handlerEnd);
		assert.match(
			handler,
			/if \(message\.value && message\.value\.isInitialLoad\)[\s\S]*?postMessage\(\{[\s\S]*?type: 'updateSettings'[\s\S]*?isInitialRender: true/,
			'every initial formatInfo message must unconditionally trigger its deferred render'
		);
		console.log('✅ same-formatType collection switch keeps the unconditional initial-render reply (source invariant)');
		return;
	}

	// 'vscode' only exists inside the extension host; stub the bits
	// AppStateManager/messageHandlers touch at module scope. '../extension'
	// (required lazily, only on isInitialLoad, for the output channel) is
	// also stubbed so this test doesn't need to boot the full extension.
	const originalResolve = Module._resolveFilename;
	const originalLoad = Module._load;
	Module._resolveFilename = function (request, ...rest) {
		if (request === 'vscode') { return 'vscode-stub'; }
		return originalResolve.call(this, request, ...rest);
	};
	Module._load = function (request, parent, isMain) {
		if (request === 'vscode') {
			return {
				EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
				workspace: { onDidChangeConfiguration: () => ({ dispose() {} }) },
			};
		}
		const resolved = (() => { try { return originalResolve.call(this, request, parent); } catch { return null; } })();
		if (resolved === extensionJsPath) {
			return { getOutputChannel: () => ({ appendLine: () => {} }) };
		}
		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		delete require.cache[require.resolve(appStateModulePath)];
		delete require.cache[require.resolve(messageHandlersModulePath)];
		const { AppStateManager } = require(appStateModulePath);
		const { MessageRouter } = require(messageHandlersModulePath);

		const appStateManager = new AppStateManager();
		/** @type {any[]} */
		const sentMessages = [];
		const preview = {
			getSizeStatusBarEntry: () => ({ updateFormatInfo: () => {} }),
			getNormalizationStatusBarEntry: () => ({ updateFormatInfo: () => {} }),
			getManager: () => ({ appStateManager, settingsManager: { onDidChangeSettings: () => {} } }),
			setCurrentFormat: () => {},
			getWebview: () => ({ postMessage: (msg) => sentMessages.push(msg) }),
		};
		const router = new MessageRouter({ updateFormatInfo: () => {} }, preview);

		const post = (bitsPerSample) => router.handle({
			type: 'formatInfo',
			value: {
				width: 100, height: 100, sampleFormat: 1, bitsPerSample,
				samplesPerPixel: 3, formatType: 'tiff-int', isInitialLoad: true,
			}
		});

		// First image: shapes_lzw_12bps.tif.
		post(12);
		let updateSettingsMsgs = sentMessages.filter(m => m.type === 'updateSettings');
		assert.strictEqual(updateSettingsMsgs.length, 1, 'first formatInfo post must get exactly one updateSettings reply');
		assert.strictEqual(updateSettingsMsgs[0].isInitialRender, true, 'the reply must set isInitialRender so the webview triggers its deferred render');

		// Switch to a second image of the SAME formatType: shapes_lzw_14bps.tif.
		// AppStateManager.setImageFormat() no-ops here (currentFormat unchanged,
		// see appStateManager.ts's "Re-activating a preview of the same format"
		// guard) — the bug would be FormatInfoMessageHandler relying on that
		// no-op's change event instead of always replying itself.
		sentMessages.length = 0;
		post(14);
		updateSettingsMsgs = sentMessages.filter(m => m.type === 'updateSettings');
		assert.strictEqual(updateSettingsMsgs.length, 1,
			'a same-formatType collection switch must still get exactly one updateSettings reply ' +
			'(this is the message that triggers the webview\'s deferred render — without it the ' +
			'newly-switched-to image stays on its black placeholder)');
		assert.strictEqual(updateSettingsMsgs[0].isInitialRender, true,
			'the same-formatType reply must also set isInitialRender');

		console.log('✅ same-formatType collection switch still gets an isInitialRender updateSettings reply (extension host)');
	} finally {
		Module._resolveFilename = originalResolve;
		Module._load = originalLoad;
	}
}

function testDeferredRenderUsesSafeCanvasContextHelper() {
	const webviewSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'imagePreview.ts'), 'utf8');

	// Isolate the deferred-render completion branch inside the
	// `case 'updateSettings':` handler: the `if (deferredImageData) { if
	// (deferredCanvasAlreadyRendered) { ... } else { <fallback> } }` block
	// that runs once a processor's performDeferredRender()/updateSettings()
	// resolves after a collection switch.
	const anchor = 'if (deferredCanvasAlreadyRendered) {';
	const anchorIndex = webviewSource.indexOf(anchor);
	assert.ok(anchorIndex !== -1, 'expected to find the deferred-render completion branch in media/imagePreview.js');
	const fallbackBranch = webviewSource.slice(anchorIndex, anchorIndex + 700);

	assert.ok(
		/}\s*else\s*{[\s\S]*ensure2dCanvasContext\(\)/.test(fallbackBranch),
		'the deferred-render CPU-fallback branch must acquire its 2D context via ensure2dCanvasContext(), ' +
		'not a raw canvas.getContext(\'2d\', ...). A WebGL fast-path attempt just above this branch may have ' +
		'already called canvas.getContext(\'webgl2\', ...) via _ensureContext() and then failed — that ' +
		'permanently locks the canvas out of 2D contexts in the browser, so only ensure2dCanvasContext()\'s ' +
		'canvas-replacement fallback can still paint the real pixels instead of leaving the black placeholder visible.'
	);

	// The raw, unsafe form must not reappear inside this specific branch.
	assert.ok(
		!/}\s*else\s*{\s*const ctx = canvas\.getContext\('2d'/.test(fallbackBranch),
		'the deferred-render CPU-fallback branch must not use a raw canvas.getContext(\'2d\', ...) call'
	);

	console.log('✅ deferred-render completion branch uses ensure2dCanvasContext() (webview canvas-context safety)');
}

function testSwitchKeepsOutgoingFrameUntilReplacementIsReady() {
	const webviewSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'imagePreview.ts'), 'utf8');
	const cssSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'imagePreview.css'), 'utf8');

	assert.match(webviewSource, /function switchToNewImage[\s\S]*?beginSeamlessImageTransition\(true\)/,
		'collection switches must start an in-place visual transition');
	assert.match(webviewSource, /function navigateTiffToPage[\s\S]*?beginSeamlessImageTransition\(false\)/,
		'multi-page TIFF navigation must keep the outgoing page visible while decoding');
	assert.match(webviewSource, /_outgoingImageElement\.replaceWith\(nextImageElement\)/,
		'the completed frame must atomically replace the outgoing frame');
	assert.match(webviewSource, /function updateImageCollectionOverlay[\s\S]*?renderCollectionLoadingState\(\)/,
		'host overlay updates must preserve the collection loading state');
	assert.doesNotMatch(webviewSource, /function switchToNewImage[\s\S]*?zoomController\.scale = 'fit'/,
		'the outgoing frame zoom must not be reset while a collection replacement loads');
	assert.match(cssSource, /\.container\.image-transition-pending \.loading-indicator\s*{\s*display:\s*none;/,
		'the global loading wheel must stay hidden during an in-place transition');
	assert.match(webviewSource, /function requestCollectionNavigation[\s\S]*?toggleImageReverse/,
		'collection navigation must use a shared guarded switch request');
	assert.match(webviewSource, /bindNavigationButton\('\.collection-prev-btn', 'previous'\)/,
		'the visible previous button must be wired to collection navigation');
	assert.match(webviewSource, /bindNavigationButton\('\.collection-next-btn', 'next'\)/,
		'the visible next button must be wired to collection navigation');
	assert.match(webviewSource, /addEventListener\('pointerdown',[\s\S]*?e\.stopPropagation\(\)/,
		'collection button presses must not bubble into canvas click/zoom handling');
	assert.match(webviewSource, /window\.addEventListener\('keydown',[\s\S]*?requestCollectionNavigation\(isRightArrow \? 'next' : 'previous'\)[\s\S]*?}, true\)/,
		'physical arrow keys must be captured before focused webview controls consume them');
	assert.match(webviewSource, /collection-prev-btn[^>]*tabindex="-1"[\s\S]*collection-next-btn[^>]*tabindex="-1"/,
		'collection arrow controls must not enter the keyboard tab order');
	assert.match(webviewSource, /const logicalTiffPages = isPyramidal\(tiffProcessor\.pageDirectory\)[\s\S]*?imagePages\(tiffProcessor\.pageDirectory\)\.length[\s\S]*?logicalTiffPages > 1[\s\S]*?navigateTiffPage\(isRightArrow \? 1 : -1\)/,
		'physical arrow keys must navigate multi-page and OME-TIFF planes instead of panning');
	assert.doesNotMatch(webviewSource, /imageCollection\.totalImages > 1 \|\| tiffProcessor\.pageCount > 1/,
		'pyramid overview IFDs must not steal arrow keys from viewport scrolling');
	// Multi-page TIFF and OME-TIFF no longer have their own buttons: they are
	// ordinary controls in the one shared navigation overlay. The invariants
	// those buttons carried still apply to every control in it — stay out of
	// the Tab order, and never let a press reach the canvas zoom handlers.
	assert.match(webviewSource, /function buildNavRow[\s\S]*?input\.tabIndex = -1;/,
		'navigation sliders must not enter the keyboard tab order');
	assert.match(webviewSource, /function buildNavRow[\s\S]*?select\.tabIndex = -1;/,
		'navigation dropdowns must not enter the keyboard tab order');
	assert.match(webviewSource, /overlay\.addEventListener\('pointerdown'[\s\S]*?event\.stopPropagation\(\);/,
		'overlay presses must not bubble into canvas click/zoom handling');
	assert.match(webviewSource, /loading: loading \|\| _levelSwitchPending \|\| _tiffViewportLoadCount > 0/,
		'TIFF navigation chrome must stay visibly busy during page loads and viewport tile streams');
	assert.doesNotMatch(webviewSource, /_tiffRefinementScheduled/,
		'a zoom debounce with no active request must not display the loading dot');
	assert.match(webviewSource, /const streamBlocks = tiffProcessor\.isRemoteSource[\s\S]*?const requests = streamBlocks \? missing[\s\S]*?scene\.commitRegion\(wanted, rect, rendered\)/,
		'remote COG blocks must be committed independently as their range requests complete');
	assert.match(webviewSource, /scene\.missingBaseRects\(wanted, visibleInLevel\)[\s\S]*?scene\.commitBaseRegion\(wanted, rect, rendered\)/,
		'the lowest remote overview must also be painted progressively');
	assert.match(webviewSource, /new AbortController\(\)[\s\S]*?renderRegion\(wanted\.index, rect, requestController\.signal\)/,
		'superseded remote viewport requests must be cancellable');
	assert.doesNotMatch(webviewSource, /viewing \$\{Math\.round\(visible\.x\)/,
		'pyramid status must not regress to the dense coordinate-and-coverage sentence');
	assert.match(webviewSource, /const restoreDefaultPosition = \(\) => \{[\s\S]*?overlayPositions\.delete\(key\);[\s\S]*?overlay\.style\.removeProperty\(property\);/,
		'floating overlays must be able to return to their stylesheet-defined home position');
	assert.match(webviewSource, /overlay\.addEventListener\('dblclick'[\s\S]*?target\.closest\('input, select, button, a, textarea'\)[\s\S]*?restoreDefaultPosition\(\);/,
		'double-clicking overlay chrome must restore its default position without hijacking controls');
	assert.match(webviewSource, /function tiffControls[\s\S]*?name: 'Page'/,
		'multi-page TIFF must contribute to the shared navigation model');
	// A DICOM series is often sparse, so navigation must never name a plane the
	// series does not contain. This used to be enforced by walking the plane
	// list from a dedicated arrow handler; the arrows are now an ordinary
	// navigable control, and the same invariant is held by snapping the desired
	// coordinate onto a real plane. Assert the mechanism, not the old function.
	assert.match(webviewSource, /function snapToDatasetPlane[\s\S]*?for \(const plane of series\.planes\)[\s\S]*?return best \? \{ \.\.\.best \} : desired;/,
		'dataset navigation must resolve a desired coordinate onto a plane that exists');
	assert.match(webviewSource, /function datasetControls[\s\S]*?datasetCoordinates = snapToDatasetPlane\(/,
		'stepping a dataset axis must go through the plane snap rather than setting a raw coordinate');

	// --- Navigation-overlay regressions -----------------------------------
	// Every assertion below is a bug that shipped at least once. They are cheap
	// to keep and each one names the symptom, because the symptom is what a
	// future refactor will reintroduce.

	// The controls must survive a switch. Hiding them at the START of a load
	// blanked them for the whole decode, and for a host-message-driven overlay
	// (a DICOM manifest) they never came back.
	assert.doesNotMatch(webviewSource, /const format = resolveFormat\(resourceUri, formatHint\);\s*\n\s*hideNavOverlay\(\);/,
		'the navigation overlay must not be hidden before the incoming format is known');
	assert.match(webviewSource, /NAVIGABLE_KINDS[\s\S]{0,200}?if \(!format \|\| !NAVIGABLE_KINDS\.includes\(format\.kind\)\) \{\s*\n\s*hideNavOverlay\(\);/,
		'only a format that can never navigate may clear the overlay on load');
	assert.match(webviewSource, /function switchToNewImage[\s\S]*?releaseNavOverlay\(\);/,
		'a real switch must release overlay ownership without hiding it');
	assert.match(webviewSource, /if \(navOwner === owner \|\| navOwner === null\) \{ hideNavOverlay\(owner\); \}/,
		'an unclaimed overlay must be clearable by the incoming format');

	// Rows are reused so a drag survives the reload it triggers; their
	// listeners must therefore read the CURRENT spec, not the one they were
	// built with, or a slider moves a single step and then appears stuck.
	assert.match(webviewSource, /navRowSpecs\.get\(row\)\?\.go\(/,
		'row listeners must dispatch through the live spec, not a build-time closure');
	assert.match(webviewSource, /function renderNavOverlay[\s\S]*?navRowSpecs\.set\(row, spec\);/,
		'each render must refresh the spec stored on a reused row');

	// The container's zoom/pan handlers listen on mouse events, which are a
	// separate stream from the pointer events used for dragging.
	assert.match(webviewSource, /for \(const type of \['mousedown', 'click', 'dblclick', 'wheel'\][\s\S]{0,160}?stopPropagation\(\)/,
		'overlay mouse events must not reach the canvas zoom handlers');

	// `transform` shifts getBoundingClientRect but not `style.left`, so a
	// centred overlay jumped half its width on grab.
	assert.match(webviewSource, /const place = \(x: number, y: number\) => \{[\s\S]*?overlay\.style\.transform = 'none';/,
		'dragging must neutralize the centring transform before writing left/top');

	// A name whose length changes with the value re-sizes the reading cell and
	// drags the slider with it. That was fixed once for CZI, lost in the
	// overlay consolidation, and fixed again: names live in the control that
	// carries them (a dropdown), never after a slider.
	assert.doesNotMatch(webviewSource, /valueSuffix/,
		'nothing may be appended after a slider reading');
	assert.match(webviewSource, /value\.textContent = `\$\{Number\(input\.value\) \+ 1\} \/ \$\{spec\.size\}`;/,
		'a slider reading must be exactly "n / total"');
	// One rule for the widget, applied by every format: named values are a
	// dropdown, unnamed values are a slider.
	// ONE conversion, used by every source. A source supplies names or it does
	// not; nothing downstream knows which format it came from.
	assert.match(webviewSource, /function controlsFromSelectors[\s\S]*?labels: selector\.labels && selector\.labels\.length === selector\.size/,
		'a single conversion must decide dropdown-vs-slider from the data alone');
	assert.doesNotMatch(webviewSource, /function (planeControlsFromSelectors|datasetControls|netcdfControls|tiffControls)[\s\S]{0,900}?document\.createElement/,
		'no control source may build DOM: widgets belong to the shared renderer');

	// Clicking a plane DROPDOWN must not disable the shortcuts. A <select> was
	// classed as "typing", so merely focusing one — without choosing anything —
	// made the keydown handler bail and every navigation key stopped working.
	assert.match(webviewSource, /const isEditableEventTarget[\s\S]*?if \(target\.closest\('\.nav-overlay'\)\) \{ return false; \}/,
		'navigation controls must never count as text entry');
	// A native dropdown opens its popup on pointerDOWN and keeps it only while
	// focused, so blurring on pointerUP closed the list before it was usable.
	assert.doesNotMatch(webviewSource, /addEventListener\('pointerup'[\s\S]{0,400}?HTMLSelectElement/,
		'a dropdown must not be blurred on pointerup or its popup closes immediately');
	assert.match(cssSource, /\.dataset-overlay select:focus[\s\S]{0,200}?outline: none;/,
		'navigation controls must not show a focus ring');
	assert.match(webviewSource, /window\.addEventListener\('keydown'[\s\S]*?\}, true\);/,
		'the navigation keydown handler must run in capture, ahead of any focused control');

	console.log('✅ collection switches retain the outgoing frame, persistent loading UI, and isolated navigation controls');
}

function testNetCdfControlsUseSeamlessReloads() {
	const webviewSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'imagePreview.ts'), 'utf8');
	// NetCDF builds its controls into the one shared navigation model rather
	// than owning an overlay: the Variable dropdown first, then one control per
	// non-spatial dimension.
	assert.match(webviewSource, /function netcdfControls[\s\S]*?name: 'Variable'[\s\S]*?labels: names/,
		'NetCDF must expose the variable choice as a named dropdown control');
	assert.match(webviewSource, /function netcdfControls[\s\S]*?for \(const selector of readSelectors\(metadata\)\)/,
		'NetCDF must expose one control per non-spatial dimension');
	assert.match(webviewSource, /function reloadNetCdfSelection[\s\S]*switchToNewImage\(src, resourceUri, \{ netcdfOptions:/,
		'NetCDF selection changes must use the seamless image replacement path');
	assert.match(webviewSource, /handleScientificArray\(netcdfProcessor, uri, gen, netcdfOptions \|\| netcdfSelection\)/,
		'NetCDF variable/dimension options must reach its decoder');
	console.log('✅ NetCDF variable and dimension controls use seamless decoder reloads');
}

/**
 * Turning the scale bar off must last for the session.
 *
 * It used to live only on the webview's overlay object, which is rebuilt every
 * time a webview is created — opening another image, moving a tab, an
 * extension-host restart — so the setting silently came back on. It is a
 * preference about how the user reads images, not a property of one file.
 */
function testScaleBarIsASessionPreference() {
	const settingsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'imagePreview', 'imageSettings.ts'), 'utf8');
	const panelSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', 'measure-panel.ts'), 'utf8');
	const previewSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'imagePreview', 'imagePreview.ts'), 'utf8');
	const webviewSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'imagePreview.ts'), 'utf8');

	assert.match(webviewSource, /measureCalibration\.origin !== 'none'[\s\S]{0,500}?tiffVisualizer\.toggleScaleBar/,
		'the scale-bar toggle must be available in the viewer menu for calibrated images');
	assert.match(webviewSource, /scaleBarPosition: roiOverlay\.getScaleBarPosition\(\)/,
		'a moved scale bar must persist with the webview across image switches and reloads');
	assert.match(webviewSource, /persistedState\.scaleBarPosition[\s\S]{0,120}?roiOverlay\.setScaleBarPosition/,
		'the persisted viewport-relative scale-bar position must be restored');
	assert.doesNotMatch(panelSource, /'Show scale bar'/,
		'the scale-bar toggle must not remain buried in the measurement panel');

	assert.match(settingsSource, /toggleScaleBar\(\): boolean \{[\s\S]*?_fireSettingsChanged\(\);/,
		'the host must own the scale-bar flag and announce changes to every preview');
	assert.match(previewSource, /public toggleScaleBar\(\): void \{[\s\S]*?settingsManager\.toggleScaleBar\(\)/,
		'the command must flip the session flag, not one webview\'s local copy');
	assert.match(previewSource, /showScaleBar: this\._manager\.settingsManager\.getShowScaleBar\(\)/,
		'the flag must ride along with the settings sent to a webview');
	assert.match(webviewSource, /message\.settings\?\.showScaleBar === 'boolean'[\s\S]{0,120}?roiOverlay\.setShowScaleBar/,
		'a webview must adopt the session flag from every settings update');
	// A NEW webview is bootstrapped from `data-settings` in its HTML and never
	// receives an `updateSettings` message first, so handling only the message
	// left every freshly opened image drawing the bar again.
	assert.match(webviewSource, /typeof settingsManager\.settings\.showScaleBar === 'boolean'[\s\S]{0,120}?roiOverlay\.setShowScaleBar/,
		'a webview must adopt the session flag from its bootstrap settings too');
	assert.match(previewSource, /const extendedSettings = \{[\s\S]*?\.\.\.settings,/,
		'bootstrap settings must carry the same payload the message path sends');

	console.log('✅ scale-bar visibility is a session preference, not per-webview state');
}

function testViewModeAndAcceleratorConsistency() {
	const webviewSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'imagePreview.ts'), 'utf8');
	const settingsSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', 'settings-manager.ts'), 'utf8');
	const commandsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'imagePreview', 'commands.ts'), 'utf8');

	assert.doesNotMatch(webviewSource, /renderNormalWithWebGpu/,
		'normal image viewing must use the processor direct-render path without an offscreen WebGPU composition/canvas copy');
	assert.match(webviewSource, /if \(tiffProcessor\._pendingRenderData\)[\s\S]*?targetCanvas: canvas/,
		'initial normal rendering must target the visible canvas directly');
	assert.match(settingsSource, /gpuAccelerationChanged[\s\S]*?\[gpuAccelerationChanged, 'gpuAcceleration'\]/,
		'live GPU configuration changes must be tracked and cause a rerender');
	assert.match(webviewSource, /changes\.changedKeys\.includes\('gpuAcceleration'\)[\s\S]*?coldResetLayerCompositorBackends\(\)[\s\S]*?selectAutomaticLayerBackend/,
		'automatic Layers rendering must reselect and release its backend when GPU acceleration changes');

	const histogramStart = webviewSource.indexOf('function scheduleLayerHistogramRefresh');
	const histogramEnd = webviewSource.indexOf('/**', histogramStart + 20);
	const histogramHelper = webviewSource.slice(histogramStart, histogramEnd);
	assert.match(histogramHelper, /^function scheduleLayerHistogramRefresh[\s\S]*?if \(!histogramOverlay\.getVisibility\(\)/,
		'Layers histogram work must begin with the hidden-state guard');
	assert.ok(
		histogramHelper.indexOf('if (!histogramOverlay.getVisibility()') < histogramHelper.indexOf("document.createElement('canvas')"),
		'the hidden-state guard must run before any histogram canvas allocation'
	);
	assert.match(histogramHelper, /const maxPixels = 262_144/,
		'visible Layers histogram sampling must remain explicitly bounded');

	assert.match(commandsSource, /selectForCompare[\s\S]*?activePreview\.getCurrentImage\(\)/,
		'comparison selection must use the displayed collection/dataset image');
	assert.match(commandsSource, /compareWithSelected[\s\S]*?'vscode\.openWith'[\s\S]*?vscode\.ViewColumn\.Beside/,
		'full-feature comparison must use native VS Code side-by-side editor groups');
	assert.match(commandsSource, /getViewMode\(\) === 'layers'[\s\S]*?Add Image as Layer/,
		'collection commands must explain the Layers View restriction');

	console.log('✅ normal views render directly, Layers retain automatic GPU selection, and live histograms stay bounded');
}

function main() {
	console.log('🧪 Running collection-switch render regression tests...\n');
	testMessageFlowReplaysOnSameFormatTypeSwitch();
	testDeferredRenderUsesSafeCanvasContextHelper();
	testSwitchKeepsOutgoingFrameUntilReplacementIsReady();
	testNetCdfControlsUseSeamlessReloads();
	testScaleBarIsASessionPreference();
	testViewModeAndAcceleratorConsistency();
	console.log('\n🎉 All collection-switch render tests passed.\n');
}

main();
