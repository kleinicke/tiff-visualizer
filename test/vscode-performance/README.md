# Decoder performance tests

> Method, conventions and the traps: **[docs/performance-method.md](../../docs/performance-method.md)**.

## Single-build profiling

```bash
npm run benchmark:vscode                          # whole corpus
ONLY=nl_01_depth.tif ITER=5 npm run benchmark:vscode
```

Runs the CURRENT working tree over the benchmark corpus in a real VS Code
window, and reports per-phase medians. The first iteration of every file is
discarded — cold opens pay WASM compile, worker-pool boot and a per-format GPU
validation stall that never recur. Build the corpus first with
`npm run benchmark:corpus`.

Both this and the A/B script below drive `runner.cjs`, which scrapes the
extension's own Output-channel `[Perf]` lines rather than measuring separately,
so the benchmark and the user can never disagree.

## A/B against a baseline commit

Both benchmarks compare the working tree with the exact v1.9.0 commit
`4b1c8fdb068b9cf96d9339fd0efd87d157dde8f0`. They create a detached temporary
worktree and remove it on completion; the current checkout is never changed.

## Decoder-only synthetic benchmark

```bash
npm run benchmark:decoders:ab
```

This generates RGB16 PPM, uint16 PGM, float32 NPY, and float32 PFM inputs and
runs the actual legacy TypeScript parsers against the current Rust/WASM entry
points. Output samples are compared before timings are reported, so a faster
but incorrect decode fails the run.

## Strategy microbenchmark

```bash
npm run benchmark:decoder-strategies
```

This compares deliberately different implementations for the raw formats:
legacy-style JavaScript copies, compacting/zero-copy JavaScript, and the
Rust/WASM path. It is useful for deciding where work should run; the VS Code
benchmark remains the authority for user-visible performance.

## VS Code end-to-end benchmark

```bash
npm run benchmark:vscode:ab
```

This builds both extensions, starts each in a clean VS Code Extension
Development Host, opens the same generated files through the registered custom
editor, and records both the extension's `[Perf] ... Image loaded` duration and
driver-observed wall time. The first run may download VS Code through
`@vscode/test-electron`.

The end-to-end set also includes a generated RGB8 PNG so native browser decode
changes such as encoded-buffer reuse are tested alongside the raw formats.

Useful environment variables:

- `PERF_SIZE=5120` changes synthetic image dimensions (default: `2048`).
- `PERF_ITERATIONS=5` changes decoder-only repetitions (default: `3`).
- `PERF_VSCODE_ITERATIONS=5` changes end-to-end repetitions (default: `3`).
- `PERF_ONLY=npy-f32,ppm-rgb16` limits either benchmark to named samples.
- `PERF_OLD_REF=<commit>` changes the baseline.
- `PERF_FILES=/absolute/a.png:/absolute/b.hdr` appends real files to the VS Code
  run (`:` is replaced by the platform path delimiter on non-Unix systems).
- `PERF_VSCODE_VERSION=stable` selects the VS Code build.

Performance varies with caches and GPU drivers. Compare medians from several
runs and treat the end-to-end benchmark as a manual performance suite rather
than a pass/fail CI test.
