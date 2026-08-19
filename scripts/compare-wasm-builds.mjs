#!/usr/bin/env node
/**
 * Decode the same files with TWO WebAssembly builds and compare every sample.
 *
 * This is the tool that catches decoder regressions, and it is worth more than
 * any timing script: a change that is 3x faster and 0.001% wrong is a bad
 * change, and only a sample-by-sample comparison against a known-good build
 * will tell you which you have.
 *
 * It found, in one session: a strip path that returned a quarter of the samples
 * for 16-bit floats, and a +/-1 shift in JPEG output caused by enabling SIMD.
 * Neither was visible in any timing number or in the existing test suite.
 *
 *   # build a reference before your change, keep it somewhere
 *   npm run build:wasm && mkdir -p /tmp/ref && cp media/wasm/tiff-wasm.* /tmp/ref/
 *
 *   # after the change
 *   node scripts/compare-wasm-builds.mjs --old /tmp/ref --new media/wasm \
 *        test-samples/*.tif
 *
 * Options:
 *   --old <dir>   directory holding tiff-wasm.js + the .wasm (required)
 *   --new <dir>   defaults to media/wasm
 *   --decoder     tiff (default) | exr | dicom | png16 | fits | netcdf | czi
 *
 * NaN compares equal to NaN here: it is a legitimate sample value in scientific
 * data, and === would report every NaN as a difference.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function flag(name, fallback) {
	const i = args.indexOf(name);
	if (i < 0) return fallback;
	const value = args[i + 1];
	args.splice(i, 2);
	return value;
}
const oldRoot = flag('--old');
const newRoot = flag('--new', 'media/wasm');
const decoder = flag('--decoder', 'tiff');
const files = args.filter(a => !a.startsWith('--'));

if (!oldRoot || !files.length) {
	console.error('usage: compare-wasm-builds.mjs --old <dir> [--new <dir>] [--decoder <name>] <file>...');
	process.exit(2);
}

const ENTRY = {
	tiff: 'decode_tiff',
	exr: 'decode_exr_fast',
	dicom: 'decode_dicom_fast',
	png16: 'decode_png16_fast',
	fits: 'decode_fits_fast',
	netcdf: 'decode_netcdf_fast',
	czi: 'decode_czi_fast',
};
const entry = ENTRY[decoder];
if (!entry) { console.error(`unknown --decoder ${decoder}`); process.exit(2); }

/** wasm-pack "web" glue needs its payload handed over explicitly under Node. */
async function load(root) {
	const dir = path.resolve(root);
	const glue = path.join(dir, 'tiff-wasm.js');
	// wasm-pack writes tiff-wasm_bg.wasm; the build:wasm script renames it.
	const payload = ['tiff-wasm.wasm', 'tiff-wasm_bg.wasm']
		.map(n => path.join(dir, n)).find(p => fs.existsSync(p));
	if (!payload) throw new Error(`no .wasm payload in ${dir}`);
	const module = await import(glue);
	await module.default({ module_or_path: fs.readFileSync(payload) });
	return module;
}

const A = await load(oldRoot);
const B = await load(newRoot);

let failures = 0;
for (const file of files) {
	const bytes = new Uint8Array(fs.readFileSync(file));
	let a;
	let b;
	try {
		a = A[entry](bytes);
		b = B[entry](bytes);
	} catch (error) {
		console.log(`ERROR      ${path.basename(file).padEnd(34)} ${error}`);
		failures++;
		continue;
	}
	// take_data_as_f32 is one-shot (it MOVES the samples out), so call it once.
	const da = (a.take_data_as_f32 || a.get_data_as_f32).call(a);
	const db = (b.take_data_as_f32 || b.get_data_as_f32).call(b);

	let firstDiff = -1;
	let diffCount = 0;
	let maxAbs = 0;
	if (da.length !== db.length) {
		firstDiff = -2;
	} else {
		for (let i = 0; i < da.length; i++) {
			const x = da[i];
			const y = db[i];
			if (x === y || (Number.isNaN(x) && Number.isNaN(y))) continue;
			if (firstDiff < 0) firstDiff = i;
			diffCount++;
			const delta = Math.abs(x - y);
			if (delta > maxAbs) maxAbs = delta;
		}
	}

	const label = `${a.width}x${a.height}x${a.channels}@${a.bits_per_sample ?? '?'}`;
	if (firstDiff === -1) {
		console.log(`IDENTICAL  ${path.basename(file).padEnd(34)} ${label} n=${da.length}`);
	} else if (firstDiff === -2) {
		failures++;
		console.log(`LENGTH     ${path.basename(file).padEnd(34)} old=${da.length} new=${db.length}`);
	} else {
		failures++;
		const pct = (diffCount / da.length * 100).toFixed(3);
		console.log(`DIFFERS    ${path.basename(file).padEnd(34)} ${label} ${diffCount}/${da.length} (${pct}%) `
			+ `maxAbs=${maxAbs} first@${firstDiff} old=${da[firstDiff]} new=${db[firstDiff]}`);
	}
}

console.log(`\n${files.length - failures}/${files.length} identical`);
process.exit(failures ? 1 : 0);
