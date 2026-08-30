#!/usr/bin/env node
/**
 * Warm Node comparison of whole-image TIFF decode against the browser-style
 * range worker pool. The first run of both paths is discarded.
 *
 *   node scripts/benchmark-parallel-decode.mjs <file.tif> [workers] [runs]
 *
 * Node is not the VS Code webview. Use this to choose candidates and catch
 * regressions; use docs/performance-method.md for release-grade measurements.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

if (!isMainThread) {
	const mod = await import(pathToFileURL(workerData.wasmJs).href);
	await mod.default({ module_or_path: fs.readFileSync(workerData.wasmBin) });
	parentPort.postMessage({ ready: true });
	parentPort.on('message', job => {
		try {
			const started = performance.now();
			const out = mod.decode_tiff_strip_range_raw(
				new Uint8Array(job.blob), new Uint32Array(job.counts), job.first,
				job.width, job.height, job.channels, job.bits, job.compression, job.rowsPerUnit,
				job.predictor, job.format, job.littleEndian,
				job.planarConfiguration, job.orientation,
				job.tileWidth, job.tileLength, job.blocksAcross, job.lerc);
			parentPort.postMessage(
				{ id: job.id, ms: performance.now() - started, bytes: out.byteLength, buffer: out.buffer },
				[out.buffer],
			);
		} catch (error) {
			parentPort.postMessage({ id: job.id, error: String(error?.message ?? error) });
		}
	});
} else {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const coreJs = path.join(root, 'media/wasm/tiff-wasm.js');
	const coreBin = path.join(root, 'media/wasm/tiff-wasm.wasm');
	const codecJs = path.join(root, 'media/wasm/codec-wasm.js');
	const codecBin = path.join(root, 'media/wasm/codec-wasm.wasm');
	const file = process.argv[2];
	const requestedWorkers = Number(process.argv[3] || 4);
	const runs = Math.max(1, Number(process.argv[4] || 3));
	if (!file) { throw new Error('Usage: benchmark-parallel-decode.mjs <file.tif> [workers] [runs]'); }

	const bytes = new Uint8Array(fs.readFileSync(file));
	const core = await import(pathToFileURL(coreJs).href);
	await core.default({ module_or_path: fs.readFileSync(coreBin) });
	const corePlan = core.tiff_float_strip_plan(bytes);
	if (!corePlan) { console.log('not eligible'); process.exit(0); }
	const extended = new Set([34887, 34925, 34712, 33003, 33004, 33005, 34934, 22610]);
	let mod = core;
	let wasmJs = coreJs;
	let wasmBin = coreBin;
	if (extended.has(corePlan.compression)) {
		mod = await import(pathToFileURL(codecJs).href);
		await mod.default({ module_or_path: fs.readFileSync(codecBin) });
		wasmJs = codecJs;
		wasmBin = codecBin;
	}
	const plan = mod.tiff_float_strip_plan(bytes);
	const blocksPerUnit = plan.blocks_per_unit;
	const units = plan.strip_count;
	const workerCount = Math.max(1, Math.min(requestedWorkers, units));
	const per = Math.ceil(units / workerCount);
	const ranges = [];
	for (let first = 0; first < units; first += per) {
		ranges.push({ first, last: Math.min(units, first + per) });
	}

	const workers = await Promise.all(Array.from({ length: ranges.length }, () => new Promise((resolve, reject) => {
		const worker = new Worker(new URL(import.meta.url), { workerData: { wasmJs, wasmBin } });
		worker.once('message', message => message.ready ? resolve(worker) : reject(new Error('worker failed to initialize')));
		worker.once('error', reject);
	})));
	let nextId = 1;
	const runPool = async () => {
		const started = performance.now();
		const results = await Promise.all(ranges.map((range, index) => new Promise((resolve, reject) => {
			const firstBlock = range.first * blocksPerUnit;
			const lastBlock = range.last * blocksPerUnit;
			let length = 0;
			for (let i = firstBlock; i < lastBlock; i++) { length += plan.counts[i]; }
			const blob = new Uint8Array(length);
			const counts = new Uint32Array(lastBlock - firstBlock);
			let position = 0;
			for (let i = firstBlock; i < lastBlock; i++) {
				blob.set(bytes.subarray(plan.offsets[i], plan.offsets[i] + plan.counts[i]), position);
				position += plan.counts[i];
				counts[i - firstBlock] = plan.counts[i];
			}
			const id = nextId++;
			const worker = workers[index];
			const onMessage = message => {
				if (message.id !== id) { return; }
				worker.off('message', onMessage);
				if (message.error) { reject(new Error(message.error)); } else { resolve({ message, range }); }
			};
			worker.on('message', onMessage);
			worker.postMessage({
				id, blob: blob.buffer, counts: counts.buffer, first: range.first,
				width: plan.width, height: plan.height, channels: plan.channels,
				bits: plan.bits_per_sample, compression: plan.compression,
				rowsPerUnit: plan.rows_per_strip, predictor: plan.predictor,
				format: plan.sample_format, littleEndian: plan.little_endian,
				planarConfiguration: plan.planar_configuration, orientation: plan.orientation,
				tileWidth: plan.tile_width, tileLength: plan.tile_length,
				blocksAcross: plan.blocks_across, lerc: plan.lerc_additional_compression,
			}, [blob.buffer, counts.buffer]);
		})));
		const rowBytes = plan.width * plan.channels * (plan.bits_per_sample / 8);
		const assembled = new Uint8Array(plan.width * plan.height * plan.channels * (plan.bits_per_sample / 8));
		for (const { message, range } of results) {
			assembled.set(new Uint8Array(message.buffer), range.first * plan.rows_per_strip * rowBytes);
		}
		return performance.now() - started;
	};
	const runSingle = () => {
		const started = performance.now();
		mod.decode_tiff(bytes);
		return performance.now() - started;
	};

	// Cold startup/JIT samples are deliberately discarded.
	runSingle();
	await runPool();
	const singles = [];
	const parallels = [];
	for (let i = 0; i < runs; i++) {
		singles.push(runSingle());
		parallels.push(await runPool());
	}
	for (const worker of workers) { await worker.terminate(); }
	const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
	const single = median(singles);
	const parallel = median(parallels);
	console.log(`${path.basename(file)} units=${units} tiled=${plan.tile_length > 0} compression=${plan.compression}`);
	console.log(`warm single: ${singles.map(value => value.toFixed(0)).join(', ')} ms (median ${single.toFixed(0)} ms)`);
	console.log(`warm pool(${ranges.length}): ${parallels.map(value => value.toFixed(0)).join(', ')} ms (median ${parallel.toFixed(0)} ms)`);
	console.log(`speedup: ${(single / parallel).toFixed(2)}x`);
}
