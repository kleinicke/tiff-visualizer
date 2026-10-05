# Scientific Image Visualizer — contributor guide

Shared scientific/HDR/image viewer for VS Code desktop and Web, the standalone
browser site, JetBrains, and the local Python/REST/MCP package. The sibling
`ply-visualizer` repository is the 3D viewer; confirm the target if a request is
ambiguous. User-facing format support lives in `README.md` and `docs/formats.md`.

## Ownership

| Responsibility | Location |
| --- | --- |
| Byte parsing, decoded samples, pixel algorithms, statistics | `crates/image-decoders/` |
| WASM bindings and viewer-specific numerical kernels | `wasm/tiff-decoder/`, `wasm/jxl-decoder/` |
| Shared display defaults, types and mode policy | `shared/display-settings.ts` |
| Extension routing | `media/modules/format-registry.ts` |
| Decoder lifecycle and active-image adapters | `media/modules/*-processor.ts` |
| Active image, measurement/histogram adapters and cache snapshots | `media/modules/active-image.ts` |
| Load installation and navigation/cancellation lifecycle | `media/modules/image-load.ts`, `media/modules/image-navigation.ts` |
| Cross-host messages and automation validation | `shared/viewer-protocol.ts` |
| Measurement jobs and collected results | `media/modules/measure/analysis.ts`, `media/modules/measure/results.ts` |
| Rendering, workers, navigation, measurements, layers | `media/modules/` |
| Shared controls and panel markup | `ui/components/` |
| VS Code APIs, commands, status bars and persistence | `src/` |
| Browser/embedded host, file access and browser persistence | `web/` |

Keep `media/imagePreview.ts` as coordination code. New features belong in the
owning module; do not add format-specific pixel inspection, layer conversion or
cache restoration branches there. Measurements and histograms consume the same
active source; retain its numeric domain and planar storage where applicable. Processors expose `activeImage` and `renderWithSettings(options)`; supported
cache paths expose `captureDecoded()`. Snapshots retain buffers without copying
and restore processor state without doing host UI work.

Prefer Rust for byte parsers and pixel algorithms. DOM, GPU API and host API work
stays TypeScript. A measured zero-copy TS accelerator may handle narrowly defined
TypedArray-compatible inputs; unsupported variants must retain their source
buffer and delegate to Rust. Do not copy parsers into the WASM adapters.

Svelte owns markup and controls; pixel buffers and render loops stay outside
reactive state. Publish small view snapshots and explicit actions. Keep stable
control identity during updates, especially sliders and text inputs. Do not
force whole-panel remounts merely to refresh a value. See `docs/SVELTE.md`.

## Invariants worth protecting

- **Numeric domain is not the carrier type.** Preserve source dtype/range,
  channel interpretation, alpha, NaN/Infinity and no-data semantics. Do not
  assume a Float32Array means the source was float, or force all samples to f32.
- `ImageRenderer` is the common display pipeline. Pass the correct `typeMax` and
  extra-sample semantics. Histogram and rendering must agree about non-finite
  values (`Number.isFinite`, not a NaN-only test).
- Matched decoder results are assembled in `media/modules/wasm-decoders.ts` for
  both worker and local paths. WASM `take_data_as_*` methods are one-shot moves.
- Core, heavy-codec and JXL WASM modules are deliberately separate lazy loads.
  The heavy module is the same TIFF adapter built with `heavy-codecs`; JXL
  includes the shared container parsers. Keep uncommon codecs off ordinary opens.
- `[external-codec:NAME]` is a protocol between Rust's `external_codec_needed`
  and TS's `EXTERNAL_CODEC_PATTERN`. Change both together. Strip plans must not
  claim a codec absent from the selected module. See `docs/decoder-fallbacks.md`.
- Source decoding, display changes and exports must preserve their distinct
  semantics. Do not silently replace scientific samples with rendered RGBA.
- `ImageNavigation` owns load generations, cancellation and file-cache selection.
  Switching files cancels stale work. Changing planes within a dataset retains
  worker source caches and renderers; generation checks still discard stale
  results. Cache keys include URI plus page/frame where applicable.
- On initial load, send `formatInfo` before rendering, retain pending decoded
  data, and render after the host applies per-format settings. Preserve this
  deferred-render handshake when adding processors or restoring cached images.
- Host/viewer messages use the discriminated types in `shared/viewer-protocol.ts`.
  Validate external automation before changing settings, navigation or ROIs.
- Host settings remain authoritative. Per-format defaults are shared, while
  session preferences and document-specific state keep their existing scopes.
  VS Code display settings are session-scoped; do not introduce workspace
  persistence implicitly. Preserve webview state through `getState`/`setState`
  so tab reloads restore navigation and document state.
- Keep CSP-compatible external scripts/styles. The standalone site processes
  files locally; never upload image data to its deployment.
- Keep the TIFF WASM glue import static. A non-literal runtime import can resolve
  relative to the wrong bundled URL and silently fail.

## Routine checks

Node 24 is pinned in `.nvmrc`; install dependencies at the repository root.

```bash
npm run compile:quick       # TS/Svelte bundles; uses existing WASM artifacts
npm run typecheck           # extension, engine, browser and Svelte
npm run lint
npm run lint:rust          # Clippy, all features/targets, warnings are errors
npm run lint:rust:wasm     # also check wasm32-specific paths
npm run format:rust:check  # use format:rust to apply Rust formatting
npm run test:behavior       # real production settings, no IDE or Rust rebuild
npm run test:format-defaults
npm run test               # full numerical/format/behavior suite
npm run test:web            # standalone build plus browser regressions
npm run web:dev             # local standalone viewer
```

Rust lint/format commands cover the three project-owned crates. The vendored
`jpegxr-wasm` crate is excluded from linting and formatting to preserve the
upstream implementation and its small local patch; see `crates/jpegxr/VENDORING.md`.
These commands are explicit checks, separate from the JavaScript lint command.

`npm run compile` also rebuilds all WASM modules. Rebuild them after Rust changes.
Use focused tests during iteration, then the appropriate integration checks.
Missing required fixtures/build artifacts must fail rather than report success.
Use F5 or the VS Code integration harness for extension-host behavior; standalone
browser tests do not prove native commands, resource URLs or status bars work.

**Before changing decoding/render performance, read `docs/performance-method.md`.**
Measure the actual `[Perf]` output, distinguish cold/warm runs, check system load,
and verify pixels. Do not recapture goldens without explaining and accepting the
output change. Parallel strip changes require full-vs-split sample equality;
run `npm run test:strip-parallel` before widening strip-plan eligibility.

## Adding or changing behavior

- Vendored JPEG XR: read `crates/jpegxr/VENDORING.md` before changing or updating
  the crate. Its in-memory input patches are required for WebAssembly; the
  upstream temporary-file path cannot replace them.
- Formats: update the registry, `package.json` custom-editor selectors and the
  owning decoder/processor. `test:format-registry` checks registration parity.
  Use the shared settings policy if a new decoded format needs a display default.
- Commands: register in `package.json`, implement host integration in `src/`,
  then run `npm run docs:commands`. `docs/commands.md` is generated and ships in
  the VSIX. Document behavior in the corresponding existing user guide.
- JetBrains-visible formats/features: run
  `node jetbrains/scripts/register-formats.mjs` and update
  `jetbrains/DESCRIPTION.md` as needed.
- Python/REST/MCP: preserve correlated requests, authoritative settings, original
  samples, ROI history, path validation, auth, body limits and timeouts. See
  `docs/python-rest-mcp.md`.
- Browser deployment: `netlify.toml` links `https://images.f-kleinicke.de`.
  Validate with `npm run typecheck:web`, `npm run test:web-host` and
  `npm run web:build` before a requested deployment.
