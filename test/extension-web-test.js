'use strict';

// Load the shipping browser entry point in a worker-like sandbox. Deliberately
// do not inherit Node's process, Buffer, or module loader. This is a compatibility
// regression test, not a replacement for opening an image in real VS Code Web.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { build } = require('esbuild');
const { URI } = require('vscode-uri');
const config = require('../scripts/extension-web-build.cjs');
const manifest = require('../package.json');

async function main() {
	assert.equal(manifest.browser, `./${config.outfile}`);
	const result = await build({ ...config, write: false, sourcemap: false, metafile: true });
	const commands = new Map();
	const providers = new Map();
	const writes = [];
	const errors = [];
	const disposable = () => ({ dispose() {} });
	const vscode = {
		Uri: URI,
		StatusBarAlignment: { Right: 2 },
		Disposable: { from: (...items) => ({ dispose: () => items.forEach(item => item.dispose()) }) },
		EventEmitter: class { event = disposable; fire() {} dispose() {} },
		MarkdownString: class { appendMarkdown() { return this; } },
		l10n: { t: text => text },
		extensions: { getExtension() {}, onDidChange: disposable },
		commands: {
			executeCommand: async () => {},
			registerCommand(id, handler) {
				assert.ok(!commands.has(id), `duplicate command: ${id}`);
				commands.set(id, handler);
				return disposable();
			},
		},
		window: {
			createOutputChannel: () => ({ ...disposable(), appendLine() {} }),
			createStatusBarItem: () => ({ ...disposable(), show() {}, hide() {} }),
			onDidChangeActiveTextEditor: disposable,
			tabGroups: { onDidChangeTabs: disposable, onDidChangeTabGroups: disposable },
			registerCustomEditorProvider(id, provider) { providers.set(id, provider); return disposable(); },
			registerWebviewPanelSerializer: disposable,
			showQuickPick: async options => options[0],
			showSaveDialog: async () => URI.parse('vscode-vfs://test/export.png'),
			showInformationMessage() {},
			showErrorMessage: message => errors.push(message),
		},
		workspace: { fs: { writeFile: async (uri, bytes) => writes.push({ uri, bytes }) } },
	};
	const module = { exports: {} };
	const sandbox = vm.createContext({
		module, exports: module.exports, console, atob, btoa, TextEncoder, TextDecoder,
		URL, setTimeout, clearTimeout,
		require(name) {
			assert.equal(name, 'vscode', `Web extension cannot load module '${name}'`);
			return vscode;
		},
	});
	vm.runInContext(result.outputFiles[0].text, sandbox, { filename: manifest.browser });
	assert.equal(typeof module.exports.activate, 'function', 'CommonJS must export activate');
	for (const output of Object.values(result.metafile.outputs)) {
		for (const imported of output.imports) {
			if (imported.external) assert.equal(imported.path, 'vscode', 'only vscode may remain external');
		}
	}
	const context = {
		subscriptions: [], extensionUri: URI.parse('https://example.test/extension'),
		extension: { packageJSON: manifest },
	};
	await module.exports.activate(context);
	const provider = providers.get('tiffVisualizer.previewEditor');
	assert.ok(provider, 'activation registers the image editor');
	for (const { command } of manifest.contributes.commands) {
		assert.ok(commands.has(command), `activation registers ${command}`);
	}

	// Drive the real command handler: activation alone cannot catch Node globals
	// that are only accessed when a user exports a document.
	Object.defineProperty(provider, 'activePreview', { value: {
		resource: URI.parse('vscode-vfs://test/input.tif'),
		getViewMode: () => 'layers',
		getLayerExportCompatibility: async () => [{ label: 'PNG', format: 'png' }],
		exportLayerDocument: async () => ({ payload: 'AAH+/w==', warnings: [] }),
	} });
	await commands.get('tiffVisualizer.exportLayers')();
	assert.deepEqual(errors, [], 'export must not report a missing browser API');
	assert.equal(writes.length, 1);
	assert.deepEqual(Array.from(writes[0].bytes), [0, 1, 254, 255]);
	context.subscriptions.forEach(item => item.dispose());
	console.log('VS Code web bundle loading, activation, command registration and binary export passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
