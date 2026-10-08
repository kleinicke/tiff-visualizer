/**
 * Large Radiance HDR files decode as scanline ranges across the strip pool
 * (decodeHdrParallel): the scanlines are planned once, then each worker
 * decodes its own range. Through the real worker bundle the samples must be
 * byte-identical to the single-threaded decode, with the same header values.
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
 const { decodeHdrParallel } = await import('../out/media/modules/strip-parallel-decode.js');

 const file = 'test-samples/hdr_pool_rgb.hdr';
 const bytes = new Uint8Array(fs.readFileSync(file));
 const source = bytes.slice().buffer;
 const decoded = await decodeHdrParallel(source, wasm);
 assert.ok(decoded, `${file}: pool declined the file`);
 assert.ok(decoded.workers >= 2, `${file}: decoded on ${decoded.workers} worker(s)`);
 assert.ok(Buffer.from(source).equals(Buffer.from(bytes)), `${file}: the pool modified its source`);

 const reference = wasm.decode_hdr_fast(bytes);
 const metadata = reference.take_metadata_as_f64();
 const expected = reference.take_data_as_f32();
 const tags = reference.all_tags_json;
 reference.free();
 assert.equal(decoded.width, metadata[0], `${file}: width`);
 assert.equal(decoded.height, metadata[1], `${file}: height`);
 assert.equal(decoded.exposure, metadata[2], `${file}: exposure`);
 assert.equal(decoded.gamma, metadata[3], `${file}: gamma`);
 assert.equal(decoded.allTagsJson, tags, `${file}: header tags`);
 assert.equal(decoded.data.length, expected.length, `${file}: sample count`);
 assert.ok(Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength)
  .equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength)), `${file}: samples differ from the whole-file decode`);

 // Below the size gate the pool declines and the caller decodes whole.
 const small = fs.readdirSync('test-samples').find(name => name.endsWith('.hdr') && name !== 'hdr_pool_rgb.hdr');
 if (small) {
  const smallBytes = fs.readFileSync(`test-samples/${small}`);
  assert.equal(await decodeHdrParallel(smallBytes.buffer.slice(smallBytes.byteOffset, smallBytes.byteOffset + smallBytes.byteLength), wasm), null, `${small}: small file must not use the pool`);
 }
 console.log(`HDR pool: ${expected.length} samples identical across ${decoded.workers} workers`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
 global.fetch = nativeFetch;
 await Promise.all(workers.map(worker => worker.terminate()));
});
