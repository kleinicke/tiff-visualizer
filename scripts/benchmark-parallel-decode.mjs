#!/usr/bin/env node
/**
 * Measure what the parallel decode path buys, by simulating the browser worker
 * pool with node worker_threads: N workers, each instantiating the WASM module
 * once and decoding a contiguous range of units (strips, or tile rows).
 *
 *   node scripts/benchmark-parallel-decode.mjs <file.tif> [workers]
 *
 * Prints the single-threaded `decode_tiff` time next to the pool's, e.g.
 *
 *   big_zstd_tiled.tif   units=8 tiled=true single=609ms pool(4)=173ms speedup=3.51x
 *
 * What this does NOT measure: the browser pool keeps its workers warm, while
 * this spawns one per range and instantiates the module inside the timed
 * region, so the reported speedup is a floor rather than a ceiling. Node is
 * also not the webview — read docs/performance-method.md before drawing
 * conclusions from any single number here, and never compare a first run
 * against a later one.
 *
 * A file the plan rejects prints "not eligible", which is the answer to "why
 * is this one slow": it is decoding on one thread.
 */
import fs from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const WASM_JS = '/home/user/tiff-visualizer/media/wasm/tiff-wasm.js';
const WASM_BIN = '/home/user/tiff-visualizer/media/wasm/tiff-wasm.wasm';

if (!isMainThread) {
	const mod = await import(WASM_JS);
	await mod.default({ module_or_path: fs.readFileSync(WASM_BIN) });
	const j = workerData;
	const t0 = performance.now();
	const out = mod.decode_tiff_strip_range_raw(
		new Uint8Array(j.blob), new Uint32Array(j.counts), j.first,
		j.width, j.height, j.channels, j.bits, j.compression, j.rowsPerUnit,
		j.predictor, j.format, j.littleEndian, j.tileWidth, j.tileLength,
		j.blocksAcross, j.lerc);
	parentPort.postMessage({ ms: performance.now() - t0, bytes: out.byteLength });
	process.exit(0);
}

const file = process.argv[2];
const workers = Number(process.argv[3] || 4);
const bytes = new Uint8Array(fs.readFileSync(file));
const mod = await import(WASM_JS);
await mod.default({ module_or_path: fs.readFileSync(WASM_BIN) });

let t0 = performance.now();
mod.decode_tiff(bytes);
const single = performance.now() - t0;

const plan = mod.tiff_float_strip_plan(bytes);
if (!plan) { console.log('not eligible'); process.exit(0); }
const bpu = plan.blocks_per_unit, units = plan.strip_count;
const offsets = plan.offsets, counts = plan.counts;
const per = Math.ceil(units / workers);
const ranges = [];
for (let f = 0; f < units; f += per) { ranges.push({ first: f, last: Math.min(units, f + per) }); }

t0 = performance.now();
const results = await Promise.all(ranges.map(r => new Promise((resolve, reject) => {
	const fb = r.first * bpu, lb = r.last * bpu;
	let len = 0;
	for (let i = fb; i < lb; i++) { len += counts[i]; }
	const blob = new Uint8Array(len);
	const rc = new Uint32Array(lb - fb);
	let pos = 0;
	for (let i = fb; i < lb; i++) {
		blob.set(bytes.subarray(offsets[i], offsets[i] + counts[i]), pos);
		pos += counts[i]; rc[i - fb] = counts[i];
	}
	const w = new Worker(new URL(import.meta.url), { workerData: {
		blob: blob.buffer, counts: rc.buffer, first: r.first,
		width: plan.width, height: plan.height, channels: plan.channels,
		bits: plan.bits_per_sample, compression: plan.compression,
		rowsPerUnit: plan.rows_per_strip, predictor: plan.predictor,
		format: plan.sample_format, littleEndian: plan.little_endian,
		tileWidth: plan.tile_width, tileLength: plan.tile_length,
		blocksAcross: plan.blocks_across, lerc: plan.lerc_additional_compression,
	}, transferList: [blob.buffer, rc.buffer] });
	w.on('message', resolve);
	w.on('error', reject);
})));
const parallel = performance.now() - t0;
const name = file.split('/').pop();
console.log(`${name.padEnd(26)} units=${String(units).padStart(4)} tiled=${plan.tile_length > 0} single=${single.toFixed(0)}ms  pool(${ranges.length})=${parallel.toFixed(0)}ms  speedup=${(single / parallel).toFixed(2)}x`);
