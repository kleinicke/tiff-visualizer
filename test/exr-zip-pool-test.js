/**
 * The EXR ZIP pool (decodeExrZipBlocks) splits a float scanline EXR into
 * block ranges across workers. Through the real worker bundle, its samples
 * must be byte-identical to the single-threaded decode (NaN included) and its
 * min/max must be the finite-only range of those samples. For several
 * channels, each range interleaves the channels decode_exr_fast displays
 * (here R, G, B, A of A/B/G/R/Z, and of half A/B/G/R plus a u32 id), and the
 * ranges' display ranges merge into that decode's range.
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
 // Several channels, decoded in three block ranges like three workers:
 // float RGBA + Z, and half RGBA + a u32 id channel that is not shown.
 const multiSummaries = [];
 for (const multiFile of ['test-samples/exr_zip_rgbaz_f32.exr', 'test-samples/exr_zip_rgba_half_id.exr']) {
  const multi = new Uint8Array(fs.readFileSync(multiFile));
  const multiPlan = wasm.exr_zip_f32_plan(multi);
  assert.ok(multiPlan, `${multiFile}: not eligible for the EXR ZIP pool`);
  const channelNames = Array.from(multiPlan.channel_names);
  const kinds = multiPlan.channel_kinds;
  const selection = multiPlan.selection;
  const displayed = Array.from(multiPlan.displayed_names);
  const width = multiPlan.width, height = multiPlan.height, dataY = multiPlan.data_y;
  const counts = multiPlan.counts, yCoordinates = multiPlan.y_coordinates, compressed = multiPlan.take_compressed();
  multiPlan.free();
  const whole = wasm.decode_exr_fast(multi);
  const wholeData = whole.take_data_as_f32();
  const multiReference = {
   channels: whole.channels, min: whole.data_min, max: whole.data_max,
   names: whole.channel_names_csv.split(','), displayed: whole.displayed_channels_csv.split(','),
  };
  whole.free();
  assert.deepEqual(channelNames, multiReference.names, `${multiFile}: channel names`);
  assert.deepEqual(displayed, multiReference.displayed, `${multiFile}: displayed channels`);
  assert.equal(selection.length, multiReference.channels, `${multiFile}: displayed channel count`);
  const offsets = [];
  for (let i = 0, at = 0; i < counts.length; i++) { offsets.push(at); at += counts[i]; }
  const cuts = [0, 5, 11, counts.length];
  const parts = [];
  let rangeMin = Infinity, rangeMax = -Infinity;
  for (let r = 0; r < 3; r++) {
   const first = cuts[r], last = cuts[r + 1];
   const blob = compressed.slice(offsets[first], offsets[last - 1] + counts[last - 1]);
   const rows = Uint32Array.from({ length: last - first }, (_, i) => Math.min(16, height - (yCoordinates[first + i] - dataY)));
   const part = wasm.decode_exr_zip_f32_blocks_selected(blob, counts.slice(first, last), rows, width, kinds, selection);
   parts.push(part.take_data());
   rangeMin = Math.min(rangeMin, part.min);
   rangeMax = Math.max(rangeMax, part.max);
   part.free();
  }
  const joined = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
  parts.reduce((at, part) => { joined.set(part, at); return at + part.length; }, 0);
  assert.ok(Buffer.from(joined.buffer).equals(Buffer.from(wholeData.buffer, wholeData.byteOffset, wholeData.byteLength)),
   `${multiFile}: selected samples differ from the whole-file decode`);
  assert.ok(Object.is(rangeMin, multiReference.min) && Object.is(rangeMax, multiReference.max),
   `${multiFile}: range ${rangeMin}..${rangeMax}, whole-file ${multiReference.min}..${multiReference.max}`);
  multiSummaries.push(`${displayed.join('')} of ${channelNames.join('')}`);
 }

 console.log(`EXR ZIP pool: ${expected.length} samples identical across ${decoded.workers} workers, range ${min}..${max}; `
  + `${multiSummaries.join(', ')} identical in three ranges`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
 global.fetch = nativeFetch;
 await Promise.all(workers.map(worker => worker.terminate()));
});
