/**
 * The strip pool returns per-channel planes alongside the interleaved buffer
 * for multi-channel images. The workers split their own bands so the main
 * thread only copies; this checks, through the real worker bundle, that every
 * plane is exactly the de-interleaved data and that the data itself matches the
 * single-threaded whole-file decode. Orientation 6 cannot be placed band by
 * band, so it must come back without planes (the caller then splits them).
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
 const { tryStripParallelDecode } = await import('../out/media/modules/strip-parallel-decode.js');
 const cases = [
  { file: 'test-samples/strip_pool_rgb8.tif', planes: true },
  { file: 'test-samples/strip_pool_rgb16_orient3.tif', planes: true },
  { file: 'test-samples/strip_pool_rgbf32.tif', planes: true },
  { file: 'test-samples/strip_pool_rgb8_orient6.tif', planes: false },
 ];
 for (const { file, planes } of cases) {
  const bytes = fs.readFileSync(file);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const result = await tryStripParallelDecode(buffer, wasm);
  assert.ok(result, `${file}: strip pool declined the fixture`);
  assert.ok(result.workers >= 2, `${file}: decoded on ${result.workers} worker(s)`);
  const { data, channels } = result;
  assert.equal(channels, 3, `${file}: channel count`);

  const reference = wasm.decode_tiff(new Uint8Array(bytes));
  const expected = reference.take_data_as_f32();
  reference.free();
  assert.equal(data.length, expected.length, `${file}: sample count`);
  for (let i = 0; i < data.length; i++) {
   if (data[i] !== expected[i] && !(Number.isNaN(data[i]) && Number.isNaN(expected[i]))) assert.fail(`${file}: sample ${i} is ${data[i]}, whole-file decode has ${expected[i]}`);
  }

  if (!planes) {
   assert.equal(result.planes, undefined, `${file}: transposed orientation must not return planes`);
   continue;
  }
  assert.equal(result.planes?.length, channels, `${file}: one plane per channel`);
  const pixels = data.length / channels;
  for (let c = 0; c < channels; c++) {
   const plane = result.planes[c];
   assert.equal(plane.constructor, data.constructor, `${file}: plane ${c} carrier`);
   assert.equal(plane.length, pixels, `${file}: plane ${c} length`);
   for (let i = 0; i < pixels; i++) {
    const value = data[i * channels + c];
    if (plane[i] !== value && !(Number.isNaN(plane[i]) && Number.isNaN(value))) assert.fail(`${file}: plane ${c} pixel ${i} is ${plane[i]}, data has ${value}`);
   }
  }
 }
 console.log(`Strip pool planes: ${cases.length} fixtures match the interleaved data and the whole-file decode`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
 global.fetch = nativeFetch;
 await Promise.all(workers.map(worker => worker.terminate()));
});
