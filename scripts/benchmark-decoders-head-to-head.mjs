#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { syntheticPerformanceSamples } from './lib/decoder-performance-samples.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const oldRef = process.env.PERF_OLD_REF || '4b1c8fdb068b9cf96d9339fd0efd87d157dde8f0';
const size = Number(process.env.PERF_SIZE || 2048);
const iterations = Math.max(1, Number(process.env.PERF_ITERATIONS || 3));
const only = new Set(String(process.env.PERF_ONLY || '').split(',').map(value => value.trim()).filter(Boolean));

function median(values) {
	const ordered = [...values].sort((a, b) => a - b);
	return ordered[Math.floor(ordered.length / 2)];
}

function checksum(data) {
	const points = [0, Math.floor(data.length / 7), Math.floor(data.length / 2), data.length - 1];
	return points.map(index => Number(data[Math.max(0, index)]).toPrecision(8)).join(':');
}

async function oldDecoders(oldRoot, tempRoot) {
	const outfile = path.join(tempRoot, 'legacy-decoders.mjs');
	const quote = value => JSON.stringify(value.replace(/\\/g, '/'));
	await build({
		stdin: {
			contents: `
				import { PpmProcessor } from ${quote(path.join(oldRoot, 'media/modules/ppm-processor.ts'))};
				import { NpyProcessor } from ${quote(path.join(oldRoot, 'media/modules/npy-processor.ts'))};
				import { PfmProcessor } from ${quote(path.join(oldRoot, 'media/modules/pfm-processor.ts'))};
				export function decode(format, buffer) {
					if (format === 'ppm') return new PpmProcessor(null, null)._parsePpm(buffer);
					if (format === 'npy') return new NpyProcessor(null, null)._parseNpy(buffer);
					return new PfmProcessor(null, null)._parsePfm(buffer, { topDown: true });
				}
			`,
			resolveDir: oldRoot,
			sourcefile: 'legacy-performance-entry.ts',
			loader: 'ts',
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node20',
		outfile,
		logLevel: 'silent',
	});
	const legacy = await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
	const wasm = await loadWasm(path.join(oldRoot, 'media/wasm'));
	return combinedDecoders(legacy, wasm);
}

async function loadWasm(directory) {
	const js = path.join(directory, 'tiff-wasm.js');
	const wasm = path.join(directory, 'tiff-wasm.wasm');
	const module = await import(`${pathToFileURL(js).href}?v=${Date.now()}`);
	await module.default({ module_or_path: fs.readFileSync(wasm) });
	return module;
}

function combinedDecoders(legacy, module) {
	return {
		decode(format, buffer) {
			if (format === 'ppm' || format === 'npy' || format === 'pfm') {
				return legacy.decode(format, buffer);
			}
			const bytes = new Uint8Array(buffer);
			const result = format === 'png16' ? module.decode_png16_fast(bytes)
				: format === 'hdr' ? module.decode_hdr_fast(bytes)
					: format === 'exr' ? module.decode_exr_fast(bytes)
						: module.decode_tiff_fast(bytes);
			const metadata = format === 'hdr' ? result.take_metadata_as_f64() : null;
			const data = format === 'png16' ? result.take_data_as_u16() : result.take_data_as_f32();
			return {
				width: format === 'hdr' ? metadata[0] : result.width,
				height: format === 'hdr' ? metadata[1] : result.height,
				channels: format === 'hdr' ? (result.channels || Math.round(data.length / (metadata[0] * metadata[1]))) : result.channels,
				data,
			};
		},
	};
}

async function currentDecoders() {
	const module = await loadWasm(path.join(root, 'media/wasm'));
	const rustRaw = {
		decode(format, buffer) {
			const bytes = new Uint8Array(buffer);
			const result = format === 'ppm' ? module.decode_ppm_display_fast(bytes)
				: format === 'npy' ? module.decode_npy_display_fast(bytes)
					: module.decode_pfm_display_fast(bytes, true);
			const length = result.data_len;
			let data;
			if (result.can_reuse_source === true && result.sample_kind === 0 &&
				result.source_data_offset % 4 === 0 && result.source_data_offset + length * 4 <= buffer.byteLength) {
				data = new Float32Array(buffer, result.source_data_offset, length);
				result.discard_data();
			} else if (result.sample_kind === 3 && buffer.byteLength >= length * 2) {
				const target = new Uint8Array(buffer, 0, length * 2);
				result.copy_data_as_u8_into(target);
				data = new Uint16Array(buffer, 0, length);
			} else if (result.sample_kind === 2 && buffer.byteLength >= length * 2) {
				data = new Uint16Array(buffer, 0, length);
				result.copy_data_as_u16_into(data);
			} else if (result.sample_kind === 1 && buffer.byteLength >= length) {
				data = new Uint8Array(buffer, 0, length);
				result.copy_data_as_u8_into(data);
			} else if (result.sample_kind === 0 && buffer.byteLength >= length * 4) {
				data = new Float32Array(buffer, 0, length);
				result.copy_data_as_f32_into(data);
			} else {
				if (result.sample_kind === 3) {
					const nativeBytes = result.take_data_as_u8();
					data = new Uint16Array(nativeBytes.buffer, nativeBytes.byteOffset, nativeBytes.byteLength / 2);
				} else {
					data = result.sample_kind === 2 ? result.take_data_as_u16()
						: result.sample_kind === 1 ? result.take_data_as_u8() : result.take_data_as_f32();
				}
			}
			return { width: result.width, height: result.height, channels: result.channels, data };
		},
	};
	return {
		decode(format, buffer) {
			return (format === 'ppm' || format === 'npy' || format === 'pfm')
				? rustRaw.decode(format, buffer)
				: combinedDecoders(null, module).decode(format, buffer);
		},
	};
}

function externalDecoderSamples() {
	const value = String(process.env.PERF_DECODER_FILES || '').trim();
	if (!value) return [];
	return value.split(path.delimiter).filter(Boolean).map(entry => {
		const separator = entry.indexOf('=');
		if (separator <= 0) throw new Error(`Expected format=/absolute/file in PERF_DECODER_FILES, got ${entry}`);
		const format = entry.slice(0, separator);
		const file = path.resolve(entry.slice(separator + 1));
		return { id: path.basename(file), format, bytes: fs.readFileSync(file), verifyPixels: false };
	});
}

async function main() {
	if (!Number.isInteger(size) || size < 1) throw new Error(`Invalid PERF_SIZE: ${size}`);
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiff-visualizer-perf-'));
	const oldRoot = path.join(tempRoot, 'old');
	try {
		execFileSync('git', ['worktree', 'add', '--detach', oldRoot, oldRef], { cwd: root, stdio: 'ignore' });
		const [legacy, current] = await Promise.all([oldDecoders(oldRoot, tempRoot), currentDecoders()]);
		const rows = [];
		const allSamples = [...syntheticPerformanceSamples(size), ...externalDecoderSamples()];
		const samples = only.size ? allSamples.filter(sample => only.has(sample.id)) : allSamples;
		if (!samples.length) throw new Error(`PERF_ONLY matched no samples: ${[...only].join(', ')}`);
		for (const sample of samples) {
			const measurements = { old: [], current: [] };
			let expected;
			for (const [variant, decoder] of [['old', legacy], ['current', current]]) {
				for (let iteration = 0; iteration < iterations; iteration++) {
					const input = sample.bytes.buffer.slice(sample.bytes.byteOffset, sample.bytes.byteOffset + sample.bytes.byteLength);
					const started = performance.now();
					const decoded = decoder.decode(sample.format, input);
					measurements[variant].push(performance.now() - started);
					assert.ok(decoded.width > 0);
					assert.ok(decoded.height > 0);
					const signature = `${decoded.channels}:${decoded.data.length}:${checksum(decoded.data)}`;
					if (sample.verifyPixels !== false) {
						if (expected === undefined) expected = signature;
						else assert.equal(signature, expected, `${sample.id} output differs for ${variant}`);
					}
				}
			}
			const oldMs = median(measurements.old);
			const currentMs = median(measurements.current);
			rows.push({ sample: sample.id, oldMs: oldMs.toFixed(1), currentMs: currentMs.toFixed(1), ratio: (currentMs / oldMs).toFixed(2) });
		}
		console.log(`Decoder A/B: ${size}x${size}, median of ${iterations}, old=${oldRef.slice(0, 8)}`);
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
