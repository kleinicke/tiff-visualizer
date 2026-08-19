'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const PERF_LINE = /\[Perf\] ([^\r\n:]+?): (?:read ([0-9.]+)ms \| )?(?:decode ([0-9.]+)ms(?: \[([^\]]*)\])? \| )?webview ([0-9.]+)ms \| total ([0-9.]+)ms/g;

function filesUnder(directory, result = []) {
	if (!fs.existsSync(directory)) return result;
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) filesUnder(file, result);
		else if (entry.isFile() && entry.name.endsWith('.log')) result.push(file);
	}
	return result;
}

function performanceLines(logRoot) {
	const matches = [];
	for (const file of filesUnder(logRoot)) {
		let text;
		try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
		for (const match of text.matchAll(PERF_LINE)) {
			matches.push({ line: match[0], format: match[1], fetchMs: Number(match[2] || 0), decodeMs: Number(match[3] || 0), engine: match[4] || '', loadMs: Number(match[5]), totalMs: Number(match[6]) });
		}
	}
	return matches;
}

async function waitForNextPerformanceLine(logRoot, previousCount, timeoutMs = 120000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const lines = performanceLines(logRoot);
		if (lines.length > previousCount) return lines[lines.length - 1];
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out waiting for TIFF Visualizer performance output under ${logRoot}`);
}

async function run() {
	const inputs = JSON.parse(process.env.TIFF_PERF_FILES || '[]');
	const logRoot = process.env.TIFF_PERF_LOG_ROOT;
	const resultFile = process.env.TIFF_PERF_RESULT;
	if (!inputs.length || !logRoot || !resultFile) throw new Error('Missing TIFF performance runner environment');

	await vscode.workspace.getConfiguration('tiffVisualizer').update('gpuAcceleration', true, vscode.ConfigurationTarget.Global);
	const results = [];
	for (const input of inputs) {
		const before = performanceLines(logRoot).length;
		const started = performance.now();
		await vscode.commands.executeCommand(
			'vscode.openWith', vscode.Uri.file(input.file), 'tiffVisualizer.previewEditor',
			{ preview: false, viewColumn: vscode.ViewColumn.One },
		);
		const perf = await waitForNextPerformanceLine(logRoot, before);
		results.push({ id: input.id, file: input.file, wallMs: performance.now() - started, ...perf });
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	}
	fs.writeFileSync(resultFile, JSON.stringify({ variant: process.env.TIFF_PERF_VARIANT, results }, null, 2));
}

module.exports = { run };
