#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { writeSyntheticPerformanceSamples } from './lib/decoder-performance-samples.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const oldRef = process.env.PERF_OLD_REF || '4b1c8fdb068b9cf96d9339fd0efd87d157dde8f0';
const size = Number(process.env.PERF_SIZE || 2048);
const iterations = Math.max(1, Number(process.env.PERF_VSCODE_ITERATIONS || 3));
const only = new Set(String(process.env.PERF_ONLY || '').split(',').map(value => value.trim()).filter(Boolean));

function median(values) {
	const ordered = [...values].sort((a, b) => a - b);
	return ordered[Math.floor(ordered.length / 2)];
}

function buildVariant(directory) {
	execFileSync(process.execPath, [path.join(directory, 'esbuild.js')], { cwd: directory, stdio: 'inherit' });
}

function externalSamples() {
	const value = String(process.env.PERF_FILES || '').trim();
	if (!value) return [];
	return value.split(path.delimiter).filter(Boolean).map(file => ({ id: path.basename(file), file: path.resolve(file) }));
}

function repeatedInputs(directory, inputs) {
	const repeated = [];
	for (let iteration = 0; iteration < iterations; iteration++) {
		const runDirectory = path.join(directory, `run-${iteration + 1}`);
		fs.mkdirSync(runDirectory, { recursive: true });
		// Rotate the order so module warm-up and the previous format do not always
		// benefit or penalize the same sample.
		const rotated = inputs.slice(iteration % inputs.length).concat(inputs.slice(0, iteration % inputs.length));
		for (const input of rotated) {
			const file = path.join(runDirectory, path.basename(input.file));
			try { fs.linkSync(input.file, file); } catch { fs.copyFileSync(input.file, file); }
			repeated.push({ ...input, file, iteration });
		}
	}
	return repeated;
}

function aggregate(results) {
	const grouped = new Map();
	for (const result of results) {
		const values = grouped.get(result.id) || [];
		values.push(result);
		grouped.set(result.id, values);
	}
	return new Map([...grouped].map(([id, values]) => [id, {
		id,
		loadMs: median(values.map(value => value.loadMs)),
		totalMs: median(values.map(value => value.totalMs)),
		wallMs: median(values.map(value => value.wallMs)),
	}]));
}

async function runVariant(vscodeExecutablePath, extensionRoot, variant, inputs, tempRoot) {
	const userData = path.join(tempRoot, `user-${variant}`);
	const resultFile = path.join(tempRoot, `${variant}.json`);
	fs.mkdirSync(userData, { recursive: true });
	const previous = {
		TIFF_PERF_FILES: process.env.TIFF_PERF_FILES,
		TIFF_PERF_LOG_ROOT: process.env.TIFF_PERF_LOG_ROOT,
		TIFF_PERF_RESULT: process.env.TIFF_PERF_RESULT,
		TIFF_PERF_VARIANT: process.env.TIFF_PERF_VARIANT,
	};
	Object.assign(process.env, {
		TIFF_PERF_FILES: JSON.stringify(inputs),
		TIFF_PERF_LOG_ROOT: userData,
		TIFF_PERF_RESULT: resultFile,
		TIFF_PERF_VARIANT: variant,
	});
	// When invoked from VS Code's integrated terminal these variables describe
	// the *parent* extension host. In particular ELECTRON_RUN_AS_NODE=1 makes
	// the downloaded Code executable treat the workspace path as a Node script.
	const parentVsCodeEnvironment = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')),
	);
	for (const key of Object.keys(parentVsCodeEnvironment)) delete process.env[key];
	try {
		await runTests({
			vscodeExecutablePath,
			extensionDevelopmentPath: extensionRoot,
			extensionTestsPath: path.join(root, 'test/vscode-performance/runner.cjs'),
			launchArgs: [path.dirname(inputs[0].file), `--user-data-dir=${userData}`, '--disable-workspace-trust', '--skip-welcome'],
		});
		return JSON.parse(fs.readFileSync(resultFile, 'utf8'));
	} finally {
		Object.assign(process.env, parentVsCodeEnvironment);
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function main() {
	if (!Number.isInteger(size) || size < 1) throw new Error(`Invalid PERF_SIZE: ${size}`);
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiff-vscode-perf-'));
	const oldRoot = path.join(tempRoot, 'old');
	try {
		execFileSync('git', ['worktree', 'add', '--detach', oldRoot, oldRef], { cwd: root, stdio: 'inherit' });
		fs.symlinkSync(path.join(root, 'node_modules'), path.join(oldRoot, 'node_modules'), 'dir');
		const allSourceInputs = [
			...writeSyntheticPerformanceSamples(path.join(tempRoot, 'samples'), size).map(({ id, file }) => ({ id, file })),
			...externalSamples(),
		];
		const sourceInputs = only.size ? allSourceInputs.filter(input => only.has(input.id)) : allSourceInputs;
		if (!sourceInputs.length) throw new Error(`PERF_ONLY matched no samples: ${[...only].join(', ')}`);
		const inputs = repeatedInputs(path.join(tempRoot, 'benchmark-inputs'), sourceInputs);
		console.log('Building current extension...');
		buildVariant(root);
		console.log(`Building baseline extension ${oldRef.slice(0, 8)}...`);
		buildVariant(oldRoot);
		// v1.9.0's blob worker resolves its unbundled generated WASM glue from
		// `<extension>/wasm`, while the tracked assets live in `media/wasm`.
		// Packaged builds supplied that compatibility directory; reproduce it in
		// the detached source worktree so the baseline measures its Rust paths
		// instead of silently timing the JS fallbacks.
		fs.cpSync(path.join(oldRoot, 'media/wasm'), path.join(oldRoot, 'wasm'), { recursive: true, force: true });
		// The generated glue itself appends `wasm/tiff-wasm.wasm` to its own
		// directory. Mirror that nested packaged path as well.
		fs.mkdirSync(path.join(oldRoot, 'wasm/wasm'), { recursive: true });
		fs.copyFileSync(
			path.join(oldRoot, 'media/wasm/tiff-wasm.wasm'),
			path.join(oldRoot, 'wasm/wasm/tiff-wasm.wasm'),
		);
		let vscodeExecutablePath = await downloadAndUnzipVSCode(process.env.PERF_VSCODE_VERSION || 'stable');
		// VS Code 1.133's macOS archive renamed the inner executable from
		// `Electron` to `Code` before @vscode/test-electron learned that layout.
		// Accept both so the benchmark is not coupled to the helper's guess.
		if (process.platform === 'darwin' && !fs.existsSync(vscodeExecutablePath)) {
			const codeExecutable = vscodeExecutablePath.replace(/\/Electron$/, '/Code');
			if (fs.existsSync(codeExecutable)) vscodeExecutablePath = codeExecutable;
		}
		const old = await runVariant(vscodeExecutablePath, oldRoot, 'old', inputs, tempRoot);
		const current = await runVariant(vscodeExecutablePath, root, 'current', inputs, tempRoot);
		const oldById = aggregate(old.results);
		const currentById = aggregate(current.results);
		const rows = sourceInputs.map(input => {
			const baseline = oldById.get(input.id);
			const candidate = currentById.get(input.id);
			return {
				sample: input.id,
				oldLoadMs: baseline.loadMs.toFixed(1),
				currentLoadMs: candidate.loadMs.toFixed(1),
				ratio: (candidate.loadMs / baseline.loadMs).toFixed(2),
				oldWallMs: baseline.wallMs.toFixed(1),
				currentWallMs: candidate.wallMs.toFixed(1),
			};
		});
		console.log(`VS Code A/B: ${size}x${size}, median of ${iterations}, old=${oldRef.slice(0, 8)}`);
		console.table(rows);
	} finally {
		try { execFileSync('git', ['worktree', 'remove', '--force', oldRoot], { cwd: root, stdio: 'ignore' }); } catch { /* best effort */ }
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
