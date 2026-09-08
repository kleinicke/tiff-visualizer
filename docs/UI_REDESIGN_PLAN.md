# Image UI redesign toward a unified image and 3D product

Design proposal, 2026-09-07. The Svelte migration and full redesign are now
authorized; [the working review and migration ledger](UI_MIGRATION.md) track
implementation. Individual design choices remain under discussion. The user's latest position
is that a monorepo remains tentative; technology and UI alignment come first.

Related: [unified product plan](../../ply-visualizer/docs/UNIFIED_PRODUCT_PLAN.md)
and [PLY Svelte migration](../../ply-visualizer/docs/SVELTE_MIGRATION_PLAN.md).

## Product promise

Working description: **Inspect scientific images and 3D data.**

Supporting copy: **Explore pixel values, depth maps, point clouds, and meshes
in your browser, IDE, or desktop app.** Only advertise each distribution when
it is actually available. The desktop app remains future work.

One umbrella brand can have Image and 3D editions for the existing extensions,
while a combined application offers both views. Preserve extension IDs and
format-specific descriptions/search terms. A name does not need to enumerate
file formats. Naming and availability checks are separate from UI migration;
no final brand or name is selected here.

The connection between the viewers is inspection of measured data. A depth
image becoming a point cloud is a strong demonstration of that connection.
Avoid positioning the combined product as a general image editor, CAD system,
or a viewer for every conceivable kind of data.

## Redesign the organization, migrate the implementation gradually

Adopting Svelte alone would preserve today's scattered controls. First assign
each feature one primary location and define the common workflows. Then replace
whole UI sections with Svelte components while retaining the image engine.

Current evidence:

- Image commands live in the VS Code command palette, image context menu,
  status items, website forms, and independent panels/overlays. See the
  [command reference](commands.md), `web/browser-host.ts`, and the panel modules.
- PLY already mounts Svelte components for its file list, controls, camera,
  info, dialogs, progress and other panels. Its current navigation is Files,
  Camera, Controls, Info (`engine/src/components/TabNav.svelte`).
- Some PLY components still accept a large `host` object and interact with the
  DOM. Reuse their appearance and proven behavior, while giving newly shared
  components small typed inputs and actions. Do not copy all coupling into TIFF.

## Proposed UI organization

Use PLY's compact panel shell, typography, spacing, theme and control behavior.
The following mapping is a proposal to prototype before changing navigation.

| Primary area | Image viewer | 3D viewer |
| --- | --- | --- |
| Files | Loaded sources, collections, comparison and layer composition | Loaded sources, groups and visibility |
| View / Camera | Fit, orientation, page/slice/time navigation | Camera, projection, fit and orientation |
| Controls | Display adjustments, measurement and processing sections | Appearance, measurement and geometry/registration sections |
| Info | Metadata, dimensions, units and detailed pixel inspection | Metadata, bounds, units and point/mesh inspection |

`Controls` must not become a flat list of everything. Use a few named,
collapsible sections with context-dependent contents. An ordinary image opens
with only relevant display controls; calibration, conversion, debayering and
other specialized operations stay in the appropriate collapsed section.

### Initial image feature map

| Capability | Primary home |
| --- | --- |
| Open/add files, collections and source selection | Files; host file menu/explorer is also an entry point |
| Layer visibility, ordering, blending and composition | Files → Composition; appears when used, not a permanent status item |
| Compare images | Select sources in Files → Compare |
| Normalization, gamma, exposure, colormap and no-value color | Controls → Display |
| Channel visibility/composition and histogram | Controls → Display, grouped with the settings they explain |
| Page, Z/T/series selection | View; a compact near-canvas navigator may appear for an active dataset |
| Fit, orientation and scale-bar visibility | View |
| Measurements, ROIs and calibration | Controls → Measure; canvas tools appear only while active |
| Debayer, colormap decoding, numeric reinterpretation | Controls → Process; explicitly distinguish derived data from display changes |
| Metadata, units and full pixel readout settings | Info |
| Open depth as point cloud | Source action in Files; reuse the same document in another view where supported |
| Export and copy | One document/export action, with source/derived/rendered-output choices where supported |

This is a capability map, not yet the exhaustive command-by-command migration
ledger. Before removing a legacy surface, map every command and every panel-only
operation to its replacement, including shortcuts, persistence and host support.
No capability is silently deleted merely to make the UI smaller.

### Placement rules

- One primary editor for each setting. Status items and command shortcuts open
  or focus that editor rather than maintaining another form and validation path.
- Keep dimensions, pixel/point readout and zoom in the status area. Other
  existing compact status values may remain shortcuts during migration; review
  their long-term visibility in the prototype. Do not restore Layers, Options,
  or the separate Original/Modified switch that the user removed.
- Right-click offers actions for the current selection/pixel/object. It should
  not reproduce the complete settings interface. Existing keyboard commands
  remain searchable, including aliases during any rename.
- Show advanced controls when their input or active task makes them relevant.
  If an expected action is unavailable, explain why rather than failing silently.
- Match PLY reset gestures, grouped visibility, numeric input conventions and
  compact styling. Also provide a discoverable reset affordance and keyboard
  access so gestures are not the only way to find these actions.
- Preserve image pan/pinch and 3D orbit/pan semantics. Consistency does not mean
  forcing identical navigation or offering irrelevant tools in both viewers.

## Shared technology and state

Use Svelte 5 and TypeScript for browser/webview UI. Keep decoders, pixel
processing, workers and render loops outside Svelte. Feed panels small state
snapshots; do not put image buffers or every render-loop update into reactive
UI state. Prefer Rust for parsing and substantial computation as already
specified in both repositories.

Extract genuinely reusable panel shells, fields, sliders, menus, dialogs,
themes and progress components. These must not import either viewer engine.
Viewer-specific panels compose those components and invoke typed commands.

Keep one authoritative settings model. During migration, adapt the existing
model to Svelte and route changes back through its commands. Do not create a
second independently writable copy of gamma, normalization, channel selection
or per-document state. UI-only state, such as which section is expanded, can
belong to the UI.

A shared command definition should describe identity, label, applicability and
execution. Context menus, shortcuts, platform status items and panels consume
that definition; they should not each implement the behavior again.

## Platform placement

Shared components give the viewers consistent internal controls. Platform
adapters still own native file dialogs, menus, status widgets and file access.

- VS Code / JetBrains: retain native document tabs and explorers. The viewer's
  Files panel manages a scene, collection or composition, not duplicate IDE tabs.
- Browser / Tauri: the application shell owns file opening, documents, recent
  files, settings and view arrangement because there is no IDE around it.
- Status shortcuts should focus the matching shared settings section. The
  recently added native dialogs are usable transitional UI, not a reason to
  maintain separate long-term implementations of the same settings editor.

## Sharing before a monorepo

A combined host can consume two viewer packages regardless of repository
layout. Give each viewer a stable mount/dispose/state/command interface and
explicit host capabilities for file reads, save/export, clipboard, persistence
and document opening. Do not make a production build depend on a developer's
`../ply-visualizer` checkout.

Initially one existing repository can own a small shared UI package; the other
consumes a pinned package artifact/version. A local packed artifact is enough
for a first prototype. Both projects must actually consume that same package
before calling the UI shared. Avoid copying components and letting them drift.
A future monorepo can replace these package dependencies with workspace links.
No repository move or package publication is authorized by this draft.

A unified app also needs document identity, view routing, session state, units,
camera/calibration metadata and export semantics. Matching CSS or adopting the
same framework does not provide those pieces. For an ambiguous TIFF/NPY, offer
an explicit view choice; never interpret every image as a depth map.

Run the existing engines in the actual Tauri platform webviews before investing
in a full shell. macOS uses WKWebView, while the present JetBrains prototype
uses JCEF; successful JCEF/Chromium tests do not prove Tauri compatibility.
See [Tauri process model](https://v2.tauri.app/concept/process-model/).

## Proposed delivery sequence

1. Inventory every feature and define its primary location. Record common
   workflows and current behavior before changing navigation.
2. Prototype the complete panel shell using representative ordinary-image,
   scientific-image and 3D states. Review density, navigation, narrow IDE panes
   and advanced-tool discovery before converting every panel.
3. Establish Svelte tooling and shared primitives. Prove one small panel such as
   Info/metadata, then migrate one complete workflow: open a float TIFF, adjust
   range/exposure, inspect original values and export. Remove the replaced
   forms/menu branches for that workflow once their replacements pass.
4. Migrate the remaining panels by workflow: display/channels/histogram,
   measurements, composition/comparison and specialized processing. Preserve
   existing releases and host capabilities at each step.
5. Demonstrate one image document in both 2D and 3D, then evaluate the combined
   Tauri shell and distribution. Decide on repository consolidation based on
   the actual sharing/build friction, not as a prerequisite for the prototype.

Svelte supports [mounting individual components](https://svelte.dev/docs/svelte/imperative-component-api)
inside an existing application, which supports this migration sequence.

## Review and acceptance

Use real fixtures from the full `test_data` folder. For each migrated workflow,
check the actual VS Code extension, browser and JetBrains host, including tab
switching, keyboard operation, narrow widths and relevant file types. Preserve
pixel values, export semantics, settings scope, source identity and smooth
interaction. Engine changes require the existing performance/pixel-equality
method; UI framework adoption is not evidence of a rendering speedup.

The first review should settle the proposed navigation and feature map. Final
branding, a monorepo move and the exact combined desktop workspace layout can
remain open while that work proceeds.
