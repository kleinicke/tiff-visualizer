# Load-performance status and next steps

Handoff notes from the load-speed work on branch `perf/tiff-load-speed`
(2026-10-08, three rounds), so later work can resume without rediscovering
the state. Read
`performance-method.md` first; everything here was measured that way: warm
median in a real VS Code (`scripts/benchmark-vscode.mjs`), pixels verified
identical unless stated.

Machine caveat: M1 Pro, 16 GB, heavy swap, and background load averages of
5–16 from system indexers and other builds during most runs. Treat totals as
±15 %; the per-phase `[Perf]` numbers (decode, upload) are steadier than
end-to-end times. Long single-window runs get throttled (see the practical
notes); compare batched runs only.

## Round 3: transport, PSD, layered PNGs (warm, batched corpus)

`target/perf-exp/corpus3.txt` (start of round 3) against
`target/perf-exp/corpus6.txt` (end), same 49 files:

| File | Before | After | Main change |
| --- | --- | --- | --- |
| PSD 152 MB (`eagle_af_5k.psd`) | 790 ms | ~405 ms | pushed source, composite on the strip pool |
| KRA 7.4 MB | 333 ms | ~149 ms | embedded PNGs in Rust (decode 198 → ~55 ms) |
| ORA 6.4 MB | 278 ms | ~153 ms | embedded PNGs in Rust (decode 145 → ~70 ms) |
| PPM 16-bit 150 MB | 575 ms | ~256 ms | pushed source |
| NPZ 100 MB | 738 ms | ~223 ms | pushed source, no main-thread fallback |
| NPY / PFM 100 MB | 373 / 352 ms | ~228 / ~230 ms | pushed source |
| FITS 100 MB | 376 ms | ~293 ms | pushed source |
| TGA 75 MB | 353 ms | ~224 ms | pushed source |
| TIFF float 100 MB (`pred1_f32_none.tif`) | 355 ms | ~259 ms | pushed source (still streamed into the pool) |
| CZI 87 MB | 292 ms | ~222 ms | pushed source |
| HDR 21 MB | 440 ms | ~383 ms | pushed source |
| PGM 50 MB | 203 ms | ~157 ms | pushed source |

Small files (< 2 MB) are unchanged at ~80–110 ms; their time is webview and
bundle startup.

Collection switches (arrow keys through a folder collection; measured with a
temporary next-image command, three rounds over six 44–150 MB files):

| File | Read: fetch → pushed | Switch total: fetch → pushed |
| --- | --- | --- |
| FITS 100 MB | 208–427 → 102–127 ms | 288–561 → 198–236 ms |
| PFM 100 MB | 202–765 → ~100 ms | 277–844 → ~180 ms |
| PPM 16-bit 150 MB | ~300 → 124–148 ms | 389–505 → 217–370 ms |
| EXR 44 MB | 86–147 → 49–67 ms | 206–348 → 177–251 ms |

With the next image prefetched (eac2323) the same switches take ~95–140 ms
(read ~0 ms), except the first one after opening the collection.

## Rounds 1–2: what improved (warm opens unless noted)

| Format / case | Before | After | Main change |
| --- | --- | --- | --- |
| TIFF 8-bit RGB, predictor 2, deflate (`pred2_rgb8_deflate.tif`) | 394 ms | ~190 ms | zune-inflate, strip-pool planes, packed RGB upload |
| TIFF 100 MP float (`pred1_f32_none.tif`) | 1054 ms | ~480 ms | streamed decode into the strip pool while reading |
| TIFF `nl_01_depth.tif` | 329 ms | ~209 ms | streaming + pool |
| TIFF 20480² bounded preview | ~23 s | ~0.67 s | preview decoded on the pool, streamed |
| Tiled JPEG (YCbCr) TIFF 8192² | 5.5 s (geotiff.js) | ~0.8 s | Rust block decode, pool ranges |
| 10000² palette/RGB TIFF via decode worker | 1330 ms | ~744 ms | Rust plane split (453 → 0 ms), linear RGBA texture (upload 302 → 117 ms) |
| Predictor 3 float decode | — | 1.5–1.65x | SIMD prefix sum + plane transpose to LE |
| Deflate strips | — | 1.13–1.39x | zune-inflate one-shot, flate2 fallback |
| Radiance HDR (21 MB) | 591 ms | ~306 ms | GPU render of RGB, scanline ranges on the pool |
| EXR ZIP (workers) | ~95 ms | ~63 ms | block statistics in Rust |
| FITS 100 MB | 449 ms | ~374 ms | byte-swap fast path, vectorized stats (decode 103 → 28 ms) |
| NPY 100 MB | 383 ms | ~339 ms | vectorized stats, fast JS scan (decode 78 → 15 ms) |
| PPM 16-bit | — | decode 309 → 39 ms | vectorized stats |
| ORA (and anything opened after a layered file) | 2008 ms | ~254 ms | layered decode worker was never started |
| XCF (Node, decode only) | 1548 ms | ~1158 ms | dead composite removed, allocation-free hue/sat |
| JPEG XL lossless 640×480 | ~247 ms (4 files) | ~242 ms | jxl-rs 0.7 (marginal, kept for upstream fixes) |

Commits (oldest first): 1f762cf (codecs, strip pool, packed RGB upload),
2d98ed2 (TIFF streaming), 1ce9ea5 (HDR/FITS/NPY/PPM/EXR), 842fa80 (bounded
previews, tiled JPEG, Rust planes, wide RGB textures), 02d3586 (layered
documents), 519d6c3 (jxl-rs 0.7), 99aec9c (pushed sources), eac2323
(collection push and prefetch), 6067735 (PSD composite pool), b71ec83
(layered PNGs in Rust). Each has its own regression
test (`test:strip-pool-planes`, `test:exr-zip-pool`, `test:hdr-pool`,
`test:tiff-preview-pool`, `test:tiff-jpeg-tiled`, `test:tiff-stream-decode`,
`test:decode-worker-return-source`, `test:tiff-result-planes`, the
`webgl2-float-renderer-packed` Playwright spec, `test:source-push`,
`test:decode-worker-boot-race`, `test:psd-composite-pool`,
`test:png-rgba8`, `test:pushed-source`).

### How the pushed source works (99aec9c, eac2323)

For local files of 1 MB or more in formats the bootstrap reads whole, the
page's bootstrap script requests the source (`sourceRequest` with its page
token and the offset it has), and the host reads it with Node and posts
8 MB `sourceChunk` messages (`src/imagePreview/source-push.ts`). The
bootstrap assembles them into one buffer, which large TIFFs also stream
from. Without a chunk for 5 s it asks again from the first missing byte;
after three tries or an error chunk it fetches the resource URI as before.
Remote and browser hosts keep fetching. The webview channel then runs at
~1 GB/s instead of ~520 MB/s. Pushing right after setting the HTML instead
of on request lost chunks about once in 20 opens (a 20 s stall); do not go
back to that.

Collection switches use the same host side. `switchToImage` carries an offer
(token and size); `media/modules/pushed-source.ts` requests it only when a
processor reads the source (`DecodeWorkerClient.fetchArrayBuffer`), so an
image served from the viewer's cache costs no read, and every newer switch
or aborted load cancels the request in flight. After each switch the host
also offers the next image in the direction of travel (≤ 256 MB, with size
and mtime, `prefetchSource`); the viewer requests it once the current image
has loaded, and a switch to that unchanged file uses it. Only one request
may run at a time, since each replaces the host's previous push; the module
keeps a prefetch claimed by a switch apart from the next offer, which
arrives before the switch reads its source.

## Tried and rejected (do not repeat without a new angle)

- **wasm-opt -O3/-O4**: no speed change, only −9 % size.
- **png 0.18, zune-png**: no gain on 16-bit PNG; serial inflate dominates.
- **zlib-rs**: same speed as zune-inflate, +39 KB.
- **JIT warm-up of workers**: halves the first decode in Node, no effect in
  the VS Code webview.
- **6 instead of 8 pool workers**: no gain.
- **Specialized Rust plane split variants**: slower than the generic one.
- **PSD composite outside ag-psd**: tried twice, in Rust and as a tight
  byte-exact JavaScript PackBits decoder (it must reproduce ag-psd quirks: the
  output position runs on across rows, white-matte removal with global alpha).
  Both run at ~270 ms against ag-psd's ~255 ms. Strided 4-channel byte writes
  over 100 MB dominate. Only parallel decoding would help (see below).
- **Exact fmod removal in XCF hue/saturation**: bit-exact but no measurable
  change. The XCF cost is 9 GIMP filters × 2.56 M pixels at ~13 ns per call.
- **Pushing the source later** (after the viewer asks for initial data):
  the bundle loads faster but the data then arrives later; same totals. The
  webview channel is the bottleneck either way.
- **One posted buffer instead of 8 MB chunks**: same speed for 100 MB, slower
  for 150 MB, and no streaming. 2 and 32 MB chunks: no difference.
- **Per-format settings for the bootstrap's `computeStats`** (NPY after a
  gamma-mode file): no measurable change.
- **Faster JS finite min/max** (4 accumulators, poisoned-sum finiteness):
  60 → 44–51 ms per 25 M floats in Node; the scan is near memory-bound in
  JS. WASM SIMD would first copy 100 MB in. Not worth it alone.
- **Lazy pixel readback for 8-bit PNG** like large JPEGs: would save
  ~300 ms of `getImageData` for a 25 MP PNG (visible is already ~110 ms),
  but the measurement source never materializes a lazy image (large JPEGs
  already have no measurement source), so it would regress measurements.
  A worker-side `createImageBitmap` + `OffscreenCanvas` readback keeps the
  data but needs proof that alpha PNGs read back identically.

## Where the remaining time goes

From `target/perf-exp/corpus6.txt`:

- **Small files (< 2 MB): ~80–110 ms**, nearly all webview creation and
  bundle start (HTML set → iframe navigation ~25 ms → inline scripts
  ~30–45 ms → main bundle `initialize()` ~60 ms). Little left to gain.
- **Large raw arrays (100 MB NPY/PFM/FITS): ~230–290 ms.** The read is now
  ~1 GB/s; statistics (~45–60 ms, serial JS or Rust after the read) and the
  float texture upload (~30–40 ms) remain.
- **XCF: ~1.3 s**, unchanged: JavaScript compositing of GIMP adjustments
  (`applyAdjustmentPixel` ~330 ms per decode), the composite itself
  (~450 ms over several functions) and tile decoding (~215 ms).
- **BMP 75 MB: ~490 ms** (visible at ~200 ms): browser decode, then
  `drawImage` + `getImageData` on the main thread.
- **HDR 21 MB: ~380 ms**: decoding is ~100 ms on the pool; uploading
  5120² × RGB float (314 MB) takes ~125 ms and cannot shrink without
  changing the displayed precision.
- **Very large TIFFs** (`nl_01_depth_x2.tif`, 10240² float): pool decode
  ~155 ms, assembly ~50 ms, upload ~125 ms: proportional to the data.
- **16-bit PNG: ~430 ms** total, visible at ~70 ms (progressive native first).
- **NPZ/decode-worker latency**: the decode request sometimes waits 20–150 ms
  in the worker's queue (`xp-post-to-recv`); seen only under memory
  pressure, also before this work.
- **Third visit in a collection**: cycling six 100 MB files, the third visit
  of NPY/PPM decodes in ~330/190 ms instead of ~60 ms (the JS scan itself,
  in the worker), with fetch and push alike. Node repeats it in 57–73 ms;
  likely memory pressure from the viewer's cached decodes (several 100 MB
  images) on this swapping machine.

## Ideas with potential, roughly by expected value

1. **HDR as RGBE on the GPU**: a 5120² HDR decodes to 314 MB of RGB float
   whose upload alone takes ~125 ms. Uploading the RLE-decoded RGBE bytes
   (4 bytes per pixel) and expanding them in the shader would cut upload and
   pool output to a third. The decoder computes `mantissa × scale[e]` with
   `scale[e] = 2^(e−128) / 255` in f32 (`formats/hdr.rs`), so the shader must
   use the same 256-entry table from the CPU and one f32 multiply, and the
   result must be checked bit for bit against the CPU decode (GLSL does not
   promise correctly rounded arithmetic). The CPU float raster (stats,
   histogram, inspection, measurements) would then be derived lazily — a
   larger change to the HDR processor.
2. **Statistics while the source arrives**: chunks reach the bootstrap
   before the viewer is ready; a worker could compute finite min/max of
   NPY/PFM/FITS float data per chunk. ~45–60 ms per 100 MB.
3. **XCF compositing in parallel**: every adjustment and blend is
   per-pixel, so row bands could be composited on several workers (the
   layered worker would need its own pool). The compositor is shared with
   PSD/ORA/KRA reconstruction, so exactness tests must cover all four.
4. **BMP/TGA in Rust on a worker**: uncompressed BMP is a row copy with
   BGR→RGB; TGA decodes on the main thread in tga-js (~100 ms for 75 MB).
   Moving TGA to the fast-raw worker is the cheap half.
5. **Upload before the settings round trip**: for big float textures the
   upload (~125 ms for 314 MB) could start when the decode finishes, not
   after the host's settings arrive; the texture does not depend on them.
6. **EXR streaming**: the ZIP block pool exists; feeding it from the pushed
   stream like TIFF would overlap decode and read.
7. **Wide single-channel images** (> MAX_TEXTURE_SIZE): the linear texture
   layout from 842fa80 generalizes to one-channel data.
8. **Cold opens**: the first open of a format per session pays for worker
   and WebAssembly compilation (PSD cold ~800 ms vs warm ~405 ms). VS Code
   webview resources are probably not code-cached; worth checking whether
   `compileStreaming` responses can be cached at all there.

## Practical notes for the next session

- Build: `export PATH=$HOME/.cargo/bin:/opt/homebrew/bin:$HOME/.nvm/versions/node/v24.19.0/bin:$PATH`;
  `npm run compile` rebuilds all three WASM modules (wasm-pack is now the arm64
  Homebrew build). `npm run compile:quick` for TS-only changes.
- Single-file trace: `ONLY=<file> ITER=4 node scripts/benchmark-vscode.mjs`
  (set `DETAILED_PERF_TRACING = true` in `media/modules/perf-trace.ts` for
  phase details, never commit it). `BENCH_DIR=<dir>` for other folders.
  `KEEP_TEMP=1` keeps the run's VS Code profile and logs (deleted otherwise;
  they used to pile up at 20–140 MB each).
- Whole corpus: `caffeinate -d -i env BATCH=7 ITER=3 node
  scripts/benchmark-vscode.mjs` (a fresh window per 7 files). One long
  window gets throttled after a few minutes (visible ~700 ms / ~1.7 s on
  every file, even 0.1 MB WebPs) and its numbers are worthless.
- Verifying a pushed source: temporarily hash the assembled buffer in the
  bootstrap and print it in the `[Perf]` label; compare with a Node hash of
  the file.
- Benchmarking collection switches: nothing triggers a switch from outside
  the webview, so temporarily register a command calling
  `activePreview.toggleToNextImage()` (never commit it) and drive it with a
  runner like `target/perf-exp/runner-switch.cjs` (opens a collection with
  `browseAndAddToCollection`, then steps through it and prints each
  switch's new `[Perf]` lines).
- Node profiling of JS decoders: `node --cpu-prof` on a small driver script
  importing `out/media/modules/*.js`. Unstripped WASM with symbols is in
  `wasm/*/pkg/*_bg.wasm` after a build.
- Scientific conformance has two DICOM cases without goldens ("MRT OSG
  Februar 2023 …"); they are pre-existing and fail `test:rust-scientific`
  independently of this work.
