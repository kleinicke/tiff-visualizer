/**
 * The webview bootstrap transfers the file to the decode worker WITHOUT keeping
 * a copy, and relies on the worker to hand its untouched input back as
 * `sourceBuffer` when asked (`returnSource`). TIFF page navigation and every
 * decoder fallback read those bytes afterwards, so they must come back intact,
 * on both the strip-pool route and an ordinary decode, and only when asked.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Worker } = require('node:worker_threads');

function startWorker() {
	const source = `import { parentPort } from 'node:worker_threads';
		globalThis.self = { postMessage: (data, transfer) => parentPort.postMessage(data, transfer) };
		${fs.readFileSync('media/decodeWorker.bundle.js', 'utf8')}
		parentPort.on('message', data => self.onmessage({ data }));`;
	return new Worker(new URL('data:text/javascript;base64,' + Buffer.from(source).toString('base64')));
}

function request(worker, message, transfer) {
	return new Promise((resolve, reject) => {
		const onMessage = data => {
			const wanted = message.type === 'init' ? data?.type === 'ready' : data?.id === message.id;
			if (!wanted) { return; }
			worker.off('message', onMessage);
			resolve(data);
		};
		worker.on('message', onMessage);
		worker.once('error', reject);
		worker.postMessage(message, transfer);
	});
}

async function main() {
	const worker = startWorker();
	try {
		const module = await WebAssembly.compile(fs.readFileSync('media/wasm/tiff-wasm.wasm'));
		const ready = await request(worker, { type: 'init', tiffWasmModule: module });
		assert.equal(ready.caps?.tiffWasm, true, 'decode worker booted without WASM');

		const cases = [
			// A pool-eligible file: the worker only plans and defers.
			{ file: 'test-samples/strip_pool_rgb8.tif', deferred: true },
			// A small file the worker decodes itself.
			{ file: 'test-samples/pred_ref_f32.tif', deferred: false },
			// A large HDR goes to the page's scanline pool.
			{ file: 'test-samples/hdr_pool_rgb.hdr', deferred: true },
		];
		let id = 1;
		for (const { file, deferred } of cases) {
			const original = new Uint8Array(fs.readFileSync(file));
			for (const returnSource of [true, false]) {
				const buffer = original.slice().buffer;
				const hdr = file.endsWith('.hdr');
				const response = await request(worker, {
					id: id++, format: hdr ? 'hdr' : 'tiff', buffer,
					options: hdr ? { preferParallelHdr: true, returnSource } : { preferParallelTiff: true, returnSource },
				}, [buffer]);
				assert.equal(response.ok, true, `${file}: ${response.error}`);
				assert.equal(!!(hdr ? response.result?.deferToParallelHdr : response.result?.deferToParallelTiff), deferred, `${file}: parallel route`);
				if (!returnSource) {
					assert.equal(response.sourceBuffer, undefined, `${file}: source returned unasked`);
					continue;
				}
				assert.ok(response.sourceBuffer instanceof ArrayBuffer, `${file}: source not returned`);
				assert.ok(Buffer.from(response.sourceBuffer).equals(Buffer.from(original)), `${file}: returned source differs from the input`);
			}
		}
		console.log(`Decode worker returns the untouched source on request (${cases.length} files: TIFF and HDR, deferred and decoded)`);
	} finally {
		await worker.terminate();
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
