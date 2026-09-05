/** Exercise the real worker bundle and orchestration, including transfers and cancellation. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Worker } = require('node:worker_threads');
const workers = [];
const nativeFetch = global.fetch;
let jobs = 0;
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
 postMessage(data, transfer) {
  if (data.blob) {
   jobs++;
   assert.equal(data.blob.byteLength, new Uint32Array(data.counts)[0], 'transfer exactly one compressed strip');
  }
  this.worker.postMessage(data, transfer);
 }
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
 const { tryParallelTiffDetail } = await import('../out/media/modules/strip-parallel-decode.js');
 // Small normal fixture covers the protocol without making CI allocate a large image.
 // Optional real sample additionally exercises floating-point predictor 3 on 400 MP.
 const files = ['test-samples/pred_ref_f32.tif', 'test-samples/deflate_pred3_f32.tif', 'test-samples/zstd_pred3_f32.tif', process.env.TIFF_LARGE_SAMPLE].filter(file => file && fs.existsSync(file));
 if (!files.length) throw new Error('No detail fixture');
 let checked = 0;
 for (const file of files) {
  const bytes = fs.readFileSync(file);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const plan = wasm.tiff_float_strip_plan(bytes);
  if (!plan || plan.tile_width || plan.sample_format !== 3 || plan.bits_per_sample !== 32 || plan.channels !== 1) {
   plan?.free(); continue;
  }
  const decoder = new wasm.TiffRegionDecoder(bytes);
  const count = Math.ceil(plan.height / plan.rows_per_strip);
  const indices = [...new Set([0, Math.floor(count / 2), count - 1])];
  for (const concurrency of [1, 2, 4, 8]) {
   const requests = Array.from({ length: concurrency }, (_, index) => {
    const y = indices[index % indices.length] * plan.rows_per_strip;
    return { x: 0, y, width: plan.width, height: Math.min(plan.rows_per_strip, plan.height - y) };
   });
   const results = await Promise.all(requests.map(rect => tryParallelTiffDetail(buffer, wasm, rect)));
   results.forEach((result, index) => {
    const rect = requests[index];
    assert.ok(result);
    const reference = decoder.decode(0, rect.x, rect.y, rect.width, rect.height);
    assert.deepEqual(result.data, reference.take_data_as_f32(), `${file}: ${concurrency} concurrent regions`);
    reference.free(); checked++;
   });
  }
  const rect = { x: 0, y: 0, width: plan.width, height: Math.min(plan.rows_per_strip, plan.height) };
  const before = jobs;
  assert.equal(await tryParallelTiffDetail(buffer, wasm, rect, AbortSignal.abort()), null);
  assert.equal(jobs, before, 'cancelled work is never dispatched');
  assert.equal(await tryParallelTiffDetail(buffer, wasm, { ...rect, x: 1, width: rect.width - 1 }), null);
  const controller = new AbortController();
  const pending = tryParallelTiffDetail(buffer, wasm, rect, controller.signal);
  await Promise.resolve(); // Let the warm pool dispatch before cancellation.
  controller.abort();
  assert.equal(await pending, null, 'cancellation after dispatch drops the result');
  decoder.free(); plan.free();
 }
 assert.ok(checked > 0);
 assert.ok(workers.length <= 4, 'detail pool remains bounded');
 console.log(`Detail workers: ${checked} regions identical, concurrency 1/2/4/8, cancellation and fallback passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
 global.fetch = nativeFetch;
 await Promise.all(workers.map(worker => worker.terminate()));
});
