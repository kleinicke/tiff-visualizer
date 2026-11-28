'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.join(__dirname, '..');

// Called inside a real VS Code extension host by @vscode/test-electron.
exports.run = async () => {
	const vscode = require('vscode');
	const { buildSync } = require('esbuild');
	const output = buildSync({
		entryPoints: [path.join(root, 'src/cells/cellFiles.ts')], bundle: true,
		platform: 'node', format: 'cjs', write: false, external: ['vscode'],
	}).outputFiles[0].text;
	const loaded = { exports: {} };
	new Function('module', 'exports', 'require', output)(loaded, loaded.exports, require);
	const { locate, configuredSources, answerCellRequest } = loaded.exports;
	const folder = vscode.workspace.workspaceFolders[0].uri;
	const bytes = new TextEncoder().encode('cell_id,value\n1,2\n');
	for (const run of ['a', 'b']) {
		const uri = vscode.Uri.joinPath(folder, 'runs', `output-XETG-${run}-sample1`, 'cells.csv');
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
		await vscode.workspace.fs.writeFile(uri, bytes);
	}
	const pattern = 'runs/output-XETG*{sample_name}/cells.csv';
	const selected = await locate(pattern, folder, () => 'sample1');
	assert.ok(selected, 'wildcards resolve through native workspace.fs');
	const config = vscode.workspace.getConfiguration('tiffVisualizer.cells', folder);
	await config.update('cellData', { counts: { path: pattern, parent: 'Xenium cells' } }, vscode.ConfigurationTarget.Workspace);
	const sources = await configuredSources(folder, () => 'sample1');
	const counts = sources.find(source => source.name === 'counts');
	assert.equal(counts.uri.toString(), selected.toString());
	assert.equal(counts.path, selected.fsPath);
	const messages = [];
	await answerCellRequest({
		postMessage: async message => { messages.push(message); return true; },
		asWebviewUri: uri => uri,
	}, 'native', folder, [folder], pattern, () => 'sample1');
	assert.equal(messages[0].spec.path, selected.fsPath);
	assert.equal(messages[0].spec.found, true);
	assert.equal(await locate('runs/missing*/cells.csv', folder, () => 'sample1'), undefined);
	console.log('PASS native VS Code cell settings and typed wildcard paths');
};

if (require.main === module) {
	(async () => {
		const { runTests } = require('@vscode/test-electron');
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tiff-cell-paths-'));
		const workspace = path.join(temp, 'workspace');
		fs.mkdirSync(workspace);
		// The desktop app's Electron variables must not leak into the test host.
		const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')));
		for (const key of Object.keys(inherited)) delete process.env[key];
		try {
			await runTests({
				...(process.env.CELL_FILES_VSCODE_EXECUTABLE ? { vscodeExecutablePath: process.env.CELL_FILES_VSCODE_EXECUTABLE } : {}),
				extensionDevelopmentPath: root, extensionTestsPath: __filename,
				launchArgs: [workspace, `--user-data-dir=${path.join(temp, 'profile')}`, '--disable-workspace-trust', '--skip-welcome', '--disable-extensions'],
			});
		} finally {
			Object.assign(process.env, inherited);
			fs.rmSync(temp, { recursive: true, force: true });
		}
	})().catch(error => { console.error(error); process.exitCode = 1; });
}
