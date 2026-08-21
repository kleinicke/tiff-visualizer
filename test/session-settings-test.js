'use strict';
/**
 * Session-scoped view preferences.
 *
 * These are the settings that describe how the USER wants to read images
 * rather than anything about a particular file: the NaN colour, the colour
 * picker mode, and the scale bar. Getting their SCOPE wrong does not throw and
 * does not fail any decode — the setting simply reverts, quietly, the next time
 * a webview happens to be rebuilt. The scale bar shipped that way: it lived on
 * the webview's overlay object, so opening another image, moving a tab, or an
 * extension-host restart silently turned it back on.
 *
 * This drives the REAL `ImageSettingsManager`, because the bug was in where the
 * state lived, and only the real class can answer that.
 *
 * Run with: node test/session-settings-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

/** Load a `vscode`-dependent source file with a minimal stub for that module. */
function loadWithVscodeStub(relativePath) {
	const file = path.join(__dirname, '..', relativePath);
	const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	}).outputText;

	// Only the pieces these classes actually touch. `EventEmitter` is recorded
	// rather than ignored: "every open preview is told" is the mechanism that
	// makes a setting session-wide, so the test has to be able to see it fire.
	const listeners = [];
	const fired = { count: 0 };
	const vscodeStub = {
		EventEmitter: class {
			constructor() {
				this.event = (listener) => { listeners.push(listener); return { dispose() {} }; };
			}
			fire(value) { fired.count++; for (const listener of listeners) { listener(value); } }
			dispose() {}
		},
		commands: { executeCommand() {} },
		Uri: { parse: (value) => ({ toString: () => value }) },
	};

	const loaded = { exports: {} };
	const requireShim = (request) => (request === 'vscode' ? vscodeStub : require(request));
	new Function('exports', 'require', 'module', '__filename', '__dirname', output)(
		loaded.exports, requireShim, loaded, file, path.dirname(file),
	);
	return { exports: loaded.exports, fired };
}

let checks = 0;
const ok = (message) => { checks++; console.log('  ✅ ' + message); };

function testScaleBarIsSessionScoped() {
	const { exports, fired } = loadWithVscodeStub('src/imagePreview/imageSettings.ts');
	const manager = new exports.ImageSettingsManager();

	// Visible by default: an unlabelled calibrated image is the case where a
	// wrong size estimate is easiest to make and hardest to notice.
	assert.strictEqual(manager.getShowScaleBar(), true, 'the scale bar starts visible');
	ok('defaults to visible');

	const before = fired.count;
	assert.strictEqual(manager.toggleScaleBar(), false, 'toggling returns the NEW state');
	assert.strictEqual(manager.getShowScaleBar(), false, 'the manager holds the new state');
	ok('toggling off is remembered by the manager, not by a webview');

	// The change event is what pushes the value to every open preview and is
	// therefore the whole reason this is session-wide rather than per-view.
	assert.strictEqual(fired.count, before + 1,
		'toggling must announce the change so every preview can adopt it');
	ok('each toggle announces itself to all previews');

	assert.strictEqual(manager.toggleScaleBar(), true, 'toggling again returns to visible');
	assert.strictEqual(manager.getShowScaleBar(), true);
	ok('toggling twice returns to the original state');

	// A fresh manager is a fresh session; nothing leaks between them.
	const second = new exports.ImageSettingsManager();
	assert.strictEqual(second.getShowScaleBar(), true, 'a new session starts from the default');
	ok('the flag is per-session, not global to the process');
}

function testSessionFlagsAreIndependent() {
	const { exports } = loadWithVscodeStub('src/imagePreview/imageSettings.ts');
	const manager = new exports.ImageSettingsManager();

	// Copy-pasted toggles that mutate the wrong field are a real hazard here —
	// these three look almost identical.
	manager.toggleScaleBar();
	assert.strictEqual(manager.getNanColor(), 'black', 'the scale bar must not disturb the NaN colour');
	assert.strictEqual(manager.getColorPickerShowModified(), false, 'nor the colour-picker mode');

	manager.toggleNanColor();
	manager.toggleColorPickerShowModified();
	assert.strictEqual(manager.getShowScaleBar(), false, 'and neither of them may disturb it');
	ok('the three session flags are independent of one another');
}

/**
 * The host may hold the right value and still lose it in transit. A webview
 * learns its settings by TWO routes — a bootstrap `data-settings` attribute
 * when it is created, and `updateSettings` messages afterwards — and the bug
 * that survived the first fix was that only the message route applied the flag.
 */
function testBothDeliveryRoutesCarryTheFlag() {
	const previewSource = fs.readFileSync(
		path.join(__dirname, '..', 'src', 'imagePreview', 'imagePreview.ts'), 'utf8');
	const webviewSource = fs.readFileSync(
		path.join(__dirname, '..', 'media', 'imagePreview.ts'), 'utf8');

	// Every settings object the host builds must carry it. Counting matters:
	// one payload that forgets it is exactly the shape of the original bug.
	const payloads = previewSource.match(/showScaleBar: this\._manager\.settingsManager\.getShowScaleBar\(\)/g) || [];
	assert.ok(payloads.length >= 3,
		`every settings payload must carry the flag (found ${payloads.length})`);
	ok(`all ${payloads.length} host settings payloads carry the flag`);

	assert.match(webviewSource, /typeof settingsManager\.settings\.showScaleBar === 'boolean'/,
		'a newly created webview must adopt the flag from its bootstrap settings');
	assert.match(webviewSource, /message\.settings\?\.showScaleBar === 'boolean'/,
		'an existing webview must adopt the flag from settings messages');
	ok('both delivery routes apply the flag');
}

function main() {
	console.log('🧪 Session-scoped view preferences\n');
	testScaleBarIsSessionScoped();
	testSessionFlagsAreIndependent();
	testBothDeliveryRoutesCarryTheFlag();
	console.log('\n' + '─'.repeat(60));
	console.log(`🎉 All ${checks} session-preference checks passed.\n`);
}

try {
	main();
} catch (error) {
	console.error('❌ Session settings test failed:');
	console.error(error);
	process.exit(1);
}
