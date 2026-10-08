/**
 * TIFFs too large to display whole open on a bounded preview: a nearest-sample
 * overview plus the full-image finite range. tryParallelTiffPreview decodes it
 * across the strip pool, each worker reading its own tiles; through the real
 * worker bundle it must reproduce decode_tiff_preview exactly (pixels, range,
 * the generated overview directory and the tags).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
async function main() {
 global.Worker = BrowserWorker;
 global.fetch = async url => String(url).endsWith('stripDecodeWorker.bundle.js')
  ? new Response(fs.readFileSync('media/stripDecodeWorker.bundle.js')) : nativeFetch(url);
 const module = await WebAssembly.compile(fs.readFileSync('media/wasm/tiff-wasm.wasm'));
 global.__tiffVisualizerDecoderWarmup = { wasmModulePromise: Promise.resolve(module) };
 const wasm = await import('../media/wasm/tiff-wasm.js');
 await wasm.default({ module_or_path: module });
 const { tryParallelTiffPreview } = await import('../out/media/modules/strip-parallel-decode.js');

 const file = 'test-samples/large/preview_pool_f32.tif';
 const bytes = new Uint8Array(fs.readFileSync(file));
 assert.ok(wasm.tiff_preview_reduction(bytes) > 0, `${file}: no bounded preview route`);
 const preview = await tryParallelTiffPreview(bytes.slice().buffer, wasm);
 assert.ok(preview, `${file}: pool declined the preview`);

 const reference = wasm.decode_tiff_preview(bytes);
 const expected = reference.take_data_as_f32();
 assert.equal(preview.width, reference.width, 'width');
 assert.equal(preview.height, reference.height, 'height');
 assert.ok(Object.is(preview.min, reference.min_value), `min ${preview.min} != ${reference.min_value}`);
 assert.ok(Object.is(preview.max, reference.max_value), `max ${preview.max} != ${reference.max_value}`);
 assert.equal(preview.pageDirectoryJson, reference.page_directory_json, 'overview directory');
 assert.equal(preview.allTagsJson, reference.all_tags_json, 'tags');
 assert.equal(preview.pageIndex, 1, 'opens on the generated overview page');
 assert.equal(preview.pageCount, 2, 'source page plus generated overview');
 reference.free();
 assert.ok(Buffer.from(preview.data.buffer, preview.data.byteOffset, preview.data.byteLength)
  .equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength)), `${file}: preview pixels differ`);

 // A TIFF small enough to display whole has no preview route.
 const small = fs.readFileSync('test-samples/strip_pool_rgbf32.tif');
 assert.equal(await tryParallelTiffPreview(small.buffer.slice(small.byteOffset, small.byteOffset + small.byteLength), wasm), null, 'small TIFF');
 console.log(`TIFF preview pool: ${preview.width}x${preview.height} preview identical, range ${preview.min}..${preview.max}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
 global.fetch = nativeFetch;
 await Promise.all(workers.map(worker => worker.terminate()));
});
