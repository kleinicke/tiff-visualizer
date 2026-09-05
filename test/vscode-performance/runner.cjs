'use strict';

/**
 * Opens each requested file in a real VS Code window and records what the
 * extension itself reported for the load.
 *
 * The measurement principle: this scrapes the extension's OWN Output-channel
 * log rather than instrumenting the webview from the outside. The number that
 * lands in the results is therefore the number a user sees in the Output panel,
 * not a parallel measurement that could drift from it.
 *
 * Driven by scripts/benchmark-vscode.mjs (one build) and
 * scripts/benchmark-vscode-head-to-head.mjs (two builds).
 */

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

// Phases are optional: a format that emits no read/decode marks still matches.
const PERF_LINE = /\[Perf\] ([^\r\n:]+?): (?:read ([0-9.]+)ms \| )?(?:decode ([0-9.]+)ms(?: \[([^\]]*)\])? \| )?[^\r\n]*?webview ([0-9.]+)ms \| total ([0-9.]+)ms(?: \| visible ([0-9.]+)ms)?/g;
// Only emitted when DETAILED_PERF_TRACING is on in media/modules/perf-trace.ts.
const TRACE_LINE = /\[PerfTrace\] ([^\r\n]+)/g;

function filesUnder(directory, result = []) {
	if (!fs.existsSync(directory)) return result;
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) filesUnder(file, result);
		else if (entry.isFile() && entry.name.endsWith('.log')) result.push(file);
	}
	return result;
}

function scrape(logRoot) {
	const perf = [];
	const trace = [];
	const refine = [];
	for (const file of filesUnder(logRoot)) {
		let text;
		try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
		for (const m of text.matchAll(PERF_LINE)) {
			perf.push({
				line: m[0],
				format: m[1],
				fetchMs: Number(m[2] || 0),
				decodeMs: Number(m[3] || 0),
				engine: m[4] || '',
				loadMs: Number(m[5]),
				totalMs: Number(m[6]),
				visibleMs: Number(m[7] || 0),
			});
		}
		for (const m of text.matchAll(/\[Refine\] first commit (\d+)ms \| visible (\d+)ms \| (\d+) regions/g)) refine.push({ firstCommitMs: +m[1], visibleMs: +m[2], regions: +m[3] });
		for (const m of text.matchAll(TRACE_LINE)) trace.push(m[1]);
	}
	return { perf, trace, refine };
}

async function waitForNextPerformanceLine(logRoot, previousCount, timeoutMs = 120000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const current = scrape(logRoot);
		if (current.perf.length > previousCount) return current;
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out waiting for TIFF Visualizer performance output under ${logRoot}`);
}

async function run() {
	const inputs = JSON.parse(process.env.TIFF_PERF_FILES || '[]');
	const logRoot = process.env.TIFF_PERF_LOG_ROOT;
	const resultFile = process.env.TIFF_PERF_RESULT;
	if (!inputs.length || !logRoot || !resultFile) throw new Error('Missing TIFF performance runner environment');
	const timeoutMs = Number(process.env.TIFF_PERF_TIMEOUT_MS || 120000);

	await vscode.workspace.getConfiguration('tiffVisualizer').update('gpuAcceleration', true, vscode.ConfigurationTarget.Global);

	const results = [];
	for (const input of inputs) {
		const before = scrape(logRoot);
		const started = performance.now();
		await vscode.commands.executeCommand(
			'vscode.openWith', vscode.Uri.file(input.file), 'tiffVisualizer.previewEditor',
			{ preview: false, viewColumn: vscode.ViewColumn.One },
		);
		let perf;
		let trace = '';
		try {
			const after = await waitForNextPerformanceLine(logRoot, before.perf.length, timeoutMs);
			perf = after.perf[after.perf.length - 1];
			// The last trace line belongs to this load; only present in detailed mode.
			if (after.trace.length > before.trace.length) trace = after.trace[after.trace.length - 1];
		} catch {
			// A file that never reports must not abort the whole run: record it
			// as a miss so the rest of the corpus still produces numbers.
			perf = { line: '', format: 'NO-PERF-LINE', fetchMs: 0, decodeMs: 0, engine: '', loadMs: 0, totalMs: 0, visibleMs: 0 };
		}
		let refinement;
		if (process.env.TIFF_PERF_REFINE === '1' && perf.line) {
			const count = scrape(logRoot).refine.length;
			for (let step = 0; step < Number(process.env.TIFF_PERF_REFINE_STEPS || 6); step++) await vscode.commands.executeCommand('tiffVisualizer.zoomIn');
			const deadline = Date.now() + 30000;
			while (Date.now() < deadline) {
				const entries = scrape(logRoot).refine;
				if (entries.length > count) { refinement = entries.at(-1); break; }
				await new Promise(resolve => setTimeout(resolve, 50));
			}
			console.log('REFINEMENT', JSON.stringify(refinement || 'timeout'));
		}
		results.push({ refinement, id: input.id, file: input.file, wallMs: performance.now() - started, ...perf, trace });
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		// Let the closed editor release its webview before the next open.
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	fs.writeFileSync(resultFile, JSON.stringify({ variant: process.env.TIFF_PERF_VARIANT, results }, null, 2));
}

module.exports = { run };
