# Load-performance status and next steps

Handoff notes from the load-speed work on branch `perf/tiff-load-speed`
(2026-10-08/09, five rounds), so later work can resume without rediscovering
the state. Read
`performance-method.md` first; everything here was measured that way: warm
median in a real VS Code (`scripts/benchmark-vscode.mjs`), pixels verified
identical unless stated.

Machine caveat: M1 Pro, 16 GB, heavy swap, and background load averages of
5–16 from system indexers and other builds during most runs. Treat totals as
±15 %; the per-phase `[Perf]` numbers (decode, upload) are steadier than
end-to-end times. Long single-window runs get throttled (see the practical
notes); compare batched runs only.

## Round 5: the remaining idea list, each tried and measured

The machine was busy throughout (load averages 5–40: Spotlight indexing
and the main VS Code window), so numbers are alternating A/B runs of the
same build pair.

| Idea | Outcome | Commit |
| --- | --- | --- |
| ND2/LIF ranged reads | 395 MB ND2: cold 7494 → 442 ms, warm 2667 → 466 ms (1.1 MB read); 605 MB LIF cold 5926 → 952 ms (5 MB, 19 reads); 138 MB ND2 warm 357 → 296 ms | a6fe9e9 |
| CZI detail tiles on the strip pool | 1/4 level 212 → 162 ms, full resolution 229 → 184 ms (1.4 GB: 379 → 203 ms) | a6fe9e9 |
| Native first paint (a6fe9e9), measured | 25 MP PNG webview work 307–344 → 248 ms, total 552–594 → 517–571 ms; large JPEGs unchanged (already lazy) | — |
| DICOM series: prefetch the next slice | one ~10 ms read saved per step | a6fe9e9 |
| Cold opens | see below; the layer compositor worker now starts after the first image (nl_01_depth.tif warm 221–248 → 208–213 ms) | a6fe9e9 |
| Upload before the settings round trip | rejected: the round trip is ~2 ms (`await-settings` is a phase mark covering everything since load start, not a wait) | — |
| EXR streaming into the ZIP pool | rejected: warm opens got slower (303–412 vs 264–286 ms, three rounds); only 14–29 ms of reading remains when the viewer starts, and copying block ranges on the main thread competes with the arriving chunks. Kept as `target/perf-exp/exr-streaming-rejected.patch` (stream plan, block cutter and its exactness test: 21 files identical) | — |
| Statistics while the source arrives | not built: same limit as EXR streaming (the file has mostly arrived before the viewer starts) and it would duplicate the Rust statistics conventions in the bootstrap | — |

Notes:

- **Ranged reads** are generic: Rust `SparseFile` (scientific_common.rs)
  holds the pieces read so far and a decoder that needs more answers
  `[need-range:OFFSET:LENGTH]`; `ranged-source.ts` reads and retries, keeping
  small pieces per file. A Range request through the VS Code webview costs
  ~8 ms; the pushed whole-file read is faster only for small, page-cached
  files, and ranged wins as soon as the file is large or not cached.
- **Cold opens**: resource timings show the extra ~250–300 ms of a first open
  is VS Code creating the webview (time origin 175–199 ms after the host's
  open, against 23–26 ms warm) plus compiling our bundles (~60 ms). The
  extension itself activates on startup, outside the measured path.
- LIF needs one read per memory block header before the plane (no index in
  the format); 19 reads for the 605 MB file. Reading the XML's block sizes
  instead would need the block order, which the format does not promise.

## Round 4: layered documents, DICOM, EXR, TGA/BMP, scrubbing

The machine was too loaded for a full batched corpus run at the end of this
round (load averages 10–16 from an unrelated VS Code window and Spotlight;
one cold open took 90 s), so these are per-file numbers from the commits,
each measured against the build before it.

| Change | Before | After | Commit |
| --- | --- | --- | --- |
| XCF preview (`eagle.layers_2.xcf`): composite in row bands on nested workers, direct RLE tile reads | ~1300 ms | ~510 ms | a6fe9e9 |
| ORA / KRA editable layers (Node decode): row copies, `copyWithin` default fill | ~480 / ~390 ms | ~420 / ~225 ms | a6fe9e9 |
| Collection burst ending on a warm-worker format | 30 s timeout | 80–950 ms | a6fe9e9 (bug) |
| JPEG XL 7.4 MB read (now pushed, also JXR/JP2/ND2/LIF/SDT) | ~46 ms | ~13 ms | a6fe9e9 |
| PSD 5000² canvas upload (`putImageData` at every size) | ~60 ms | ~20 ms | a6fe9e9 |
| DICOM decode, 79 files (8/16-bit lookup table in Rust) | 2167 ms | 919 ms | a6fe9e9 |
| EXR ZIP on the pool for any channel count and type, warm open: RGB 2736² float / RGBA 1600² / 13-channel render | 641 / 223 / 284 ms | 282 / 132 / 172 ms | a6fe9e9 |
| Same, decode only: half-float RGB 2736² | 193 ms | 104 ms | a6fe9e9 |
| DICOM multi-frame step (50 MB MR study, standalone) | ~60 ms | ~21 ms | a6fe9e9 |
| TGA 75 MB (standalone, warm) | ~165 ms | ~125 ms | a6fe9e9 |
| BMP 75 MB (standalone, warm) | ~300 ms | ~140 ms | a6fe9e9 |
| 16-bit PNG in VS Code: duplicate render beside the native first paint | ~530 ms | 0 | a6fe9e9 (bug) |
| CZI 126 MB z-stack (VS Code, warm): reads one plane's subblocks | 330 ms | 137 ms | a6fe9e9 |
| CZI 505 MB / 1.4 GB JPEG XR mosaics | error (plane too large) | ~200–400 ms standalone, overview + detail on zoom | a6fe9e9 |

Notes:

- **Dataset slider scrubbing** (a6fe9e9) was a responsiveness bug rather
  than a decode cost. Every slider step posted `navigateDataset`, and each
  answer started a file load that either terminated the worker busy with
  the previous plane (the next one then paid a cold boot) or queued behind
  it. The plane the slider was dropped on appeared only after every
  intermediate plane. Now one plane request is in flight at a time and the
  newest position waits. DICOM frames of one file also keep the file in
  the decode worker (`cacheSourceInWorker`, as CZI/ND2/LIF/SDT did). Before
  that, every step re-read the whole file, which in VS Code meant a webview
  resource fetch of the full study.
- **Native first paint was never adopted in VS Code** (a6fe9e9).
  `bootstrapImageFor` compared the bootstrap `<img>`'s DOM-normalized
  `src` (`file+.vscode-resource…`) with the host's `Uri.toString()`
  (`file%2B…`), so PNG/JPEG/WebP/AVIF/ICO always decoded a second time
  beside the painted image. The native-display paths had never run in VS
  Code. They are now covered by a standalone simulation
  (`test/web/native-first-paint.spec.ts`: identical readouts) and adoption
  is one-shot.
- **BMP** (24-bit, sRGB/default headers) is always read directly, also
  behind a native first paint: waiting for Chromium's own `<img>` decode
  of a 75 MB BMP took over a second in VS Code.
- The standalone viewer labelled every BMP/AVIF/ICO as WebP (format taken
  from the `blob:` URL); fixed with the BMP change.
- Dataset steps reported their `[Perf]` total from the original file open;
  they now time from the step.

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
- **png 0.18, zune-png**: no gain on 16-bit PNG; serial inflate dominates
  (zune-png retried in round 4: ~15 % on the inflate at best).
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

- **HDR as RGBE expanded in the shader** (idea 1 of round 3): GLSL does not
  promise a correctly rounded `mantissa × scale` (the driver may fuse or
  reorder), so bit-exactness against the CPU decode cannot be guaranteed.
  Shelved unless displayed values may differ in the last ulp.
- **A faster tga-js-style byte loop** for TGA: ~48 ms; whole-word reads via
  `DataView` reach ~30 ms, where the 100 MB output's first-touch page faults
  (~10 ms) are a large share.

## Where the remaining time goes

From `target/perf-exp/corpus6.txt`:

- **Small files (< 2 MB): ~80–110 ms**, nearly all webview creation and
  bundle start (HTML set → iframe navigation ~25 ms → inline scripts
  ~30–45 ms → main bundle `initialize()` ~60 ms). Little left to gain.
- **Large raw arrays (100 MB NPY/PFM/FITS): ~230–290 ms.** The read is now
  ~1 GB/s; statistics (~45–60 ms, serial JS or Rust after the read) and the
  float texture upload (~30–40 ms) remain.
- **XCF: ~510 ms** (was ~1.3 s): the banded composite on 8 workers; the
  per-band work is still JavaScript GIMP adjustments and blending.
- **BMP 75 MB: ~140 ms** in the standalone viewer (direct row read,
  also in VS Code).
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

1. **HDR as RGBE on the GPU** (shelved in round 4, see rejected: exactness
   cannot be guaranteed in GLSL): a 5120² HDR decodes to 314 MB of RGB float
   whose upload alone takes ~125 ms. Uploading the RLE-decoded RGBE bytes
   (4 bytes per pixel) and expanding them in the shader would cut upload and
   pool output to a third. The decoder computes `mantissa × scale[e]` with
   `scale[e] = 2^(e−128) / 255` in f32 (`formats/hdr.rs`), so the shader must
   use the same 256-entry table from the CPU and one f32 multiply, and the
   result must be checked bit for bit against the CPU decode (GLSL does not
   promise correctly rounded arithmetic). The CPU float raster (stats,
   histogram, inspection, measurements) would then be derived lazily — a
   larger change to the HDR processor.
2. **Wide single-channel images** (> MAX_TEXTURE_SIZE): the linear texture
   layout from 842fa80 generalizes to one-channel data.
3. **Cold opens** (mostly outside our control, see round 5): smaller main
   bundle (628 KB) or deferring more of it would trim the ~60 ms compile.
4. **LIF block walk**: if a corpus shows the XML lists memory blocks in file
   order, their sizes would give every block offset in one read.

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
- Browser-only timing without VS Code (useful when VS Code itself is the
  noise): a throwaway Playwright spec under `target/perf-exp/webspec/` that
  opens a file through `#web-file-input` and collects `[Perf]` console
  lines, with `web/playwright.config.ts` reused (`open-one.spec.ts`,
  `dicom-steps.spec.ts`). Use Node 24 first on `PATH`; Homebrew's newer
  Node breaks Playwright's config loader.
- Scientific conformance has two DICOM cases without goldens ("MRT OSG
  Februar 2023 …"); they are pre-existing and fail `test:rust-scientific`
  independently of this work.
