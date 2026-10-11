# Svelte UI

The website and shared IDE viewer use Svelte 5 and TypeScript, matching the PLY
visualizer's UI framework. TIFF retains esbuild as its bundler. It does not
require a sibling PLY checkout or a SvelteKit server.

`web/App.svelte` supplies the browser shell. `web/ImageTabs.svelte` and
`web/DisplayForm.svelte` render document tabs and display-setting forms.
`ui/components/` contains the shared metadata, channels, debayer, histogram, layers and adjustment editors,
measurement (all five tabs), dataset navigation, context menus, and comparison components. VS Code desktop and VS Code Web use the same viewer
bundle. JetBrains packages the standalone website through its existing
`prepare-viewers.mjs` task, including the Svelte components.

Host adapters retain file access, commands, authoritative settings and session
persistence. `ui/mount.ts` sends small snapshots through Svelte stores and owns
mount/update/dispose. Channel descriptors exclude pixel arrays. Rust/WASM,
workers, image rendering and histogram drawing remain engine responsibilities.
Svelte owns histogram markup, buttons, statistics and tooltip content; its
canvas is bound to the existing histogram renderer.

`ui/panel-gestures.ts` uses `svelte/events` to preserve delegated event ordering
before isolating controls from canvas gestures. Drag listeners end on mouseup,
window blur or disposal. Histogram drag completion retains host persistence.

Both builds use `scripts/svelte-plugin.cjs`. Component CSS is extracted into
external bundle stylesheets and linked from host documents for CSP support.
`npm run watch` uses esbuild's context API and watches component sources.

## Checks

- `npm run compile:quick`: desktop/web extensions, viewer and worker bundles.
- `npm run web:build`: standalone and JetBrains image viewer assets.
- `npm run typecheck`: TypeScript plus `svelte-check`.
- `npm run test:web`: existing browser workflows and Svelte panel interactions.
- `npx playwright test test/playwright/webview-bundle.spec.ts`: shipped viewer
  startup and comparison actions under CSP.

## UI and engine boundary

Svelte owns panel markup and controls. Layers retain their authoritative manager,
undo/redo history and thumbnail compositor. Measurement retains its ROI manager,
calculation and export code, asynchronous threshold/particle work, and canvas
plot drawing. Measurements and layers publish view snapshots without remounting complete panels; measurement, layer, channel and dataset controls retain their DOM identity across engine updates. Backend overrides live under Layers → Rendering diagnostics.

Some small image chrome (collection counter, filename badge, loading notices)
and browser status/log readouts still use imperative host updates. Native IDE
status bars, file dialogs and commands remain in their platform adapters.

The pre-existing `UI_MIGRATION.md` and `UI_REDESIGN_PLAN.md` discuss a separate
inspector/redesign prototype. This change preserves the current UI organization
and does not implement that proposed inspector or consolidate repositories.

Measurement controls publish snapshots from `MeasurePanel`. Numerical jobs and
stale-result cancellation belong to `measure/analysis.ts`; row computation,
frame coalescing and per-file provenance belong to `measure/results.ts`. These
services do not import Svelte or manipulate DOM elements.

### Dataset selector dependencies

Dataset decoders emit the shared `selectors` / `selectedIndices` metadata.
Named choices use `labels`; dimensions without labels use sliders. Keep format
knowledge in the decoder, rather than adding format-specific navigation widgets.
A decoder may additionally emit `selectorResets: { [selectorName]: string[] }`:
when that choice changes, the shared navigation removes those dependent indices
before requesting another plane. NumPy uses this to reset layout when changing
arrays; slice indices are retained and clamped by the decoder instead of being
reset.
