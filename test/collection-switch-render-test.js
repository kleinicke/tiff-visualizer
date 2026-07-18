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
		console.log('⚠️  out/imagePreview not built — run `npm run compile` first. Skipping.');
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

function main() {
	console.log('🧪 Running collection-switch render regression tests...\n');
	testMessageFlowReplaysOnSameFormatTypeSwitch();
	testDeferredRenderUsesSafeCanvasContextHelper();
	console.log('\n🎉 All collection-switch render tests passed.\n');
}

main();
