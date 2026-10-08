/**
 * The PSD/PSB preview's composite decodes on the strip pool
 * (`decodePsdCompositeParallel`, Rust `psd_composite_plan` and
 * `decode_psd_composite_rows`). ag-psd's composite is the authoritative
 * preview, so the pool's RGBA must equal it byte for byte, through every quirk
 * the Rust module comments list; a document the plan cannot reproduce exactly
 * must decline (null) so ag-psd decodes it instead.
 *
 * Documents come from ag-psd's own writer (RLE, global alpha with the white
 * matte, PSB) and from a minimal writer here for what it cannot produce (raw
 * and grayscale composites, extra channels, overlong and short rows).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Worker } = require('node:worker_threads');
const { readPsd, writePsdBuffer, initializeCanvas } = require('ag-psd');

const workers = [];
const nativeFetch = global.fetch;
class BrowserWorker {
	constructor() {
		const source = `import { parentPort } from 'node:worker_threads';
			globalThis.self = { postMessage: (data, transfer) => parentPort.postMessage(data, transfer) };
			${fs.readFileSync('media/stripDecodeWorker.bundle.js', 'utf8')}
			parentPort.on('message', data => self.onmessage({ data }));`;
		this.worker = new Worker(new URL('data:text/javascript;base64,' + Buffer.from(source).toString('base64')));
		this.listeners = new Set();
		this.worker.on('message', data => {
			this.onmessage?.({ data });
			for (const listener of this.listeners) listener({ data });
		});
		this.worker.on('error', error => this.onerror?.(error));
		workers.push(this.worker);
	}
	postMessage(data, transfer) { this.worker.postMessage(data, transfer); }
	addEventListener(_type, callback) { this.listeners.add(callback); }
	removeEventListener(_type, callback) { this.listeners.delete(callback); }
	terminate() { this.worker.terminate(); }
}

globalThis.ImageData ??= class {
	constructor(data, width, height) {
		if (typeof data === 'number') { height = width; width = data; data = new Uint8ClampedArray(width * height * 4); }
		this.data = data; this.width = width; this.height = height;
	}
};
initializeCanvas(() => ({ getContext: () => null }), (width, height) => new ImageData(width, height));

function agComposite(bytes) {
	const psd = readPsd(bytes.slice().buffer, {
		useImageData: true, skipLayerImageData: true, skipThumbnail: true, skipLinkedFilesData: true, logMissingFeatures: false,
	});
	return psd.imageData.data;
}

/** Deterministic bytes. */
function noise(length, seed) {
	const out = new Uint8Array(length);
	let state = seed >>> 0 || 1;
	for (let i = 0; i < length; i++) {
		state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
		out[i] = state & 0xff;
	}
	return out;
}

/** PackBits rows: literal runs of up to 128, with a repeat run where bytes repeat. */
function packBits(row) {
	const out = [];
	for (let i = 0; i < row.length;) {
		let run = 1;
		while (i + run < row.length && run < 128 && row[i + run] === row[i]) run++;
		if (run >= 3) { out.push(257 - run, row[i]); i += run; continue; }
		const start = i;
		while (i < row.length && i - start < 128 && !(i + 2 < row.length && row[i] === row[i + 1] && row[i] === row[i + 2])) i++;
		out.push(i - start - 1, ...row.subarray(start, i));
	}
	return Uint8Array.from(out);
}

/**
 * A document with empty color-mode, resource and layer sections and the
 * given composite. `rowBytes(channel, y)` supplies each stored row (already
 * PackBits-encoded for compression 1).
 */
function buildPsd({ width, height, mode, headerChannels, listed, compression, psb = false, rowBytes }) {
	const parts = [];
	const header = Buffer.alloc(26);
	header.write('8BPS', 0, 'latin1');
	header.writeUInt16BE(psb ? 2 : 1, 4);
	header.writeUInt16BE(headerChannels, 12);
	header.writeUInt32BE(height, 14);
	header.writeUInt32BE(width, 18);
	header.writeUInt16BE(8, 22);
	header.writeUInt16BE(mode, 24);
	parts.push(header, Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(psb ? 8 : 4));
	const compressionField = Buffer.alloc(2);
	compressionField.writeUInt16BE(compression, 0);
	parts.push(compressionField);
	const rows = [];
	for (let c = 0; c < listed; c++) for (let y = 0; y < height; y++) rows.push(Buffer.from(rowBytes(c, y)));
	if (compression === 1) {
		const table = Buffer.alloc(rows.length * (psb ? 4 : 2));
		rows.forEach((row, i) => psb ? table.writeUInt32BE(row.length, i * 4) : table.writeUInt16BE(row.length, i * 2));
		parts.push(table);
	}
	parts.push(...rows);
	return new Uint8Array(Buffer.concat(parts));
}

async function main() {
	global.Worker = BrowserWorker;
	global.fetch = async url => String(url).endsWith('stripDecodeWorker.bundle.js')
		? new Response(fs.readFileSync('media/stripDecodeWorker.bundle.js')) : nativeFetch(url);
	const module = await WebAssembly.compile(fs.readFileSync('media/wasm/tiff-wasm.wasm'));
	global.__tiffVisualizerDecoderWarmup = { wasmModulePromise: Promise.resolve(module) };
	const wasm = await import('../media/wasm/tiff-wasm.js');
	await wasm.default({ module_or_path: module });
	const { decodePsdCompositeParallel } = await import('../out/media/modules/strip-parallel-decode.js');

	const width = 1700, height = 1300;
	const identical = async (name, bytes) => {
		let handedOff = false;
		const result = await decodePsdCompositeParallel(bytes.slice().buffer, wasm, () => { handedOff = true; });
		assert.ok(result, `${name}: the pool declined`);
		assert.ok(handedOff, `${name}: the source was never released`);
		assert.ok(result.workers >= 2, `${name}: ran on ${result.workers} worker(s)`);
		const expected = agComposite(bytes);
		assert.equal(result.data.length, expected.length, `${name}: size`);
		assert.ok(Buffer.from(result.data.buffer).equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength)),
			`${name}: differs from ag-psd`);
	};
	const cases = [];

	// ag-psd's writer: RLE, then with alpha (negative layer count, white matte), then as PSB.
	const pixels = noise(width * height * 4, 7);
	for (let i = 0; i < width * height; i++) pixels[i * 4 + 3] = 255;
	const layer = { name: 'base', canvas: undefined, imageData: { width, height, data: pixels } };
	const opaque = writePsdBuffer({ width, height, imageData: { width, height, data: pixels }, children: [layer] });
	await identical('RGB RLE (ag-psd writer)', new Uint8Array(opaque)); cases.push('RGB RLE');
	const translucent = new Uint8ClampedArray(pixels);
	for (let i = 0; i < width * height; i++) translucent[i * 4 + 3] = i % 7 === 0 ? 0 : i % 5 === 0 ? 255 : (i * 37) & 0xff;
	const withAlpha = { width, height, imageData: { width, height, data: translucent }, children: [{ ...layer, imageData: { width, height, data: translucent } }] };
	await identical('RGBA global alpha (ag-psd writer)', new Uint8Array(writePsdBuffer(withAlpha))); cases.push('global alpha');
	await identical('RGBA PSB (ag-psd writer)', new Uint8Array(writePsdBuffer(withAlpha, { psb: true }))); cases.push('PSB');

	// Minimal writer: raw RGB, grayscale RLE, a fifth (skipped) channel, rows
	// whose runs overshoot the width (clamped, as in ag-psd).
	const plane = (c, y) => noise(width, 1000 * c + y + 1);
	await identical('RGB raw', buildPsd({ width, height, mode: 3, headerChannels: 3, listed: 3, compression: 0, rowBytes: plane }));
	cases.push('raw');
	await identical('grayscale RLE', buildPsd({ width, height, mode: 1, headerChannels: 1, listed: 1, compression: 1, rowBytes: (c, y) => packBits(plane(c, y)) }));
	cases.push('grayscale');
	await identical('RGBA + extra channel', buildPsd({ width, height, mode: 3, headerChannels: 5, listed: 5, compression: 1, rowBytes: (c, y) => packBits(plane(c, y)) }));
	cases.push('extra channel');
	await identical('overlong rows', buildPsd({
		width, height, mode: 3, headerChannels: 3, listed: 3, compression: 1,
		rowBytes: (c, y) => Uint8Array.from([...packBits(plane(c, y)), 0xfe, 9]),
	}));
	cases.push('overlong rows');

	// A short row shifts every later row in ag-psd: the pool must decline.
	const short = buildPsd({
		width, height, mode: 3, headerChannels: 3, listed: 3, compression: 1,
		rowBytes: (c, y) => packBits(c === 1 && y === 700 ? plane(c, y).subarray(1) : plane(c, y)),
	});
	assert.equal(await decodePsdCompositeParallel(short.slice().buffer, wasm), null, 'a short row must decline');
	// Not eligible: 16-bit documents.
	const sixteen = buildPsd({ width, height, mode: 3, headerChannels: 3, listed: 3, compression: 0, rowBytes: plane });
	new DataView(sixteen.buffer).setUint16(22, 16);
	assert.equal(await decodePsdCompositeParallel(sixteen.buffer, wasm), null, '16-bit must decline');

	console.log(`PSD composite pool: identical to ag-psd for ${cases.join(', ')}; short rows and 16-bit decline`);
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
	global.fetch = nativeFetch;
	await Promise.all(workers.map(worker => worker.terminate()));
});
