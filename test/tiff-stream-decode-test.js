/**
 * Large TIFFs decode while they are still being read. That relies on two
 * claims, both checked here against the real modules:
 *
 * 1. Once the first IFD and every value it points at have arrived (the prefix
 *    `tiffFirstIfdPrefix` computes), the strip plan, the tag metadata and the
 *    preview gate are exactly what the whole file gives, and "single image"
 *    really means one page. Checked on every TIFF in test-samples.
 * 2. Streaming through the strip pool, with bytes arriving in small chunks,
 *    yields the same samples and planes as decoding the complete file, and a
 *    stream that fails midway falls back (returns null) instead of throwing.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
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

/** The bootstrap's stream object, fed `chunk` bytes per tick; `failAt` aborts the read there. */
function makeStream(file, chunk, failAt = Infinity) {
	const bytes = new Uint8Array(file.length);
	const stream = {
		total: file.length, received: 0, bytes, error: null, waiters: [],
		whenAvailable(end) {
			if (this.error) return Promise.reject(this.error);
			if (this.received >= Math.min(end, this.total)) return Promise.resolve();
			return new Promise((resolve, reject) => this.waiters.push({ end, resolve, reject }));
		},
		settle() {
			const pending = this.waiters;
			this.waiters = [];
			for (const waiter of pending) {
				if (this.error) waiter.reject(this.error);
				else if (this.received >= Math.min(waiter.end, this.total)) waiter.resolve();
				else this.waiters.push(waiter);
			}
		},
	};
	const pump = () => {
		if (stream.received >= failAt) { stream.error = new Error('read failed'); stream.settle(); return; }
		const next = Math.min(stream.total, stream.received + chunk);
		bytes.set(file.subarray(stream.received, next), stream.received);
		stream.received = next;
		stream.settle();
		if (next < stream.total) setTimeout(pump, 0);
	};
	setTimeout(pump, 0);
	return stream;
}

function samePlan(a, b) {
	for (const key of ['width', 'height', 'channels', 'bits_per_sample', 'compression', 'rows_per_strip', 'predictor',
		'sample_format', 'little_endian', 'planar_configuration', 'orientation', 'photometric_interpretation',
		'tile_width', 'tile_length', 'blocks_across', 'blocks_per_unit', 'lerc_additional_compression', 'strip_count']) {
		if (a[key] !== b[key]) return `${key} ${a[key]} != ${b[key]}`;
	}
	if (String(a.offsets) !== String(b.offsets) || String(a.counts) !== String(b.counts)) return 'offsets/counts';
	if (String(a.jpeg_tables) !== String(b.jpeg_tables)) return 'jpeg tables';
	return '';
}

async function main() {
	global.Worker = BrowserWorker;
	global.fetch = async url => String(url).endsWith('stripDecodeWorker.bundle.js')
		? new Response(fs.readFileSync('media/stripDecodeWorker.bundle.js')) : nativeFetch(url);
	const module = await WebAssembly.compile(fs.readFileSync('media/wasm/tiff-wasm.wasm'));
	global.__tiffVisualizerDecoderWarmup = { wasmModulePromise: Promise.resolve(module) };
	const wasm = await import('../media/wasm/tiff-wasm.js');
	await wasm.default({ module_or_path: module });
	const { tiffFirstIfdPrefix, readResponseAsStream } = await import('../out/media/modules/tiff-stream-prefix.js');
	const { tryStripParallelDecode, tryParallelTiffPreview, tryStreamingStripParallelDecode } = await import('../out/media/modules/strip-parallel-decode.js');

	// 1. Prefix equivalence on every TIFF fixture.
	const tiffs = fs.readdirSync('test-samples').filter(name => /\.tiff?$/i.test(name));
	let single = 0;
	for (const name of tiffs) {
		const file = new Uint8Array(fs.readFileSync(path.join('test-samples', name)));
		const stream = makeStream(file, file.length);
		const prefix = await tiffFirstIfdPrefix(stream);
		if (!prefix) continue;
		const head = file.subarray(0, prefix.needed);
		if (prefix.singleImage) {
			single++;
			let pages = 1;
			try { pages = wasm.tiff_page_count(file); } catch { /* unreadable: not a single-image claim to check */ }
			assert.equal(pages, 1, `${name}: prefix says single image, file has ${pages} pages`);
		}
		let full = null;
		try { full = wasm.tiff_float_strip_plan(file); } catch { /* no plan */ }
		let partial = null;
		try { partial = wasm.tiff_float_strip_plan(head); } catch { /* no plan */ }
		assert.equal(!!partial, !!full, `${name}: plan from prefix ${partial ? 'exists' : 'missing'}, from file ${full ? 'exists' : 'missing'}`);
		if (full) {
			const difference = samePlan(partial, full);
			assert.equal(difference, '', `${name}: plan differs (${difference})`);
		}
		const metadata = bytes => { try { const m = wasm.tiff_strip_metadata(bytes); return JSON.stringify([m.page_count, m.photometric_interpretation, m.all_tags_json, m.ome_xml, m.geo_json, m.page_directory_json]); } catch (error) { return 'error'; } };
		if (prefix.singleImage) {
			assert.equal(metadata(head), metadata(file), `${name}: metadata from prefix differs`);
			assert.equal(wasm.tiff_preview_reduction(head), wasm.tiff_preview_reduction(file), `${name}: preview gate differs`);
		}
	}
	assert.ok(single >= 50, `only ${single} single-image fixtures; the walker rejects too much`);

	// 2. Streamed decode equals the whole-file decode.
	const cases = ['test-samples/strip_pool_rgb8.tif', 'test-samples/strip_pool_rgb16_orient3.tif', 'test-samples/strip_pool_rgbf32.tif', 'test-samples/strip_pool_rgb8_orient6.tif'];
	for (const file of cases) {
		const bytes = new Uint8Array(fs.readFileSync(file));
		const reference = await tryStripParallelDecode(bytes.slice().buffer, wasm);
		assert.ok(reference, `${file}: whole-file pool decode declined`);
		let released = 0;
		const streamed = (await tryStreamingStripParallelDecode(makeStream(bytes, 4096), wasm, () => { released++; }))?.strips;
		assert.ok(streamed, `${file}: streaming decode declined`);
		assert.ok(released >= 1, `${file}: stream never released`);
		assert.ok(Buffer.from(streamed.data.buffer).equals(Buffer.from(reference.data.buffer)), `${file}: streamed samples differ`);
		assert.equal(streamed.planes?.length, reference.planes?.length, `${file}: plane count`);
		for (let c = 0; c < (reference.planes?.length || 0); c++) {
			assert.ok(Buffer.from(streamed.planes[c].buffer).equals(Buffer.from(reference.planes[c].buffer)), `${file}: plane ${c} differs`);
		}
		assert.equal(streamed.min, reference.min, `${file}: min`);
		assert.equal(streamed.max, reference.max, `${file}: max`);
		assert.equal(streamed.allTagsJson, reference.allTagsJson, `${file}: tags`);
	}
	// A TIFF too large to display whole streams into its bounded preview.
	{
		const file = 'test-samples/large/preview_pool_f32.tif';
		const bytes = new Uint8Array(fs.readFileSync(file));
		const reference = await tryParallelTiffPreview(bytes.slice().buffer, wasm);
		assert.ok(reference, `${file}: preview pool declined`);
		let released = 0;
		const streamed = (await tryStreamingStripParallelDecode(makeStream(bytes, 2048), wasm, () => { released++; }))?.preview;
		assert.ok(streamed, `${file}: streamed preview declined`);
		assert.ok(released >= 1, `${file}: stream never released`);
		assert.ok(Buffer.from(streamed.data.buffer).equals(Buffer.from(reference.data.buffer)), `${file}: streamed preview differs`);
		for (const key of ['width', 'height', 'min', 'max', 'pageIndex', 'pageCount', 'pageDirectoryJson', 'allTagsJson']) {
			assert.ok(Object.is(streamed[key], reference[key]), `${file}: ${key} differs`);
		}
	}
	const bytes = new Uint8Array(fs.readFileSync(cases[0]));
	let released = 0;
	const failed = await tryStreamingStripParallelDecode(makeStream(bytes, 2048, bytes.length >> 1), wasm, () => { released++; });
	assert.equal(failed, null, 'a failed read must fall back, not produce pixels');
	assert.ok(released >= 1, 'a failed read must still release the stream');
	// 3. The standalone viewer's reader: a response body, in uneven chunks.
	const body = (file, chunk, length = file.length) => {
		let at = 0;
		return new ReadableStream({
			async pull(controller) {
				await new Promise(resolve => setTimeout(resolve, 0));
				if (at >= length) { controller.close(); return; }
				const next = Math.min(length, at + chunk);
				controller.enqueue(file.slice(at, next));
				at = next;
			},
		});
	};
	for (const file of cases) {
		const bytes = new Uint8Array(fs.readFileSync(file));
		const reference = await tryStripParallelDecode(bytes.slice().buffer, wasm);
		const read = readResponseAsStream(body(bytes, 3001), bytes.length);
		const streamed = (await tryStreamingStripParallelDecode(read.stream, wasm, () => {}))?.strips;
		assert.ok(streamed, `${file}: response-stream decode declined`);
		assert.ok(Buffer.from(streamed.data.buffer).equals(Buffer.from(reference.data.buffer)), `${file}: response-streamed samples differ`);
		assert.ok(Buffer.from(await read.done).equals(Buffer.from(bytes)), `${file}: response-streamed source differs`);
	}
	{
		const short = readResponseAsStream(body(bytes, 3001, bytes.length >> 1), bytes.length);
		assert.equal(await tryStreamingStripParallelDecode(short.stream, wasm, () => {}), null, 'a truncated body must fall back');
		await assert.rejects(short.done, /shrank/, 'a truncated body must fail the read');
		const long = readResponseAsStream(body(bytes, 3001), bytes.length - 1);
		await assert.rejects(long.done, /grew/, 'a longer body must fail the read');
	}
	console.log(`TIFF streaming: prefix plan/metadata identical on ${tiffs.length} fixtures (${single} single-image), ${cases.length} streamed decodes (bootstrap and response streams) and a streamed bounded preview identical, failed and truncated reads fall back`);
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
	global.fetch = nativeFetch;
	await Promise.all(workers.map(worker => worker.terminate()));
});
