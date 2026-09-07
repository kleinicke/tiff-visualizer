# JetBrains viewer prototype

A local scientific image/3D editor plugin using the existing Scientific Image Visualizer
and 3D Visualizer browser engines. The host is Java 21; there are no new parsers
or rendering algorithms. The initial build targets PyCharm Community 2024.3.5
(build 243). Other JetBrains IDEs are not yet verified.

## Build

Requires JDK 21, Node 24, and installed npm dependencies in both repositories.
Keep `ply-visualizer` beside `tiff-visualizer`, or set `PLY_VISUALIZER_ROOT` to its
checkout. Existing WASM artifacts must be available, as for the standalone sites.

```sh
cd jetbrains
./gradlew test buildPlugin
```

Gradle downloads the target IDE and builds both websites from their existing
sources. The installable archive is `build/distributions/scientific-visualizers-0.2.5.zip`.
In PyCharm, use Settings → Plugins → gear → Install Plugin from Disk, select that
ZIP and restart. Opening a registered local image or 3D file then offers the
**Scientific Visualizer** editor. Existing IDE editor alternatives remain available
where the IDE provides them.

For an isolated development IDE:

```sh
./gradlew runIde
```

## Scope

- Opens the selected TIFF or PLY through the viewer's ordinary file input.
- Waits for the 3D engine's `visualizerReady` signal after asynchronous renderer
  initialization and file-handler registration before delivering the first file.
- Bundles HTML, JavaScript, CSS, workers and WASM; no hosted website is needed.
- Image editors use the shared contextual status strip for range, gamma,
  exposure, pixel inspection and menus. The experimental native toolbar and
  global status bridge were removed after user testing.
- PLY retains its shared controls; the website About/Impressum/Datenschutz footer
  is removed from the embedded bundle only.
- Shared interactive image panels (histogram, channels, measurement, metadata,
  layers) remain in the editor. Separate dockable panels and full VS Code command
  parity are not implemented yet.
- Local files only. No automatic sibling-file resolution, remote-development
  support or file-change watching yet. Find Action/keymap registrations are pending.
- A JCEF download handler now requests the native Save dialog for exports.
  Save/cancel/overwrite and output correctness still need end-to-end verification.
- View state is not restored after closing/reopening an editor.
- JCEF must be present in the JetBrains Runtime. WebGPU availability depends on
  JCEF and the machine; use the existing WebGL/CPU fallbacks where supported.

Each editor owns a loopback HTTP server on a random port with an unguessable path.
It serves bundled assets and only the selected file, rejects cross-site requests
and unexpected Host headers, and stops on editor disposal. There is no endpoint
for arbitrary filesystem paths. Bytes stream through HTTP rather than a base64
JavaScript string. The browser still buffers the selected file for decoding.
Analytics and app-install metadata are removed from the embedded builds; external
network requests are blocked by their Content Security Policy.

## Verification

`./gradlew test` tests the actual Java file-serving boundary, including binary
bytes and rejected unauthorized/mutating requests. To test decoding/rendering
through that same host in Chromium after building:

```sh
node scripts/smoke-viewers.mjs ../test-samples/house.tif ../../ply-visualizer/testfiles/ply/test_binary.ply
```

Screenshots are written to `build/image-smoke.png` and `build/ply-smoke.png`.
Chromium checks supplement, but do not replace, opening both files in PyCharm's
JCEF editor. For that check, verify image pixel inspection, cloud rotation,
closing/reopening tabs, and the IDE log for WASM/worker/GPU errors.

The image host keeps the shared contextual controls and omits website branding.
The PLY browser UI is close to the VS Code UI and can remain the main surface.
For TIFF, the shared controls are the current UI. The previous native toolbar
was rejected during user testing. Possible future host mappings are below;
they are not a specification for exposing every command permanently.

| Existing TIFF integration | JetBrains destination |
| --- | --- |
| Dimensions, pixel inspection, zoom and file size status entries | Editor-aware status bar widgets |
| Gamma, brightness, normalization and display toggles | Editor toolbar actions with native input/popups; optional status widgets |
| Layers window and comparison editor | Dockable tool window or dedicated editor tab, reusing shared web UI |
| Command palette, shortcuts and context menus | Registered actions, Find Action and keymap entries |
| Active preview and per-format settings | Project settings/state plus per-editor view state |
| Open, export and companion files | Native file dialogs and an explicit ready/open/save message bridge |

Status widgets should follow the active image editor and disappear when unrelated
files are selected. Preserve settings scope deliberately: session/per-format
adjustments and per-image state are distinct in the VS Code host. Implement this
adapter in Java/Kotlin; do not import VS Code API code or duplicate decoders.

Platform references: [status widgets](https://plugins.jetbrains.com/docs/intellij/status-bar-widgets.html),
[tool windows](https://plugins.jetbrains.com/docs/intellij/tool-windows.html),
and [actions](https://plugins.jetbrains.com/docs/intellij/action-system.html).

## Verified on 7 September 2026

- Built the plugin and passed the Java HTTP-boundary test.
- Opened the 512×512 `house.tif` and the 250,072-point `test_binary.ply` through
  the bundled viewers in Chromium and in a real PyCharm Community 2024.3.5 JCEF
  editor on macOS ARM64.
- Verified mouse-driven 3D camera rotation and closing/reopening editor tabs.
- Rechecked closing/reopening through `OpenFileDescriptor.navigate`, without
  forcing the custom editor selection, after restarting with the PLY file type
  registration. Both viewers rendered; the cloud contained 250,072 points.
- Inspected screenshots from both actual JCEF editors. They are saved locally
  as `build/pycharm-image.png` and `build/pycharm-ply.png`.

`runIde` enables local JCEF debugging on port 9223 for development only. With
both sample editors open, run `node scripts/inspect-jcef.mjs` to verify the
loaded geometry, image canvas, mouse rotation and capture fresh screenshots.
This script uses page-level CDP because JCEF does not implement the browser
context management required by Playwright's normal CDP connection.

This is a working development build, not a Marketplace release. Full export
workflows, all registered formats and other IDE/OS versions remain unverified.

Restart the development IDE after changing file type registrations or bundled
viewer assets; updating the sandbox files alone did not refresh the running
instance reliably during testing.


## Format coverage and release status

`formats.json` records 49 image suffixes and 21 3D suffixes derived from both
VS Code manifests. Run `node scripts/register-formats.mjs` after changing those
manifests; the build rejects stale registrations. `.bin` is deliberately deferred
because it needs an explicit Open as KITTI action; `.nhdr` requires detached data.
TIFF/PNG/NumPy depth images currently open in the image editor, not a second 3D
editor. JSON/COLMAP multi-file sets also need an explicit import workflow.

A registered suffix is not a claim of complete format parity. In particular,
external glTF buffers/textures and OBJ material/texture companions are not
resolved automatically. Single-file variants can use the existing browser
parsers. Large archives, splats and LiDAR formats still need representative host
tests before being advertised as verified support.

Verified samples additionally include NumPy float32 and a standalone OBJ mesh.
Browser smoke checks exercise image range/gamma changes and assert the website
chrome/footer is absent. Java tests cover format routing and the HTTP boundary;
`verifyPluginStructure` passed. This is not the cross-version Plugin Verifier.

Before a public release:

1. Choose a tested first-release format set and document variant limitations.
2. Verify save/cancel/overwrite, export bytes, companion assets and reopen/state
   behavior. Complete the desired TIFF workflow and native action registrations.
3. Run Plugin Verifier and fresh-install tests against each advertised IDE build;
   currently only PyCharm Community 2024.3.5 on macOS ARM64 has been exercised.
4. Prepare license/dependency notices, plugin icon, screenshots, listing and
   signing configuration. First Marketplace upload is manual; no upload has
   been performed here.

[JetBrains publishing guidance](https://plugins.jetbrains.com/docs/intellij/publishing-plugin.html)


## 0.2.1 interaction correction

Removed the experimental native TIFF toolbar/status bridge and restored the
shared contextual controls. Wheel zoom now recognizes the modifier carried by
the wheel event even if the embedded viewer missed the preceding keydown.
The original failure was reproduced in real PyCharm with Option-wheel.
The corrected build passed actual JCEF Option-wheel, pinch-style wheel and
scroll-panning checks, plus TIFF/PLY close-reopen and PLY rotation checks.
Smoothness on a physical Mac trackpad needs user validation; automated input
checks are not a substitute for that assessment.

See [the 3D release plan](PLY-RELEASE.md) for a standalone PLY release.


## Shared fixture project and interaction profiling

`./gradlew runIde` now opens `../../test_data/testfiles`, the same local fixture
folder used for VS Code. Override with `-PviewerTestProject=/absolute/path`.
The fixture folder is not bundled in the distributable. Opening it does not
imply every format or multi-file variant is supported by this host.

Version 0.2.2 creates JCEF browsers with a 60 fps windowless frame limit. On the
same `house.tif` bytes, three old-browser hover samples had median animation
intervals of 33.3 ms. With the limit configured at creation, the first new sample
and two repeated samples each had a median of 16.7 ms (240 frames in about four
seconds). Changing the cap on an already-created browser did not change cadence.
These are animation/hover measurements, not large-file decode benchmarks or
proof of physical trackpad latency. Machine load was elevated (about 5–8).

Reproduce with an image tab open:

```sh
node scripts/profile-interaction.mjs
```

CPU profiles are saved under `build/interaction-profile`. Decoders and pixel
rendering algorithms were not changed. TIFF sample and picker regression tests
passed. The extra `255` in `house.tif` is its second stored sample; its
`ExtraSamples=999` tag does not identify the sample reliably. The picker now
labels it `C2:255`; explicitly declared alpha uses `α:`. Neither is silently
removed or modified by colour adjustments.


## 0.2.3 native pinch and editor tabs

The image editor now implements JetBrains `ZoomableViewport`, which receives
native macOS magnification from the IDE gesture manager. Start/change/end phases
are forwarded to the shared image gesture handler. In the live IDE, invoking the native viewport callbacks doubled the displayed
image width (1609 to 3218 CSS pixels), and the website toolbar was hidden.
This tests the Java-to-viewer bridge, not physical trackpad delivery. The user
subsequently confirmed quick physical pinch zoom, but reported severe panning lag.
Wheel-event simulation does not verify the native pinch input path.
The website header and its file tabs are always hidden in JetBrains. File tabs
belong to the IDE; contextual image controls remain visible at the bottom.

The earlier animation-callback timings are not measurements of actual displayed
frames or input-to-paint latency and do not establish that the reported lag is
resolved.

## 0.2.4 Mac panning input

A native AWT wheel probe exposed a different delay from rendering: a small
unit-scroll event took 508 ms to reach the page; a smaller event did not arrive.
The bundled JCEF OSR component accumulates small wheel rotations with a 500 ms
timeout. Mac image editors now intercept ordinary unit-scroll events before
that accumulator and forward precise deltas to the viewer. Modifier-wheel zoom
and the native magnification callbacks retain their existing paths.

The browser bridge preserves fractional deltas, respects wheel cancellation,
and scrolls the nearest scrollable panel or the document. Listener cleanup is
scoped to the editor. The adapter detects this runtime's OSR component by class
name; other JetBrains runtime versions need compatibility testing.

In the rebuilt test IDE, two native probes reached the page in 8 ms and 2 ms;
the latter moved the zoomed image by the requested 8 CSS pixels. These are
input-delivery measurements, not input-to-paint measurements or proof of
physical trackpad smoothness. Native pinch callbacks still doubled image size,
and the website tabs remained hidden. Java tests and TIFF/PLY browser smoke
checks passed, including fractional movement, panel scrolling, and cancellation.

## 0.2.5 status readout

Image dimensions are published when the viewer commits the image element,
independently of delayed analysis bookkeeping. This addresses a missing idle
readout observed on the first `house.tif` load (reopening it restored the size).
JetBrains status controls stay aligned to the right when they fit, including
below the website's 900 px breakpoint; overflowing controls remain scrollable.
