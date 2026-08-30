# How to measure and change performance in this extension

This is the method, not a tour of the tools. It exists because the expensive
mistakes in this codebase have not been slow code — they have been *confident
conclusions from bad measurements*, and correct-looking changes that quietly
altered pixels.

If you are an AI agent working on performance here, read this before touching a
decoder or a render path.

## 1. Measure the number the user sees

Every image load logs one line to the extension's Output channel:

```
[Perf] TIFF: read 142ms | decode 238ms [wasm (8 strip workers)] | stats 20ms | render 99ms | other 8ms | webview 486ms | total 557ms | visible 531ms
```

`visible` uses the same extension-host open timestamp as `total`. It is recorded
after the completed image element has been committed and Chromium has had a
paint opportunity; for the native-image fast path this happens before the full
viewer and picker code starts.

`test/vscode-performance/runner.cjs` boots a real VS Code, opens files, and
**scrapes that same log**. It does not measure anything in parallel with the
extension, so the benchmark and the user can never disagree.

The phases are produced by `PerfTrace.mark()` in
[`media/modules/perf-trace.ts`](../media/modules/perf-trace.ts), which records
wall-clock since the previous mark and then advances. Marks therefore **partition
the timeline**: they are sequential, non-overlapping, and sum exactly to
`webview`. `other` is the remainder, which doubles as a self-check — if a phase
were double-counted the parts would exceed `webview` and `other` would clamp to
zero. `PerfTrace.detail()` records a sub-phase *without* advancing the cursor, so
details must never be summed alongside marks.

`total` uses a different clock (`Date.now()` from the extension host) than
`webview` (`performance.now()` in the webview). `total - webview` is
extension/webview startup, and is approximate.

## 2. Separate cold and warm opens, always

```bash
npm run benchmark:vscode                      # whole corpus
ONLY=nl_01_depth.tif ITER=5 npm run benchmark:vscode
```

The first open of a session pays costs that never recur:

- compiling and instantiating the ~3 MB WASM module
- booting the strip-decode worker pool
- a **per-format, per-size** GPU validation stall: after `texImage2D` the
  renderer calls `gl.getError()`, which synchronously drains the driver. It fires
  only when the pixel count exceeds anything previously validated for that
  texture format (`validatedUploadPixelsByFormat`, module-scoped, so it persists
  for the whole session). On a 10240x10240 float image this alone was 433 ms on
  the first open and 0 ms afterwards.

Sequential opens in one session are therefore **not independent samples**. The
harness reports iteration 1 as cold and the median of iterations 2..N as warm;
never mix cold into the warm median. A true per-file cold comparison requires a
fresh VS Code session with `ONLY=...` for each file. When comparing extensions,
report cold and warm for both, and restrict the corpus to files both decoders
support. A single `[Perf]` line is an anecdote.

## 3. Check the machine before believing a number

Identical builds have produced totals of 1210 ms and 2274 ms on this project
when the machine was at load average 17. Run `uptime` first. If load is above
~5 on a 10-core machine, the numbers are contention and you should say so rather
than attribute the difference to your change.

State sample counts and spreads. "Median of 4 warm runs, 405-493 ms" is a
result; "it got faster" is not.

## 4. Verify pixels, not just speed

**A change that is 3x faster and 0.001% wrong is a bad change.**

```bash
npm run build:wasm && mkdir -p /tmp/ref && cp media/wasm/tiff-wasm.* /tmp/ref/
# ...make the change, rebuild...
node scripts/compare-wasm-builds.mjs --old /tmp/ref test-samples/*.tif
```

`scripts/compare-wasm-builds.mjs` decodes with two WASM builds in one process
and compares every sample (NaN equal to NaN — it is a legitimate value in
scientific data). Things this caught that no timing number and no existing test
would have:

- a strip path that returned **a quarter of the samples** for 16-bit floats,
  because widening a shared plan let a shape reach a reassembly that read
  big-endian f32/f64
- a **+/-1 shift in JPEG output** from enabling `simd128`, because LLVM
  autovectorized zune-jpeg's scalar IDCT differently

For parallel work, verify the *split* as well as the total: decode whole-image,
then decode as 1, 2, 4 and 8 ranges, and require all of them identical. A range
bug that only appears at 8 workers will not show up at 1.

Then run the **full** suite, not the fast subset:

```bash
npm run test
```

`test:wasm` + `test:formats` + `test:behavior` all passing is not the same thing.
The golden snapshots under `test/goldens/` (see `scripts/capture-goldens.js`)
are what caught the JPEG shift, and they only run under `npm run test`.

## 5. Re-capture a golden only as a decision

Goldens freeze "whatever the decoder currently outputs". Re-capturing one asserts
that the new output is acceptable — that is a judgement about the data, not a
routine refresh. Say what changed and why it is acceptable before doing it, and
check how many goldens moved: if a JPEG change rewrites one of 140, that
one-line diff is itself evidence the blast radius is what you claimed.

## 6. Profile before optimizing, and re-profile after

Set `DETAILED_PERF_TRACING = true` in `media/modules/perf-trace.ts`, rebuild, and
every load emits its full phase trace. **Set it back to `false` when done.**

Optimizing the wrong phase is the default failure mode. In this project decode
went from 82-86% of a load to 17-50%, at which point further decoder work had
poor leverage and the remaining time was file reading and GPU upload. Findings
that only appeared in a trace:

- the webview resource protocol reads at 330-500 MB/s against 3125 MB/s from
  disk — and no JavaScript-side API (`arrayBuffer`, streaming, XHR) changes it,
  so it is a transport limit, not a code limit
- integer images were rendering on the CPU because `isFloat` was passed to
  `canRender()` but not to `render()`, and the format chooser treats a *missing*
  value as float
- interleaved data was being split into planes and immediately re-interleaved,
  because the carrier type did not match what the renderer expected

Note the shape of the last two: both were a **type or property mismatch causing a
silent fallback**, not slow algorithms. Look for those first.

## 7. Amdahl is the honest answer

When decode is 85% of a load, a 3x decode win is a 2.3x total win. When decode is
30%, the same 3x win is barely visible. Report the phase budget, not just the
headline, and say plainly when a subsystem has stopped being the bottleneck.

## Tools

| Command | What it does |
| --- | --- |
| `npm run benchmark:vscode` | One build, whole corpus, per-phase medians in a real VS Code |
| `npm run benchmark:vscode:ab` | Current tree vs a baseline commit, alternating |
| `npm run benchmark:corpus` | Rebuild the benchmark corpus + `manifest.json` |
| `node scripts/compare-wasm-builds.mjs --old <dir> <files...>` | Sample-by-sample decoder comparison |
| `npm run test` | Everything, including goldens |

The corpus (`scripts/benchmark-corpus.mjs`) is grouped deliberately: a
depth-family group where every file is the same scene re-encoded (rows are
comparable), a containers group (coverage, not comparison), and a codecs group
of sub-MB files where totals are dominated by fixed overhead. Comparing across
groups is meaningless.

**Decode cost tracks sample count, not file size.** A 1.2 MB 8-bit RGB file holds
78.6M samples; a 14.4 MB uint16 file holds 26.2M. Twelve times the file size, a
third of the work.
