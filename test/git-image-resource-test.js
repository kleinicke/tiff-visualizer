const assert = require('assert');
const { buildSync } = require('esbuild');
const { URI } = require('vscode-uri');

function load(entry, mocks = {}) {
	const bundle = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['vscode'] });
	const module = { exports: {} };
	new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(module, module.exports, name => mocks[name] || require(name));
	return module.exports;
}

const disposable = { dispose() {} };
const onEvent = () => disposable;
const vscode = {
	workspace: {
		workspaceFolders: [{ uri: URI.file('/repo') }],
		createFileSystemWatcher: () => ({ ...disposable, onDidChange: onEvent, onDidDelete: onEvent }),
	},
	RelativePattern: class {},
};
const { MediaPreview } = load('src/mediaPreview.ts', { vscode });
const { allExtensions, resolveFormat } = load('media/modules/format-registry.ts');

for (const ref of ['HEAD~1', 'HEAD', '', ':1', ':2', ':3']) {
	for (const extension of allExtensions()) {
		const file = URI.file(`/repo/images/a #1.${extension}`);
		const revision = file.with({ scheme: 'git', query: JSON.stringify({ path: file.fsPath, ref }) });
		const panel = { webview: {}, onDidChangeViewState: onEvent, onDidDispose: onEvent };
		const preview = new MediaPreview(URI.file('/extension'), revision, panel, { hide() {} });
		// VS Code removes the request query before checking its resource roots;
		// parent URI comparisons require identical schemes, authorities and queries.
		const request = revision.with({ query: '' });
		const permitted = panel.webview.options.localResourceRoots.some(root =>
			root.scheme === request.scheme && root.authority === request.authority &&
			root.query === request.query && request.path.startsWith(root.path + '/'));
		assert.ok(permitted, `revision must be readable: ${revision}`);
		assert.strictEqual(panel.webview.options.localResourceRoots[0].fragment, '');
		assert.strictEqual(preview.resource.toString(), revision.toString(), 'reading must retain the exact revision');
		assert.strictEqual(resolveFormat(revision.toString()).kind, resolveFormat(file.toString()).kind,
			`Git revision must use the same decoder: ${extension}`);
		preview.dispose();
	}
}
assert.strictEqual(resolveFormat('https://example.org/a.tif?token=image.png#preview').kind, 'tiff');
assert.strictEqual(resolveFormat('/repo/a?#name.png').kind, 'png', 'literal filename punctuation is preserved');
assert.strictEqual(resolveFormat('C:\\images\\a.png').kind, 'png');
const editors = require('../package.json').contributes.customEditors;
assert.strictEqual(editors.length, 1, 'all formats share one editor registration');
assert.strictEqual(editors[0].viewType, 'tiffVisualizer.previewEditor');
assert.strictEqual(editors[0].priority, 'default');
console.log('Git resource access, revision preservation, decoder routing and default registration passed.');
