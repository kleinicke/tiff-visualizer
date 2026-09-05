#!/usr/bin/env node
/**
 * Measure image load time for the CURRENT working tree in a real VS Code window.
 *
 * The sibling script benchmark-vscode-head-to-head.mjs answers "is this commit
 * faster than a baseline commit". This one answers "where does the time go right
 * now", which is what you want while iterating: it runs one build, over a whole
 * corpus, and reports the per-phase breakdown the extension itself logged.
 *
 *   node scripts/benchmark-vscode.mjs                     # whole corpus
 *   ONLY=nl_01_depth.tif node scripts/benchmark-vscode.mjs
 *   ITER=5 node scripts/benchmark-vscode.mjs              # more samples
 *   BENCH_DIR=/path/to/files node scripts/benchmark-vscode.mjs
 *
 * READING THE OUTPUT — cold and warm are reported separately. The cold column
 * is iteration 1; warm columns are medians of iterations 2..N. For a true cold
 * measurement, run one file per fresh VS Code session with ONLY=... . Cold
 * opens pay costs that never recur in a session (WASM compile/instantiation,
 * worker boot, and per-format/per-size GPU validation), so never mix the first
 * open into the warm median.
 *
 * Set DETAILED_PERF_TRACING = true in media/modules/perf-trace.ts and rebuild to
 * capture the full per-phase trace as well; it is surfaced in `trace`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const benchDir = process.env.BENCH_DIR
	|| path.join(process.env.TIFF_TEST_DATA || '/Users/florian/Projects/cursor/test_data', 'benchmark');
const iterations = Math.max(1, Number(process.env.ITER || 3));
const only = String(process.env.ONLY || '').split(',').map(v => v.trim()).filter(Boolean);

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length ? sorted[sorted.length >> 1] : 0;
}

async function main() {
	if (!fs.existsSync(benchDir)) {
		throw new Error(`No corpus at ${benchDir} — run: node scripts/benchmark-corpus.mjs`);
	}
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiff-vscode-perf-'));
	const stage = path.join(tempRoot, 'files');
	fs.mkdirSync(stage, { recursive: true });

	const listFiles = (dir, relative = '') => fs.readdirSync(dir).flatMap(name => {
		if (!relative && (name.startsWith('.') || /\.(json|md)$/.test(name))) { return []; }
		const full = path.join(dir, name);
		const nested = relative ? path.join(relative, name) : name;
		return fs.statSync(full).isDirectory() ? listFiles(full, nested) : [nested];
	});
	let names = listFiles(benchDir);
	if (only.length) names = names.filter(n => only.some(o => n.includes(o)));
	if (!names.length) throw new Error(`ONLY matched nothing in ${benchDir}`);

	// The corpus is symlinks; resolve and hardlink so VS Code opens real files
	// from one workspace folder without copying gigabytes.
	const base = names.map(name => {
		const real = fs.realpathSync(path.join(benchDir, name));
		const dst = path.join(stage, name);
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		try { fs.linkSync(real, dst); } catch { fs.copyFileSync(real, dst); }
		return { id: name, file: dst, bytes: fs.statSync(real).size };
	}).sort((a, b) => a.id.localeCompare(b.id));

	const totalMb = base.reduce((n, f) => n + f.bytes, 0) / 1048576;
	console.log(`${base.length} file(s), ${totalMb.toFixed(0)} MB, ${iterations} iteration(s)`);

	// Rotate the order each iteration so warm-up never favours the same sample.
	const inputs = [];
	for (let i = 0; i < iterations; i++) {
		const offset = i % base.length;
		inputs.push(...base.slice(offset), ...base.slice(0, offset));
	}

	const userData = path.join(tempRoot, 'user');
	const resultFile = path.join(tempRoot, 'result.json');
	fs.mkdirSync(userData, { recursive: true });
	Object.assign(process.env, {
		TIFF_PERF_FILES: JSON.stringify(inputs),
		TIFF_PERF_LOG_ROOT: userData,
		TIFF_PERF_RESULT: resultFile,
		TIFF_PERF_VARIANT: 'current',
	});
	// From VS Code's integrated terminal these describe the PARENT extension
	// host; ELECTRON_RUN_AS_NODE in particular makes the downloaded Code binary
	// treat the workspace path as a Node script.
	const parentVsCode = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('VSCODE_')),
	);
	for (const key of Object.keys(parentVsCode)) delete process.env[key];

	let executable = await downloadAndUnzipVSCode();
	if (!fs.existsSync(executable)) {
		// @vscode/test-electron expects an `Electron` binary; current VS Code
		// builds ship it as `Code`.
		const alternative = path.join(path.dirname(executable), 'Code');
		if (!fs.existsSync(alternative)) throw new Error(`No VS Code binary at ${executable}`);
		executable = alternative;
	}

	try {
		await runTests({
			vscodeExecutablePath: executable,
			extensionDevelopmentPath: root,
			extensionTestsPath: path.join(root, 'test/vscode-performance/runner.cjs'),
			launchArgs: [stage, `--user-data-dir=${userData}`, '--disable-workspace-trust', '--skip-welcome'],
		});
	} finally {
		Object.assign(process.env, parentVsCode);
	}

	const { results } = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
	const grouped = new Map();
	for (const row of results) {
		if (!grouped.has(row.id)) grouped.set(row.id, []);
		grouped.get(row.id).push(row);
	}

	const pad = (v, n) => String(v).padStart(n);
	console.log('\n' + 'file'.padEnd(34) + pad('MB', 8) + pad('read', 7) + pad('decode', 8)
		+ pad('cold', 8) + pad('warm', 8) + pad('cold vis', 10) + pad('warm vis', 10) + '  engine');
	const rows = [];
	for (const [id, runs] of grouped) {
		// Keep the cold first open separate; warm aggregates exclude it.
		const warm = runs.length > 1 ? runs.slice(1) : runs;
		const bytes = base.find(f => f.id === id)?.bytes || 0;
		const row = {
			id,
			mb: bytes / 1048576,
			read: median(warm.map(r => r.fetchMs)),
			decode: median(warm.map(r => r.decodeMs)),
			total: median(warm.map(r => r.totalMs)),
			visible: median(warm.map(r => r.visibleMs || 0)),
			engine: warm[0].engine || '-',
			samples: warm.length,
			refinement: process.env.TIFF_PERF_REFINE === '1' ? {
				cold: runs[0].refinement,
				warm: warm.map(run => run.refinement || null),
			} : undefined,
			cold: runs[0].totalMs,
			coldVisible: runs[0].visibleMs || 0,
			warmRange: {
				total: [Math.min(...warm.map(r => r.totalMs)), Math.max(...warm.map(r => r.totalMs))],
				visible: [Math.min(...warm.map(r => r.visibleMs || 0)), Math.max(...warm.map(r => r.visibleMs || 0))],
			},
			line: warm[warm.length - 1].line,
			trace: warm[warm.length - 1].trace || '',
		};
		rows.push(row);
		console.log(id.slice(0, 33).padEnd(34) + pad(row.mb.toFixed(1), 8) + pad(row.read.toFixed(0), 7)
			+ pad(row.decode.toFixed(0), 8) + pad(row.cold.toFixed(0), 8) + pad(row.total.toFixed(0), 8)
			+ pad(row.coldVisible.toFixed(0), 10) + pad(row.visible.toFixed(0), 10) + '  ' + row.engine);
	}
	const missing = rows.filter(r => r.line === '');
	if (missing.length) console.log(`\n${missing.length} file(s) produced no [Perf] line: ${missing.map(r => r.id).join(', ')}`);

	const out = path.join(root, 'benchmark-vscode-result.json');
	fs.writeFileSync(out, JSON.stringify({ benchDir, iterations, rows }, null, 2));
	console.log(`\nCold = iteration 1; warm = median of iterations 2..${iterations}. Full detail: ${out}`);
}

main().catch(error => { console.error(error); process.exit(1); });
