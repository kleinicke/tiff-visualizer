import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeNpyF32, makePfm, makePpm16 } from '../scripts/lib/decoder-performance-samples.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const wasmJs = path.join(root, 'media/wasm/tiff-wasm.js');
const wasmBin = path.join(root, 'media/wasm/tiff-wasm.wasm');

function arrayBuffer(bytes) {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function decode(module, format, buffer) {
	const bytes = new Uint8Array(buffer);
	return format === 'ppm' ? module.decode_ppm_display_fast(bytes)
			: format === 'npy' ? module.decode_npy_display_fast(bytes)
			: module.decode_pfm_display_fast(bytes, true);
}

async function main() {
	const module = await import(`${pathToFileURL(wasmJs).href}?v=${Date.now()}`);
	await module.default({ module_or_path: fs.readFileSync(wasmBin) });
	const cases = [
		{ id: 'RGB16 PPM', format: 'ppm', bytes: makePpm16(7, 5, 3) },
		{ id: 'float32 NPY', format: 'npy', bytes: makeNpyF32(7, 5) },
		{ id: 'float32 PFM', format: 'pfm', bytes: makePfm(7, 5) },
	];

	for (const kase of cases) {
		const ordinaryBuffer = arrayBuffer(kase.bytes);
		const ordinary = decode(module, kase.format, ordinaryBuffer);
		let expected;
		if (ordinary.can_reuse_source === true) {
			expected = new Float32Array(ordinaryBuffer, ordinary.source_data_offset, ordinary.data_len).slice();
			ordinary.discard_data();
		} else if (ordinary.sample_kind === 3) {
			const bytes = ordinary.take_data_as_u8();
			expected = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
		} else {
			expected = ordinary.sample_kind === 2 ? ordinary.take_data_as_u16()
				: ordinary.sample_kind === 1 ? ordinary.take_data_as_u8() : ordinary.take_data_as_f32();
		}

		const reusable = arrayBuffer(kase.bytes);
		const result = decode(module, kase.format, reusable);
		const dataLength = result.data_len;
		assert.equal(dataLength, expected.length, `${kase.id}: data_len`);
		let actual;
		if (result.can_reuse_source === true) {
			actual = new Float32Array(reusable, result.source_data_offset, dataLength);
			result.discard_data();
		} else if (result.sample_kind === 3) {
			const bytes = new Uint8Array(reusable, 0, dataLength * 2);
			result.copy_data_as_u8_into(bytes);
			actual = new Uint16Array(reusable, 0, dataLength);
		} else if (result.sample_kind === 2) {
			actual = new Uint16Array(reusable, 0, dataLength);
			result.copy_data_as_u16_into(actual);
		} else if (result.sample_kind === 1) {
			actual = new Uint8Array(reusable, 0, dataLength);
			result.copy_data_as_u8_into(actual);
		} else {
			actual = new Float32Array(reusable, 0, dataLength);
			result.copy_data_as_f32_into(actual);
		}
		assert.equal(actual.buffer, reusable, `${kase.id}: source ArrayBuffer must be reused`);
		assert.deepEqual(actual, expected, `${kase.id}: reused-buffer samples`);
		console.log(`✅ ${kase.id} reuses its transferred source buffer`);
	}
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
