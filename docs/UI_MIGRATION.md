# Shared image and 3D interface: working review

Started 2026-09-07. The user authorized a complete redesign and Svelte migration,
with functionality preserved. This is the first working slice, not the finished
redesign. Repository consolidation is not required.

## Design direction for discussion

Use a quiet, compact inspector with three task areas:

- **Display:** how values become an image. Tone mapping, channels, colormaps,
  histogram alongside the mapping it explains, orientation and scale.
- **Inspect:** what the data contains. Pixel values, statistics, metadata,
  measurements, ROIs and calibration.
- **Tools:** operations that create or export results. Explicitly distinguish
  changes to data from display adjustments.

Sources belong in a contextual source list when a collection, comparison or
composition is active. IDE document tabs remain owned by the IDE. The browser
and eventual desktop application need their own document navigation.

For 3D, the same shell can hold appearance in Display, point/mesh information
in Inspect, and alignment/processing/export in Tools. Camera controls need a
clear home in Display → View. These labels are proposals, not frozen APIs.

The current prototype floats on the right. Prefer testing a docked variant on
wide editors, because a floating inspector covers the image. Narrow editors
can use an overlay. Compare both with real datasets before choosing the final
placement. The initial layout question remains open with the user.

Other choices to review with the user:

| Choice | Proposed default | Reason |
| --- | --- | --- |
| Density | Compact labels and numeric fields; comfortable hit areas | Fast inspection without a wall of large controls |
| Advanced controls | Collapsed sections, relevant to available data | Discoverable without occupying the canvas permanently |
| Status bar | Live readouts and shortcuts to the same inspector | Preserve native integration without duplicate setting forms |
| Theme | Neutral surfaces, restrained accent, IDE theme where supplied | Image colors should dominate the workspace |
| Histogram | Embedded beside tone mapping | Explain the adjustment where it is made |
| Tool activation | Explicit active measurement/processing tool | Avoid unrelated toolbars remaining on screen |

## Implemented in this slice

- Svelte 5 and TypeScript in the existing esbuild pipeline, for both VS Code
  and browser builds. JetBrains packages the same browser build.
- Reusable section and numeric-field components in `ui/primitives/`, with
  image-specific composition in `ui/image/`. These are candidates for a shared
  package; PLY has not been changed to consume them yet.
- Working auto/manual/gamma mapping, manual range, input/output gamma and
  exposure. Exposure double-click resets to zero. Invalid edits are rejected.
- A small typed edit protocol in `shared/display-settings.ts`, validated at
  both host boundaries. The existing host remains the authoritative owner of
  settings. VS Code emits one settings change per edit.
- Dimensions and pixel readouts in Inspect. Selected existing tools remain
  reachable from the prototype using their original implementation.
- Native VS Code/JetBrains and browser display-status shortcuts focus the
  shared inspector. Existing command-palette forms remain available during
  migration, including advanced choices not migrated yet.
- External compiled CSS for the VS Code CSP; no runtime style injection.
- Inspector gestures are isolated from canvas pan/zoom and legacy controls.

## Functionality ledger

No legacy tool can be removed until its complete workflow has a replacement.
The command inventory remains [commands.md](commands.md); panel-only operations
must also be accounted for. A button that opens a legacy panel is not a migrated
workflow.

| Workflow | Destination | Current migration status |
| --- | --- | --- |
| Auto range, manual range, gamma, exposure | Display → Tone mapping | Svelte controls wired to all three hosts |
| Normalized-float mode | Display → Interpretation | Svelte checkbox for eligible images |
| Packed RGB scaling | Display → Interpretation | Legacy forms preserved; full controls pending |
| No-value color, colormap apply | Display → Color | Legacy command entry points; controls pending |
| Channel visibility, solo, range, color, composite | Display → Channels | Legacy panel; full Svelte migration pending |
| Histogram bins, channel display, scale, hover | Display → Tone mapping | Legacy overlay; embedded version pending |
| Zoom/fit, orientation, scale bar | Display → View; status shortcuts | Existing gestures/commands preserved; complete controls pending |
| TIFF pages, pyramids, series, Z/T/C, DICOM datasets | Contextual dataset navigator | Existing navigator preserved; Svelte migration pending |
| Dimensions and pixel readout | Native status / Inspect | Basic Svelte readout added; full inspection options pending |
| Metadata, all tag groups, statistics, copy JSON | Inspect | Legacy panel; Svelte migration pending |
| Measurements, ROI editing, calibration, imports/exports | Inspect → Measure | Legacy panel and canvas tools preserved |
| Layer order, visibility, groups, blend, opacity, transforms | Contextual sources → Composition | Legacy layers view preserved |
| Collections, compare selection, gallery, image switching | Sources | Existing host commands and navigation preserved |
| Debayer, white balance, algorithms | Tools → Process | Legacy panel preserved |
| Colormap decode and revert | Tools → Process | Legacy command entry points preserved |
| Export formats/compatibility, copy image/info, position | Tools → Export / contextual actions | Existing export/copy workflows preserved |
| Depth → point cloud | Source action / Tools | Existing command preserved where host supports it |
| Open file, URL/history, DICOM folder, recent documents | Host / Sources | Existing host behavior preserved |
| Install app, theme, help, diagnostics | Application menu | Existing browser/IDE behavior preserved |
| Settings persistence, resets and per-format defaults | Host-owned settings | Existing semantics preserved |

## Next complete slices

1. Review placement and density using this real inspector. Decide on docking
   before moving the large panels into its layout.
2. Move histogram and channel controls together with the remaining display
   interpretation controls; remove their duplicate forms only after parity.
3. Move metadata and measurements, retaining import/export and calibration.
4. Build contextual sources, datasets, comparison and composition workflows.
5. Consolidate processing/export/application menus; remove obsolete surfaces.
6. Extract proven primitives for PLY and migrate its corresponding workflows.

The user-facing product is not ready to release with the migration declared
complete until this ledger is covered. No website deployment or marketplace
publication is part of this review.

Implementation reference: [Svelte's imperative component API](https://svelte.dev/docs/svelte/imperative-component-api)
supports mounting components into the existing viewer while the engine remains
independent.

## Validation of the first slice

- All four type checks pass, including Svelte with no warnings; lint passes.
- 27 existing standalone browser tests pass. Three inspector tests cover real
  image updates, exact pixel restoration after exposure reset, manual-range
  validation, gamma, status focus, narrow/light layout, integer interpretation,
  and clearing the UI when the file closes.
- Two host-state tests check atomic edits and rejection of invalid messages;
  32 format-default checks and eight session-preference checks pass.
- The inspector renders in an isolated VS Code 1.136.1 development window.
  Clicking the native normalization status item opens it, and changing exposure
  updates the native status value; the test restores exposure afterwards.
- JetBrains Java tests and `buildPlugin` pass. This turn did not relaunch the
  JetBrains sandbox or physically retest Mac trackpad gestures.

These checks cover the migrated slice, not parity of the entire future redesign.
