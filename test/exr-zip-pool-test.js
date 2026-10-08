/**
 * The EXR ZIP pool (decodeExrZipBlocks) splits a one-channel float scanline
 * EXR into block ranges across workers. Through the real worker bundle, its
 * samples must be byte-identical to the single-threaded decode (NaN included)
 * and its min/max must be the finite-only range of those samples.
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
 const { decodeExrZipBlocks } = await import('../out/media/modules/strip-parallel-decode.js');

 const file = 'test-samples/exr_zip_pool_f32.exr';
 const bytes = new Uint8Array(fs.readFileSync(file));
 const plan = wasm.exr_zip_f32_plan(bytes);
 assert.ok(plan, `${file}: not eligible for the EXR ZIP pool`);
 const decoded = await decodeExrZipBlocks({
  width: plan.width,
  height: plan.height,
  dataY: plan.data_y,
  counts: plan.counts,
  yCoordinates: plan.y_coordinates,
  compressed: plan.take_compressed(),
 });
 plan.free();
 assert.ok(decoded, `${file}: pool declined the plan`);
 assert.ok(decoded.workers >= 2, `${file}: decoded on ${decoded.workers} worker(s)`);

 const reference = wasm.decode_exr_fast(bytes);
 const expected = reference.take_data_as_f32();
 reference.free();
 assert.equal(decoded.data.length, expected.length, `${file}: sample count`);
 assert.ok(Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength)
  .equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength)), `${file}: samples differ from the whole-file decode`);

 let min = Infinity;
 let max = -Infinity;
 for (const value of expected) {
  if (Number.isFinite(value)) {
   if (value < min) min = value;
   if (value > max) max = value;
  }
 }
 assert.equal(decoded.min, min, `${file}: min`);
 assert.equal(decoded.max, max, `${file}: max`);
 console.log(`EXR ZIP pool: ${expected.length} samples identical across ${decoded.workers} workers, range ${min}..${max}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
 global.fetch = nativeFetch;
 await Promise.all(workers.map(worker => worker.terminate()));
});
