# TIFF viewport refinement

Generated previews of large stripped float32 grayscale TIFFs now refine with up
to four workers. Each job transfers one compressed strip and invokes the existing
Rust strip decoder. The scene paints missing strips center-first as they arrive;
it no longer waits for an enclosing rectangle or re-decodes cached strips inside
that rectangle. The detail pool is separate from the full-image pool, whose
large WASM heaps are retired after a full-raster decode.

Scene refinement waits 80 ms after the last zoom/pan event (previously 250 ms).
Whole-page level switches retain 250 ms. Superseded jobs stop scheduling work and
discard their results; an already executing synchronous Rust decode finishes.
Queued fallback region jobs also check cancellation before decoding.

Parallel detail currently applies to complete strips from page zero of generated
previews, with at most 8 million samples per strip. Tiled TIFFs, stored local COG
overviews and unsupported layouts/codecs retain the region decoder. Remote COGs
already stream up to four requests. All pyramid scenes get the shorter delay.
Normal full-resolution TIFF loading and the 130 MP preview threshold are unchanged.

## Measurement (2026-09-05)

A real VS Code window opened `nl_01_depth_x4.tif` (20480 × 20480, Deflate,
floating-point predictor 3, 320 strips). After each open, the runner sent six zoom-in
commands as a burst and scraped the extension's `[Refine]` Output line. Times
start at the last refinement scheduling event, so they include the debounce.
`first commit` measures the first canvas update; `visible` measures completion
of the viewport stream followed by a Chromium paint opportunity.

Four opens per build; the first was excluded from warm results:

| Measurement | Before | After |
| --- | --- | --- |
| Cold first commit / complete visible | 1317 / 1338 ms | 244 / 502 ms |
| Warm first commit, median (range), n=3 | 1183 (1054–1567) ms | 400 (397–453) ms |
| Warm complete visible, median (range), n=3 | 1191 (1057–1570) ms | 782 (678–784) ms |
| Regions per viewport | 1 enclosing rectangle | 22 independent strips |

Machine load averages were around 5.3–5.4 immediately before these runs, with
5-minute load near 6. These are directional results under contention, not a
controlled throughput claim. Initial-open time was not optimized by this change.

To repeat after building the extension, put only the sample (or a symlink to it)
in a small benchmark directory:

```sh
BENCH_DIR=/path/to/sample-directory ITER=4 TIFF_PERF_REFINE=1 node scripts/benchmark-vscode.mjs
```

The runner saves cold and individual warm refinement timings in
`benchmark-vscode-result.json`. No timing flag is required in the extension.

## Correctness

`npm run test:tiff-detail-workers` runs the actual browser worker bundle in Node
worker threads. It compares every returned sample to the original region decoder
at concurrency 1, 2, 4 and 8, verifies compressed-strip-only transfers and the
four-worker cap, and checks cancellation and cropped-region fallback. Set
`TIFF_LARGE_SAMPLE` to additionally check the real large file. The checked run
compared 60 regions, all identical. Existing strip conformance tests still cover
the underlying Rust decoder across layouts and worker splits.

The opt-in large-file browser test checks original-value picking before/after
refinement and after repeated zoom changes. It also verifies that the 100 MP
example remains a full-resolution image. No Rust pixel algorithm changed.

## Intermediate generated detail

Generated stripped previews also have display-only 1/4 and 1/2 levels between
1/8 and 1:1. Only visible source strips are decoded; Canvas downsizes their
rendered pixels before the scene retains them. These are not TIFF pages and
never enter the decoder's IFD directory. The source-value cache still receives
original float samples, and the picker continues upgrading to original values.
The 32 MP display-tile budget applies to the reduced canvases, so moderate zoom
no longer falls back to a blurry 1/8 preview solely because full-width original
strips would exceed that budget. Strip boundaries must align to each reduction.
The in-image overlay reports these detail scales; the bottom pixel readout has
no resolution suffix, including while an exact-value upgrade is pending.

Set `TIFF_PERF_REFINE_STEPS=2` with the benchmark's refinement option to measure
a smaller zoom burst (the default remains six commands).

The two-command zoom check on the same 400 MP file completed in real VS Code:
three opens, first discarded, machine load 4.85 before the run. Cold first commit
was 287 ms and complete visible was 1193 ms. The two warm first commits were
219–228 ms; complete visible was 1113–1153 ms, covering 62 reduced strip canvases.
This validates intermediate refinement where the old policy retained the base
preview; it is not a before/after decoder throughput comparison.
