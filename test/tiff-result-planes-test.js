/**
 * The decode worker splits multi-channel TIFF results into channel planes with
 * `TiffResult.planes_u8` / `planes_f32` (Rust) instead of a JavaScript loop.
 * Every plane must equal the interleaved samples' channel, on every
 * multi-channel TIFF fixture, and single-channel results report no planes.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
	const wasm = await import('../media/wasm/tiff-wasm.js');
	await wasm.default({ module_or_path: fs.readFileSync('media/wasm/tiff-wasm.wasm') });
	const names = fs.readdirSync('test-samples').filter(name => /\.tiff?$/i.test(name));
	const checked = { 0: 0, 1: 0, 3: 0 };
	let fallback = 0;
	for (const name of names) {
		let result;
		try { result = wasm.decode_tiff_fast(new Uint8Array(fs.readFileSync(path.join('test-samples', name)))); } catch { continue; }
		const kind = Number(result.sample_kind), channels = result.channels;
		const bytes = result.planes_u8(), floats = result.planes_f32();
		const data = kind === 0 ? result.take_data_as_f32() : kind === 1 ? result.take_data_as_u8() : kind === 3 ? (b => new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2))(result.take_data_as_u8()) : null;
		result.free();
		if (!data) continue;
		if (channels < 2) {
			assert.equal(bytes.length + floats.length, 0, `${name}: single channel has planes`);
			continue;
		}
		const planes = kind === 0 ? floats : kind === 3 ? new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2) : bytes;
		// f32 results converted from stored bytes have no planes; the worker
		// deinterleaves those itself.
		if (kind === 0 && planes.length === 0) { fallback++; continue; }
		assert.equal(planes.length, data.length, `${name}: plane sample count`);
		const pixels = data.length / channels;
		for (let c = 0; c < channels; c++) {
			for (let i = 0; i < pixels; i++) {
				if (!Object.is(planes[c * pixels + i], data[i * channels + c])) {
					assert.fail(`${name}: plane ${c} pixel ${i} is ${planes[c * pixels + i]}, interleaved has ${data[i * channels + c]}`);
				}
			}
		}
		checked[kind]++;
	}
	assert.ok(checked[0] > 0 && checked[1] > 0 && checked[3] > 0, `fixture coverage ${JSON.stringify(checked)}`);
	console.log(`TiffResult planes equal the interleaved channels (f32 ${checked[0]}, u8 ${checked[1]}, u16 ${checked[3]} fixtures; ${fallback} f32 without planes)`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
