# Backlog / Roadmap

Feature ideas for the TIFF Visualizer, with prerequisites, an implementation
sketch grounded in the current architecture, and a rough difficulty/effort
estimate. Difficulty is **1–5** (1 = a few hours, 5 = multi-week epic).

Ordering below is by suggested priority, not by the numbering the ideas came in
with.

---

## Foundational unlock: multi-IFD decoding — implemented

The Rust/WASM decoder now enumerates top-level IFDs and decodes arbitrary pages;
the wrapper, worker, and geotiff.js fallback all carry `pageIndex`/`pageCount`.

This primitive is shared by plain multi-page navigation and OME-TIFF.

---

## 1. Multi-page / N-dimensional TIFF navigation — implemented (core)

> `← Slice 12 / 325 →`, Time 4, Channel 2

Navigate the pages inside a single multi-page TIFF (Z-stacks, time series,
channels) instead of showing only page 0.

**Prerequisites:** the multi-IFD primitive above.

**Implementation notes:**

- A separate top-center page overlay avoids conflating pages with the file
  collection. `[`/`]` and Page Up/Page Down navigate pages.
- The source byte buffer is cached so page changes do not refetch the file.
- **Follow-up:** cache decoded pages and preload neighbors for smoother
  scrubbing through large stacks.
- Plain multi-page TIFFs have no semantic axis labels — so this first version
  shows "Page N / M." The Channel/Z/Time _labels_ come from OME metadata (item 2).

**Difficulty: 2** on top of the primitive. This is the highest value-per-effort
item — it makes the tool useful for microscopy/medical stacks immediately.

---

## 2. OME-TIFF support — implemented (single-file and embedded multi-file core)

> `cell_image.ome.tif` should expose Channels (GFP/DAPI/RFP), Z slices, Time
> points, Objectives, Voxel spacing.

The biggest single feature for attracting microscopy users. OME-TIFF is a
regular multi-page TIFF whose **first IFD's `ImageDescription` tag (270)**
contains an **OME-XML** document describing how the flat list of pages maps onto
the (Channel, Z, Time) dimensions, plus physical metadata.

The implementation now includes namespace-tolerant OME-XML
parsing, `DimensionOrder` plus explicit `TiffData` mappings, C/Z/T sliders,
channel names/colors, physical sizes/units, objective metadata, physical-unit
pixel readouts, later-page session restore, and `.ome.tif`/`.ome.tiff` plus
OME-BigTIFF extensions (`.ome.tf2`, `.ome.tf8`, `.ome.btf`). Embedded OME-XML
filesets also resolve `UUID FileName` mappings into the shared dataset viewer,
so C/Z/T navigation can switch both the physical TIFF and its local IFD.

**Implementation sketch:**

- Detect `.ome.tif`/`.ome.tiff` or an `ImageDescription` starting with `<OME`.
- Parse the OME-XML (a small dependency-free parser, or a tiny XML lib in the
  worker) to extract: `SizeC/SizeZ/SizeT`, `DimensionOrder` (e.g. `XYZCT`),
  per-`Channel` `Name`/`Color`, `PhysicalSizeX/Y/Z` (voxel spacing), and
  objective/instrument info.
- Map a `(c, z, t)` selection → flat IFD index using `DimensionOrder`. This is
  the whole trick; it turns item 1's "Page N" slider into three labeled sliders.
- **Follow-up:** surface simultaneously visible channels as **layers**. The
  layer system already handles compositing, but needs per-layer tint/colormap
  settings before GFP+DAPI+RFP can be merged correctly.
- Show voxel spacing / objective in the metadata panel; feed spacing into the
  size/pixel-position readout for real-world units.

**Remaining scope:** channel→layer merged compositing, standalone companion
`.ome`/`.ome.xml` entry points, and pyramidal SubIFD viewport loading. Multiple
`Image`/`Pixels` nodes are now exposed through the dataset series selector.
These remaining items stay separate because they change compositing, editor
entry-point handling, and lazy-loading behavior respectively.

### Multi-file OME datasets — core implemented, follow-ups remain

OME-XML is the dataset manifest, not another pixel format. It can be embedded
in the first TIFF's `ImageDescription`, repeated in every member of a fileset,
or stored as a companion `.ome.xml` file. Its `Image`/`Pixels` metadata defines
the logical dimensions and each `TiffData` entry can contain a `UUID` with a
`FileName` that identifies which physical TIFF contains a particular
`(series, c, z, t)` plane. A fileset such as two channels × 43 timepoints ×
ten Z planes may therefore be 86 TIFF files even though it should appear as one
dataset in the viewer.

Implementation status for loading and navigating the complete logical dataset:

- [x] Extend the OME parser so a plane mapping is
      `(series, c, z, t) -> { fileName, uuid, ifd }`, rather than only
      `(c, z, t) -> ifd`. Preserve `Image`/`Pixels` IDs and support both explicit
      `TiffData` mappings and dimension-order-derived contiguous ranges.
- [x] When any member TIFF is opened, parse its embedded OME-XML and build a
      dataset manifest. Resolve relative `FileName` references against the opened
      file's directory through the extension host and match available siblings.
      Follow `BinaryOnly MetadataFile` references to either a master OME-TIFF or a
      standalone companion `.ome`/`.ome.xml` document. Do not require the user to
      add the files to an ordinary image collection manually.
- [ ] Support a companion `.ome.xml` entry point as well: opening it should resolve
      its referenced TIFFs and open the logical dataset. Standalone OME-XML without
      resolvable pixel files remains useful as metadata, but cannot render an
      image.
- [x] Keep one dataset-level C/Z/T selection. Changing Z commonly selects a
      different IFD in the current file; changing C or T may transparently switch
      to another TIFF and then select its mapped IFD. The controls must reflect the
      selected logical coordinate, not whichever mapping happened to be parsed
      last.
- [x] Reuse the collection switching infrastructure for smooth
      visual transitions, while keeping dataset navigation semantically separate
      from user-created collections. Continue showing the current plane while the
      target file decodes, show a small dataset-loading indicator, discard stale
      navigation results, and atomically replace the image when ready.
- [ ] Expand the current previous-plane decoded cache to nearby C/Z/T neighbors with a bounded
      memory policy. Prefer the likely next file/IFD based on navigation direction;
      avoid eagerly loading an entire large fileset into memory.
- [x] Present the fileset as one item with useful context such as
      `C 1/2 · Z 4/10 · T 12/43` and, where helpful, the current physical
      filename. Add a dataset/series selector only when the OME-XML contains more
      than one `Image`/`Pixels` series.
- [ ] Improve incomplete or moved dataset handling. Missing, unsafe, or
      inaccessible referenced files should mark only the affected coordinates as
      unavailable and produce a clear diagnostic listing the unresolved names,
      rather than silently displaying a plane from the wrong channel/timepoint.
- [ ] Validate referenced TIFF UUIDs, not only safe paths and file availability.

**Acceptance test:** opening any member of the `tubhiswt-4D` sample discovers
the two-channel, 43-timepoint, ten-Z-plane fileset; Z navigation changes local
IFDs, C/T navigation switches referenced TIFFs without a blank-frame jump, and
opening the companion metadata (when present) produces the same logical
dataset. Tests must also cover repeated local IFD numbers, a missing member,
UUID mismatch, rapid navigation cancellation, and session restore to a plane
stored in a different member file.

- [x] FITS, native/uncompressed DICOM, DICOM JPEG Baseline, and classic NetCDF
      (CDF-1/CDF-2) decoding. NetCDF includes variable selection, non-spatial
      dimension controls, regular raster views, and MPAS `nCells` polygon-mesh
      projection. NetCDF-4/HDF5 and additional DICOM transfer
      syntaxes (JPEG Lossless, JPEG-LS, JPEG 2000, RLE, and video) remain part of
      the heavier codec/container follow-up described below.
- [x] DICOM folder datasets: an **Open Folder as DICOM Dataset** command detects
      extensionless objects by content, ignores non-image objects, deduplicates SOP
      instances, groups Series Instance UIDs, spatially orders slices from image
      orientation/position with Instance Number fallback, and exposes series/slice
      navigation through the shared dataset UI. Explicit temporal-position and echo
      dimensions become additional axes. Basic multi-frame objects expose a Frame
      axis, including JPEG Baseline frames. Enhanced multi-frame functional-group
      semantics, additional compressed transfer syntaxes, and less-standard
      acquisition dimensions remain follow-ups.

---

## 3. Remote / large-dataset formats: OME-Zarr, Zarr, HDF5

> Attractive for large-scale scientific datasets.

These are **chunked, multi-resolution** array formats, not single files. They
change the loading model: you fetch chunks on demand rather than decoding one
blob. This is a bigger architectural shift than the TIFF items.

**Prerequisites:** none of the TIFF work, but a **tiling/lazy-loading render
path**. The current pipeline decodes a whole image into a Float32Array up front;
these formats need viewport-driven chunk fetching to be worth it (that's their
entire point — datasets too big for memory).

**Implementation sketch:**

- **OME-Zarr** is the highest-value of the three: it's the OME data model on a
  Zarr backend, so it reuses all the channel/Z/T UI from item 2. A Zarr store is
  just a directory/URL of chunk files + JSON metadata (`.zarray`/`.zattrs`), so
  it needs no heavy native dep — fetch + decompress (blosc/zstd/gzip) in the
  worker.
- **Zarr** (plain) = same reader without the OME semantics.
- **HDF5** is the hard one: a complex binary container. Needs a WASM build of a
  reader (e.g. `h5wasm`) — a substantial dependency and a different code path.
  See the dedicated subsection below: the container is generic, so the work is
  not "read HDF5" but "decide what an arbitrary HDF5 file means."
- Remote support also means handling URLs, range requests, and caching in the
  decode worker; today everything assumes local file bytes.

**Difficulty: 4 (OME-Zarr) → 5 (HDF5 + general remote/lazy infra).** Recommend
scoping to **OME-Zarr, local first, then remote URLs**, and deferring HDF5.

### HDF5: a container, not a format

HDF5 says nothing about what is inside — like ZIP. `h5wasm` gives us groups,
datasets, shapes, dtypes and attributes; it does not tell us which dataset is
the image, which axis is Z and which is channel, or what a voxel measures. So
the reader must be built in **two layers**, and the generic layer must ship
first because it is also the fallback for every unrecognized file.

**Layer 1 — generic browser and manual axis mapping (the honest baseline).**
Show the group/dataset tree with shape, dtype and attributes. Let the user pick
any dataset with 2–5 dimensions and assign each axis to X / Y / Z / C / T, with
a size-based initial guess (an axis of extent ≤ 4 is probably C; the two
largest are probably Y/X). Persist the chosen mapping in a sidecar keyed by
dataset path, so sibling files from the same pipeline open correctly without
re-asking. This alone makes arbitrary lab HDF5 files viewable, which is
currently impossible in any editor.

**Layer 2 — recognizers that skip the questions.** Detect a known convention
and auto-configure the mapping. Each recognizer is small; the value is that
common files never hit the manual path:

| Convention | Detection | Self-describes |
| --- | --- | --- |
| **Imaris `.ims`** | `/DataSetInfo` group, `ImarisVersion` attribute | fully — see below |
| **HDF5 dimension scales** | `DIMENSION_LIST` / `REFERENCE_LIST` attributes | axis names and coordinate values; the official HDF5 mechanism |
| **NetCDF-4 / CF** | root `_NCProperties`; CF axis attributes | axis names, units, scaling |
| **NeXus** | `NX_class` attributes, `@signal` / `@axes` on `NXdata` | fully; strongest standard in the space |
| **BigDataViewer** | `/t00000/s00/<level>/cells` plus companion XML | resolution levels, per-setup transforms |
| **ilastik** | `/exported_data` with a JSON `axistags` attribute | axis order explicitly |
| **MATLAB v7.3 `.mat`** | `MATLAB_class` attributes | dtype only; axes still manual |

The lesson from that table: the "unknown blob" problem is real, but three
mechanisms (dimension scales, NeXus, and per-tool markers) cover most files
that actually reach a viewer, and everything else falls back to Layer 1 rather
than to an error.

**Why `.ims` is the one worth targeting first.** It is a *specified* layout,
published by Bitplane as the Imaris Open File Format, and stable across
versions:

- `/DataSet/ResolutionLevel <n>/TimePoint <t>/Channel <c>/Data` — a chunked 3D
  array (uint8/uint16/float32). The pyramid, time and channel axes are separate
  paths, so no axis guessing is needed at all.
- `/DataSetInfo/Image`, `/DataSetInfo/Channel <c>`, `/DataSetInfo/TimeInfo` —
  extents (`ExtMin0..2`, `ExtMax0..2`), dimensions, channel name, color, and
  ranges. Physical voxel size follows from extent ÷ size, which feeds
  calibration (item 7) and physical-unit readouts for free.
- `/Thumbnail/Data` and per-dataset `Histogram` attributes exist and can be
  reused directly.

Two gotchas: **all attributes are fixed-length char arrays**, so every number
must be parsed from ASCII rather than read as a numeric attribute; and the
`Data` arrays are **padded to chunk boundaries**, so `ImageSizeX/Y/Z` from
`/DataSetInfo/Image` is authoritative, not the dataset shape.

The genuinely proprietary and poorly documented part is `/Scene/Content`, which
holds Imaris analysis objects (Surfaces, Spots, Filaments, Tracks). That is
explicitly **out of scope** — we would read the image, not the analysis
results. That split is what makes `.ims` tractable while "support HDF5" in
general is not.

**Difficulty: 3** for Layer 1 plus `.ims`, given `h5wasm` is already a
dependency by then; **+1** per additional recognizer, most of them far less.

---

## 4. Additional microscopy/scientific formats (opportunistic)

> maybe: CZI, ND2, LIF, DICOM, FITS, NetCDF

Each is a new processor module (`media/modules/<fmt>-processor.ts`) plugging into
the existing decode-worker + central render pipeline, so the _integration_ cost
is low and identical across them. The cost is entirely in the **decoder** for
each format:

| Format          | What it is                                     | Decoder difficulty | Notes                                                                                                           |
| --------------- | ---------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------- |
| **FITS**        | Astronomy; simple header + raw float/int array | **2**              | Easy win, no real dep needed. Good "second scientific format."                                                  |
| **DICOM**       | Medical imaging; well-specified                | **3**              | Mature JS libs exist (e.g. dcmjs/cornerstone-style parsers). Windowing UI overlaps with existing normalization. |
| **NetCDF**      | Geoscience array container                     | **3**              | Classic NetCDF is parseable in JS; NetCDF-4 is HDF5 underneath (see item 3).                                    |
| **CZI** (Zeiss) | Proprietary microscopy                         | **4**              | Complex, sparsely documented; likely needs a WASM port.                                                         |
| **ND2** (Nikon) | Proprietary microscopy                         | **4–5**            | Poorly documented; reverse-engineered readers only.                                                             |
| **LIF** (Leica) | Proprietary microscopy                         | **4**              | Similar story to CZI/ND2.                                                                                       |

**Recommendation:** do **FITS** and **DICOM** (broad, well-documented audiences,
tractable). Treat CZI/ND2/LIF as demand-driven — only if microscopy users
specifically ask, since each is a large reverse-engineering effort for one vendor.

### Dedicated format and codec priorities

Prefer focused decoders that preserve source sample depth and metadata over a
general conversion engine. From the current feature set, the next useful
additions are:

1. **DICOM RLE Lossless.** Implement directly in the decode worker; it is a
   comparatively small codec and needs no heavyweight dependency.
2. **JPEG-LS (`.jls`) and DICOM JPEG-LS transfer syntaxes.** Use a focused
   CharLS/WASM decoder (BSD-3-Clause) and share the decoded-pixel path between
   standalone images and encapsulated DICOM frames.
3. **JPEG 2000 / HTJ2K (`.jp2`, `.j2k`, `.j2c`) and their DICOM transfer
   syntaxes.** Prefer OpenJPEG/OpenJPH-style WASM decoders with permissive
   licensing. Preserve signedness, component count, and 12/16-bit samples
   instead of converting through 8-bit RGBA.
4. **NIfTI (`.nii`, `.nii.gz`, and paired `.hdr`/`.img`).** Add a focused
   parser and reuse dataset axes for 3D/4D volume and time navigation. Honor
   voxel spacing, scaling, qform/sform orientation, and integer/float data
   types.
5. **NRRD (`.nrrd`, `.nhdr`) and MetaImage (`.mha`, `.mhd`).** These are
   tractable header + raw/gzip array formats that fit the existing scientific
   array processor and dataset navigation well.
6. **MRC/CCP4 (`.mrc`, `.map`).** Add scalar-volume support for cryo-EM and
   electron-microscopy density data, including axis order, voxel size, and
   slice navigation.
7. **OME-Zarr**, following the local-first, chunked-loading plan in item 3.
   This has more strategic value than accumulating legacy single-image raster
   formats, but requires the lazy/viewport loading architecture described
   above.

Lower-priority, demand-driven additions:

- **GIF/APNG:** only if frames are exposed through the shared page/frame
  navigator; first-frame-only decoding is not sufficient justification.
- **DDS/KTX2:** useful for graphics workflows when mip levels, array layers,
  cube faces, and compressed texture formats can be inspected rather than
  flattened into one preview.
- **QOI:** very small and easy to decode, but currently too niche to outrank
  the scientific and medical formats above.

**Format expansion sequence from the current state:** DICOM RLE → JPEG-LS →
JPEG 2000/HTJ2K → NIfTI → NRRD/MetaImage → MRC/CCP4 → OME-Zarr.

---

## 5. Layered creative-document formats and professional Layer View

> Open an authored image document in two complementary ways: show the
> application's authoritative integrated preview immediately, and also expose
> its layer tree so the visualizer can reconstruct the document as faithfully
> as the supported layer features allow.

Target formats, in suggested implementation order:

1. **OpenRaster (`.ora`)** — open interchange format used by GIMP, Krita,
   MyPaint, and Scribus; the best first format for a true layer import.
2. **Krita (`.kra`)** — easy authoritative preview via `mergedimage.png`, then
   progressively import ordinary paint layers and masks.
3. **Photoshop (`.psd`, `.psb`)** — broadest interchange value; build from the
   current composite/structure preview toward rasterizable and cached layers,
   while preserving unsupported document nodes in the tree.
4. **GIMP (`.xcf`)** — documented but evolving native format; decode tiled
   pixel layers, hierarchy, masks, visibility, offsets, and opacity before
   expanding into GIMP-specific effects and blend semantics.
5. **Affinity Photo (`.afphoto`, and version-dependent `.af`)** — initially
   expose only a clearly labelled embedded preview and basic metadata. Its
   proprietary, unpublished document model makes native layer support a
   demand-driven reverse-engineering project rather than a compatibility
   promise.

The feature must not conflate **preview fidelity** with **reconstruction
fidelity**. A file-provided merged/composite image is the authoritative
reference and should remain available even when the Layer View cannot yet
reproduce every operation. The reconstructed view must say which nodes were
used, approximated, rasterized from cached pixels, or ignored.

### Shared layered-document model

Introduce a format-neutral `LayeredDocument` representation between format
decoders and the Layer View. Format processors populate this model instead of
directly mutating `LayerManager`:

```text
LayeredDocument
├── canvas: size, resolution, color model/profile, bit depth
├── authoritativePreview: pixels + origin/source + freshness diagnostics
├── root: LayerNode[]
│   ├── group: children, isolation/pass-through, clipping scope
│   ├── raster: pixels/cached pixels, bounds, alpha, masks
│   ├── text/vector/smart-object: semantic metadata + optional cached pixels
│   ├── adjustment/fill/filter: operation parameters + affected scope
│   └── unsupported: preserved metadata and reason
├── resources: ICC profiles, linked/embedded assets, fonts, patterns
└── warnings: unsupported, approximated, missing, or unsafe features
```

Each `LayerNode` needs a stable document ID, name, type, parent, order,
visibility, opacity, fill opacity, blend mode, bounds, transform, clipping
relationship, masks, and a support state:

- **native** — represented and composed by the visualizer;
- **cached-raster** — displayed from pixels stored by the source application;
- **approximate** — mapped to the closest available operation;
- **inspect-only** — metadata and/or raw pixels can be inspected but not
  included faithfully in the reconstruction;
- **unsupported** — retained in the tree with a concrete explanation.

Decoders should be able to parse document structure without decoding every
pixel buffer. Pixel payloads must be lazy and cancellable so opening a large
PSD/XCF/KRA does not allocate the integrated preview plus every layer at once.

### Dual-view workflow and UI

Add an explicit document-view selector:

- **Integrated Preview** — the embedded merged/composite image authored by the
  source application. This is the default when present and the fidelity
  reference for comparison.
- **Layer Reconstruction** — the result produced by our compositor from all
  currently supported nodes.
- **Difference** — absolute or signed pixel difference between the integrated
  preview and reconstruction, with error statistics and a heatmap. This makes
  missing semantics visible and gives development a measurable compatibility
  target.
- **Solo Layer / Solo Group** — display a layer's raw or cached pixels without
  requiring the complete document to be composable.

The layer tree now supports first-class nested group surfaces, persistent
expand/collapse, layer and group visibility/opacity/blend controls, Shift-solo,
source support-state badges, inline renaming, filtered/cropped layer thumbnails,
raster-mask badges, and editable clipping relationships. Remaining tree work is
lock indicators, independent mask inspection/editing, search/filter, selection, and a node-details
view. Selecting an unsupported node should show its parsed metadata and why it
cannot currently be rendered; unsupported nodes must never be silently dropped.

Keep the source document read-only. Visibility, order, transforms, blend
settings, and temporary edits are session overlays until a deliberate export
format is designed. Preserve those overlays in webview state without implying
that the original PSD/XCF/KRA/Affinity document has been modified.

### Layer View changes required for compatibility

The compositor now retains per-pixel alpha for normal RGBA layer stacks while
keeping scientific arithmetic in exact RGB/value space. Professional document
compatibility still requires a fuller color-compositing path without changing
the existing raw-value behavior.

#### Alpha, masks, and coverage

- Normal straight-alpha RGBA composition is implemented. Add explicit
  straight/premultiplied conversion and validate mixed representations; do not
  use NaN as the general-purpose transparency representation for authored
  documents.
- Combine per-pixel alpha, layer opacity, fill opacity, raster masks, vector
  masks, and group masks in the correct order.
- Support mask bounds, offsets, inversion, density/opacity, enable/disable,
  and independent mask inspection. Feathering can follow later.
- Preserve RGB values under zero alpha for inspection and round-tripping where
  the source format does so.

#### Blend modes and color math

- Split the blend-mode registry into **scientific/raw arithmetic** and
  **color/document** modes so additions for PSD/XCF/ORA do not change current
  float-image results.
- Add the common W3C/Photoshop/GIMP families: normal, dissolve where feasible,
  darken/lighten, multiply/screen, color dodge/burn, overlay, soft/hard light,
  difference/exclusion, subtract/divide, and component modes such as hue,
  saturation, color, and luminosity.
- Define whether each mode operates in encoded, linear-light, perceptual, or
  application-specific blend space. Preserve source blend/composite-space
  metadata and warn when falling back.
- Add deterministic CPU reference implementations and optional GPU kernels;
  both paths must pass the same golden tests within a documented tolerance.

#### Hierarchy, clipping, and transforms

- Isolated groups are now first-class compositing surfaces with group visibility,
  opacity, blend mode, and attached raster masks. Add pass-through groups,
  knockout semantics, and cached dirty-region updates next.
- Basic clipping chains now use the nearest unclipped sibling's alpha. Extend
  this with format-specific clipping scopes and knockout/isolation combinations;
  unsupported combinations must remain explicitly marked.
- Extend layer placement beyond integer `offsetX/offsetY`: affine transforms,
  subpixel translation, resampling choice, crop/bounds, and canvas clipping.
  Perspective/warp transforms can be a later capability shared with smart
  objects.
- Allow canvases to be defined by the document rather than the bottom layer,
  including layers wholly or partially outside the canvas.

#### Rich layer types

- Treat pixel layers as the baseline native type.
- Show cached raster data for text, vector, shape, and smart-object layers
  whenever the file provides it. Keep their semantic data in the inspector
  even before native rendering exists.
- Reusable non-destructive adjustment nodes now cover levels, curves,
  hue/saturation, brightness/contrast, exposure/gamma, invert, channel mixing,
  color balance, black-and-white conversion, threshold, posterize, and gradient
  maps. Compatible PSD adjustment records import into the CPU compositor. They
  remain approximate until application-specific color-space behavior is validated;
  add LUTs and common blur/sharpen filters next.
- Model adjustment scope correctly: the layer stack below, a clipped target,
  or a group. An adjustment layer without an input image is inspect-only, not
  a standalone raster layer.
- Add fill layers (solid, gradient, pattern) and vector masks only after the
  shared color/transform/mask infrastructure is stable.
- Optionally add blank transparent raster layers together with painting and
  annotation tools. A blank layer without brush/fill/shape editing has little
  value; when implemented, include undo/redo, brush bounds, and editable mask
  painting rather than presenting an inert empty surface.
- For smart objects and linked assets, expose embedded previews and metadata
  first. Recursive document rendering needs cycle detection, depth limits,
  missing-resource diagnostics, and a bounded cache.

#### Color management and precision

- Preserve source bit depth and channel precision through decode and
  composition; avoid forcing 16/32-bit authored documents through 8-bit
  canvas pixels before analysis. Mixed 8-bit creative documents and
  uint16/float scientific layers now composite in the base document's
  normalized working range, and 16/32-bit PSD raster payloads stay typed.
  KRA/ORA exports retain exact non-8-bit layer samples in namespaced TIFF
  Visualizer sidecars while writing ordinary 8-bit compatibility rasters.
  Native high-precision PSD/XCF/KRA writing remains: their current writers
  are 8-bit, and other editors may discard the namespaced sidecars when
  resaving a KRA/ORA file.
- Parse and expose ICC profiles, document color mode, transfer function, and
  rendering intent. Introduce a color-management service used by the CPU and
  GPU render paths.
- Start with RGB and grayscale. CMYK, Lab, indexed, duotone, spot channels,
  and application-specific blend spaces require explicit conversion and
  should fail or fall back visibly until validated.
- Distinguish auxiliary/spot channels from image alpha and make them available
  for solo inspection even when they are not part of the composite.

#### Performance and safety

- Decode containers and large pixel payloads in workers. Transfer typed arrays
  zero-copy where practical.
- Add lazy layer decode, thumbnail-first UI, visibility-driven loading,
  cancellation, decoded-layer LRU caching, and memory budgets. Report when a
  layer is unloaded or skipped because of a configured safety limit.
- Stream/unzip individual ORA/KRA entries instead of expanding the complete
  archive. Defend against path traversal, zip bombs, deeply nested groups,
  malicious dimensions, cyclic linked documents, and excessive allocation.
- Composite dirty regions only after layer edits; cache stable group results.
  Add GPU color compositing only after the CPU reference path is correct.

### Format implementation plans

#### OpenRaster (`.ora`) — first full layered format

Specification: <https://www.openraster.org/>. ORA is intentionally simple: a
ZIP container with XML stack metadata and PNG/SVG layer assets.

**Implementation status:** the worker now validates and parses `stack.xml`,
shows `mergedimage.png` immediately in a preview-only pass, then selectively
extracts referenced PNG layers in a background layer-only pass. It retains
groups and source-node properties, reconstructs normal alpha compositions,
measures them against `mergedimage.png`, and exposes an Integrated/Reconstructed switch. Compatible
raster nodes can be expanded into the existing Layers View. The unified exporter
writes an authoritative merged PNG plus editable raster/group entries; filters
are retained in the merged result and reported because ORA has no adjustment
layer model. Non-8-bit raster sources also carry exact sample arrays and numeric
type metadata in a namespaced TIFF Visualizer sidecar; standard ORA consumers
see the 8-bit PNG layer, while reopening the direct export here restores the
original int/float samples. Remaining ORA work
is lazy per-node extraction, non-normal SVG blend operators, SVG assets, masks,
color management, editable group properties with isolated group compositing,
and the remaining professional layer-tree features listed above.

- Register `.ora` in the editor, collection, comparison, and add-layer paths.
- Parse the MIME marker and `stack.xml` safely in the decode worker.
- Load the merged image as the authoritative preview and PNG layer entries
  lazily through the existing PNG decoder.
- Import names, nesting, order, visibility, opacity, offsets, alpha, and
  composite operation. Import thumbnails when present.
- Initially rasterize or mark SVG/vector entries as cached/unsupported;
  integrate native SVG rendering only after its CSP and external-resource
  behavior is constrained.
- Map supported blend modes exactly and retain unknown mode identifiers for
  future support.

**Acceptance:** ordinary GIMP/Krita/MyPaint ORA fixtures reproduce the merged
preview within the agreed pixel tolerance; every source node remains visible
in the tree; solo raster layers match their stored PNGs exactly.

**Difficulty: 3** for robust raster-layer support, **4** with broad blend,
mask, vector, and color-management fidelity.

#### Krita (`.kra`, preview-first)

Reference: <https://docs.krita.org/en/general_concepts/file_formats/file_kra.html>.
A normal KRA is ZIP-based and contains `mergedimage.png`, the rendered canvas.

**Implementation status:** the worker safely opens the ZIP container, uses the
full-size `mergedimage.png` with a `preview.png` fallback, parses the hierarchy
from `maindoc.xml`, and imports ordinary 8-bit RGBA paint layers from Krita's
native raw/LZF sparse-tile streams. Isolated groups, visibility, opacity, common
blend modes, transparency masks, and alpha-inheritance metadata feed the editable
compositor. Common levels, HSV, invert, threshold, posterize, brightness/contrast,
and color-balance adjustment layers/filter masks are translated from
`.filterconfig` into editable approximate compositor filters. Pass-through groups,
non-8-bit/color-managed paint devices, cached projections, advanced filters,
vector/generator nodes, and animation remain.
Opening uses complementary preview-only and background layer-only worker passes,
so the integrated image does not wait for paint-device and mask decoding.
The exporter writes 8-bit paint devices, hierarchy, merged/preview images, and
the supported filter configurations; raster masks and unsupported operations
are currently baked or reported. It also stores exact non-8-bit raster samples
in a namespaced TIFF Visualizer sidecar for lossless direct round-trips. Krita
uses the compatibility paint device and may discard that sidecar when resaving.

- Phase 1: safely extract `mergedimage.png`, preview/thumbnail, document info,
  and basic metadata; route the preview through the existing PNG pipeline.
- Phase 2: continue the implemented document/layer XML and ordinary paint-layer
  import with lazy tile loading, more color spaces/bit depths, and cached projections.
- Phase 3: extend the implemented common Krita filter/adjustment-mask subset
  with curves, channel-specific levels, gradient resources, generator layers,
  vector layers, and animation frames as demand warrants.
- Treat `.krz` separately: it intentionally omits `mergedimage.png`, so do not
  register it until reconstruction support can produce a useful result.

**Acceptance:** every supported KRA opens immediately from `mergedimage.png`;
ordinary paint-layer fixtures reconstruct closely; unsupported Krita nodes are
listed with their type and do not disappear.

**Difficulty: 2** for integrated preview, **4–5** for increasingly native KRA
composition.

#### Photoshop (`.psd`, `.psb`)

Reference: <https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/>.
The worker uses `ag-psd` for bounded PSD/PSB decoding. Continue validating and
documenting exact bit depths, color modes, compression types, maximum sizes,
and PSB behavior against representative fixtures.

**Implementation status:** PSD and basic PSB files expose their authoritative
8/16/32-bit composite plus the parsed layer/group tree, bounds, visibility,
opacity, kind, blend mode, cached raster pixels, common masks, clipping, and
supported adjustment descriptors. The exporter writes a new 8-bit PSD with an
authoritative composite, raster/group hierarchy, masks, clipping, and the
supported adjustment layers. PSD/PSB opening now performs complementary
composite-only and background layer-only worker passes, and ordinary 8-bit RGBA
composites use a zero-copy identity display path. Per-layer visibility-driven
loading, thumbnails, color profiles,
blend/group semantics, effects, smart objects, and genuinely large PSB files
remain unsupported or inspect-only.

- Phase 1: decode the composite image, dimensions, bit depth, color mode,
  profile, image resources, and basic metadata in the worker.
- Phase 2: expose the complete layer/group tree and lazily decode raster layer
  pixels, cached representations, masks, bounds, visibility, opacity, fill
  opacity, blend modes, clipping relationships, and thumbnails.
- Phase 3: implement common Photoshop blend/group semantics and adjustments;
  use cached pixels for text, shape, vector, and smart-object nodes while
  preserving their semantic descriptors for inspection.
- Phase 4: add selected layer effects and smart-object transforms. Keep
  unsupported descriptors intact and diagnostic rather than guessing.
- Add `.psb` only after 64-bit lengths/large-document behavior and strict
  memory limits are tested. Its potential size makes lazy decode mandatory.

**Acceptance:** the authoritative composite matches Photoshop's saved result;
solo pixel/cached layers match stored data; the reconstruction comparison
identifies and quantifies every unsupported source of visual difference.

**Difficulty: 3** for composite + basic raster inspection, **5** and ongoing
for high Photoshop composition fidelity.

#### GIMP (`.xcf`)

Reference: <https://developer.gimp.org/core/standards/xcf/>. XCF is documented,
but it is a living native format whose implementation remains the ultimate
reference.

**Implementation status:** a bounded worker parser reconstructs common 8-bit
RGB, grayscale, and indexed raster layers with offsets, visibility, opacity,
item-path hierarchy, common blend modes, and raw/RLE/zlib tile compression.
Decoded groups become isolated editable compositor surfaces. The exporter now
targets GIMP 3 with XCF v22 and 64-bit pointers, writing an 8-bit layered file
with hierarchy, offsets, visibility, opacity, common modes, and mapped GEGL/GIMP
effects. Raster masks and clipping are currently baked into layer alpha and
every approximation is reported. GIMP 3/XCF v20+
layer-effect records are parsed, with common GEGL levels, brightness/contrast,
exposure, invert, threshold, posterize, hue/chroma, saturation, channel/mono
mixer, and color-balance operations translated to approximate editable filters.
Remaining work includes native mask/channel writing, effect masks and resources,
broader precision/color models, text/vectors, additional GEGL operations and
blend/composite spaces, version coverage, and lazy tile decoding.

- Implement or adopt a bounded worker-side parser for the image header,
  properties, offset-based structures, tile hierarchies, uncompressed/RLE/zlib
  pixel payloads, layers, channels, masks, groups, text/vectors, and effects.
- Decode pixel tiles lazily and preserve straight-alpha RGB values.
- Import canvas properties, color model/precision/profile, layer positions,
  visibility, opacity, blend/composite spaces, groups, masks, selection, and
  auxiliary channels.
- If no authoritative full-resolution merged projection is stored, show a
  thumbnail/preview only as such and default to our reconstruction. Never
  present a low-resolution preview as pixel-accurate source data.
- Track XCF version support explicitly and add fixtures generated by multiple
  supported GIMP releases.

**Acceptance:** representative RGB/grayscale XCF files with paint layers,
groups, alpha, masks, offsets, and common blend modes reconstruct within
tolerance; newer unsupported properties are reported without corrupting the
rest of the document.

**Difficulty: 4** for common raster documents, **5** for broad current-GIMP
fidelity.

#### Affinity Photo (`.afphoto`, `.af`) — embedded preview only initially

Affinity's native format is proprietary and has no public specification.
Support must therefore be intentionally modest and version-gated.

**Implementation status:** supported signatures are scanned for bounded,
structurally valid embedded PNG streams and the largest preview is displayed
with an explicit non-authoritative warning. Document dimensions, freshness,
profiles, native layers, and version-specific metadata are not decoded. The
remaining work below is validation and metadata hardening; native layers stay
a separate demand-driven reverse-engineering project.

- Spike existing preview extractors against Affinity versions and platforms.
  Validate preview presence, dimensions, color profile, alpha, orientation,
  freshness, and whether it is full resolution.
- Register the format only when a reliable signature can be detected. Label
  the result **Embedded Affinity Preview**, including its actual dimensions;
  do not imply that layers or the full-resolution document were decoded.
- Extract safe basic metadata when understood, retaining unknown blocks as
  counts/sizes rather than attempting unstable interpretation.
- Recommend PSD/TIFF export for interoperable full-resolution use.
- Native Affinity layers remain a separate reverse-engineering effort and
  should start only with stable fixtures, explicit maintenance appetite, and a
  legal/licensing review. Reuse the shared `LayeredDocument` model if that work
  later becomes viable.

**Acceptance:** supported versions either produce an accurately labelled,
validated embedded preview or a clear unsupported-version message—never a
silent, possibly stale substitute for the document.

**Difficulty: 2** for a version-limited embedded preview, **5+ / unbounded**
for native layer reconstruction.

### Testing and fidelity programme

- Build a redistributable fixture matrix for every format: transparent pixel
  layers, partial opacity, offsets/out-of-canvas bounds, nested groups, masks,
  clipping, every supported blend mode, color profiles, 8/16/32-bit channels,
  malformed containers, and very large declared dimensions.
- Generate authoritative reference renders with GIMP, Krita, Photoshop, and
  Affinity where licensing/automation permits. Record the application/version
  that produced each golden image.
- Compare integrated preview, source-application golden, CPU reconstruction,
  and GPU reconstruction. Track maximum/mean channel error, differing-pixel
  percentage, and perceptual difference; set exact versus tolerance-based
  thresholds per operation/color space.
- Unit-test every blend/mask/alpha/transform primitive independently before it
  is enabled for imported documents.
- Fuzz all container/descriptor parsers and enforce nesting, dimension,
  decompression, time, and memory limits.
- Maintain a visible compatibility report per opened document and a versioned
  support matrix in this backlog or a dedicated compatibility document. Keep
  the README summary compact. "Opens" must state whether it means embedded
  preview, solo-layer inspection, approximate reconstruction, or validated
  composition.

### Suggested delivery phases

1. **Layered-document contract + dual-view UI:** integrated preview,
   reconstruction, difference view, support diagnostics, lazy payload API.
2. **Professional compositor foundation:** alpha, masks, group surfaces,
   clipping, common color blend modes, affine transforms, CPU goldens.
3. **ORA end-to-end:** first format validating the complete architecture.
4. **KRA preview + paint layers:** quick broad value, then progressive native
   imports.
5. **PSD composite + inspection:** decoder spike, composite, full tree, lazy
   raster/cached layers; expand fidelity by measured impact.
6. **XCF common raster subset:** build on the compositor proven by ORA/PSD.
7. **Advanced shared features:** adjustments, effects, vector/text rendering,
   smart/linked documents, color-management expansion, GPU acceleration.
8. **Affinity embedded preview:** opportunistic and explicitly not native
   document support.

### Layer compositor performance

The editable compositor now has four explicitly selectable implementations:
WebGPU, WebGL2, Rust/Wasm, and the TypeScript/JavaScript CPU reference. The development
selector is intentionally strict: a selected backend must render the document
itself or report the exact unsupported feature/error; it never silently changes
backend. The production default probes and selects WebGPU, then WebGL2, then
Rust/Wasm; JavaScript remains only as the final availability fallback and
manual correctness reference. Full-resolution CPU work runs in a dedicated
worker. Slider and curve
gestures request a preview capped at 768 pixels on the longest side. Their
trailing native render remains debounced while input is moving, but pointer/key
release cancels that timer and starts the final native-resolution render
immediately if the preview is already visible. A direct slider click first
presents its queued preview, then starts native work on the following animation
frame. Documents at or below 1500×1500 render natively without a preview pass;
discrete edits on larger documents use a short 60 ms settle delay.
Production compositor telemetry is aggregated per edit/slider gesture into one
line containing the preview count and timings plus the final native render;
per-pass phase logs remain console-only behind a code diagnostic flag.

The target architecture is:

- TypeScript owns the document model, UI, history, scheduling, and golden
  correctness implementation.
- Rust/Wasm now implements the current CPU compositor contract: all editable
  adjustments, global and clipped scope, clipped rasters, nested isolated
  groups, raster/adjustment/group masks, 1–4 channels, all integer/float
  storage types, creative and scientific blend modes, brightness masks, and
  NaN propagation. The remaining architecture step is to retain document
  assets and scratch surfaces in Wasm memory so edits pass compact parameter
  changes instead of recopied multi-hundred-megabyte pixel arrays.
- The WebGL2 compositor now implements the same current semantic surface for
  interactive and native-resolution display, including mixed TIFF/creative
  layers. Unsupported GPU environments and hardware limits are diagnosed, but
  the backend does not silently omit document features or switch renderers.
  Its ping-pong compositor clears only surfaces that provide an initial
  transparent input; full-canvas destination passes no longer receive
  redundant clears.
- A strict WebGPU renderer now covers the same raster/adjustment, clipping,
  mask, nested-group, common/scientific blend, NaN, normalization, and display
  semantics. It uses byte composition surfaces for ordinary 8-bit documents
  and half-float surfaces only when numeric inputs or arithmetic modes require
  them, avoiding unnecessary 5k texture memory. Preview and native surface sets
  are retained separately, pipelines compile concurrently, and redundant
  full-surface clears are omitted. Identical layer states reuse their retained
  final composition independently at preview and native resolution. Phase
  timing separates scheduling, queueing, initialization, preparation, encoding,
  GPU completion, validation, canvas copy, upload CPU time, allocations, and
  total latency. WebGPU availability and device limits fail explicitly;
  selecting it never falls back to WebGL, Wasm, or JS.
- All four implementations run the same golden document corpus. Backend parity
  is measured per pixel with documented precision tolerances.

Caching now operates at four levels:

- display-only changes reuse the last composed float surface;
- prepared Levels/Curves LUTs are retained by adjustment identity;
- unchanged clipping stacks and isolated group branches reuse their surfaces;
- WebGL2 retains filtered raster-stack textures independently at preview and
  native resolution, invalidating only the stack whose pixels/filter settings
  changed;
- localized ordinary-raster edits recompose and patch only the union of the
  old/new drawable bounds. Adjustment, group, mask, and clipped-node changes
  conservatively retain the full-render path.

Repeatable commands and results from the July 2026 development machine:

- `npm run benchmark:layers`: 1024×1024, six RGBA rasters + three filters,
  approximately 386 ms median;
- `npm run benchmark:layers:4k`: 3840×2160, four RGBA rasters + three filters,
  approximately 3.20 s median;
- `npm run benchmark:layers:8k`: 7680×4320, three scalar rasters + two filters,
  approximately 4.82 s;
- the 768×432 four-RGBA-layer interaction workload is approximately 122 ms
  median before worker messaging, visualization, and canvas upload.
- the strict WebGL2 conformance workload with three 5000×5000 RGBA rasters and
  nine adjustments measures approximately 6.27 s cold, 1.07 s when every
  filtered stack is retained, on Playwright's browser environment. A
  single-stack filter edit is separately tested so unchanged stacks remain
  cached; hardware-backed VS Code measurements are still required.
- the strict WebGPU native 5000×5000 single-RGBA-layer cold path measures
  approximately 1.29 s on Playwright's software WebGPU environment, including
  upload, composition, display conversion, and strict GPU/CPU sample checks.

**Acceleration programme:** finish the persistent Rust/Wasm document engine,
dirty tiles, cached group/filter surfaces, and Wasm SIMD where available.
Extend retained WebGL2 surfaces to nested group branches and add tiled GPU
surfaces for documents beyond `MAX_TEXTURE_SIZE`. Extend WebGPU retention to
unchanged filtered stacks/group branches and evaluate compute kernels for
compute-heavy masks and filters. Keep the shared conformance corpus as the
semantic contract instead of allowing backend-specific layer behavior.

Remaining performance validation is platform coverage: record worker,
visualization, and canvas-upload timings on the supported desktop and web VS
Code targets, then define release budgets and GPU enablement thresholds. Add
separate cold/warm measurements for asset upload, interactive 768 px rendering,
native rendering, filter-only edits, visibility changes, and export.

This is a **Difficulty: 5 programme**, not one feature. The first useful
increments (KRA integrated preview or ORA raster layers) are Difficulty 2–3;
professional-tool-level reconstruction is an ongoing compatibility effort that
should ship format and operation support incrementally behind honest per-node
diagnostics.

---

## 6. Lens undistortion (Fisheye624 and other camera models)

> Toggle between raw fisheye/distorted capture and a rectified view, using a
> real camera model instead of a generic lens-correction filter.

**Prerequisites:** none — independent of the multi-IFD/OME-TIFF/format work
above. Pure webview/worker render-path addition; no decoder changes needed. Can
be slotted in whenever, including before OME-TIFF.

**Reuse from ply-visualizer:** the neighboring `ply-visualizer` project already
has most of the hard math. Its WASM crate lives at
`ply-visualizer/wasm/tiff-decoder/src/camera_models.rs` — note it's the _same_
crate name (`tiff-wasm`) as this project's `wasm/tiff-decoder`, so porting is
close to a direct copy, not a reimplementation. It implements `project`/
`unproject` for six models (`pinhole-ideal`, `pinhole-opencv`,
`fisheye-equidistant`, `fisheye-opencv`, `fisheye-kb3`, `fisheye624`), each with
its own coefficient set (Fisheye624: `k0..k5, p0, p1, s0..s3`), plus validation
and round-trip tests (`camera-model-wasm.spec.ts`,
`camera-model-goldens.json`). The TS wiring pattern is in
`ply-visualizer/engine/src/depth/cameraModels.ts`, and calibration-input
handling (form + YAML parsing) is in `depth/calibrationForm.ts` /
`depth/YamlCalibrationParser.ts` — worth copying the input UX, not just the math.

**The gap ply-visualizer doesn't fill:** it uses these models to project 3D
points into pixel space for depth/point-cloud work, but never maps a
rectified _image_ back through per-pixel remapping — there's no "undistort this
2D image" path today. That's the actual new work here:

- For each output (rectified) pixel, cast a ray and run the model's forward
  `project()` (already ported) to find the source pixel — this is the easy,
  closed-form direction; no iterative solve needed (that's only for going
  distorted → 3D ray, i.e. `unproject()`, which ply-visualizer also has if
  ever needed).
- Precompute a remap LUT once per (camera model, coefficients, output size);
  applying it is a single bilinear-sample pass. Natural fit for the decode
  worker, or the Rust/WASM side for speed.
- Non-destructive view transform, same shape as `displayColormap`: the raw
  Float32Array stays untouched; remap happens in/just before
  `ImageRenderer.render()`.
- **Pixel inspection caveat:** after remapping, displayed values are
  interpolated, not raw — this matters a lot for depth/disparity data, where
  interpolating across an edge invents geometry. Offer a nearest-neighbor
  option, and have the pixel inspector report the source (distorted) image
  coordinate alongside the rectified one.
- Calibration input is the real design question, not the math: TIFF/EXR/etc.
  carry no intrinsics, so this needs a sidecar JSON/YAML convention, a
  paste-your-params form, or both — reuse `calibrationForm.ts` /
  `YamlCalibrationParser.ts` as a starting point.

**Difficulty: 3** (mostly UI + remap plumbing; the camera-model math is
largely already written and tested in the neighboring project).

---

## 7. Measurement and quantitative analysis (ImageJ-class)

> Make the viewer able to answer "how big is that object, how bright is this
> region, how many of these are there" — the workflows people currently leave
> the editor and open Fiji for.

**Why this is worth doing:** ImageJ/Fiji is the de-facto standard in scientific
imaging, but it is a separate heavyweight application with a 1997 AWT UI, one
level of undo, and a proprietary binary ROI format. napari needs a Python
environment, QuPath is scoped to digital pathology, CellProfiler has no
interactive viewer. Nobody occupies "measurement where the image already is."
There is currently **no VS Code extension** doing this — the only related work
is `ijmScanner`, a language-support extension for writing `.ijm` macros, not
published to the marketplace. This is an open niche, not a contested one.

**Prerequisites:** none hard. Physical-unit calibration is much better with
OME-TIFF metadata (item 2) already parsed, but works standalone from baseline
TIFF resolution tags.

### UI placement — one panel, zero bloat by default

The guiding constraint: someone who opens a TIFF just to look at it must see
**nothing** of this. Therefore:

- **Entry point:** a single **Measure** item in the existing image context menu
  (`imagePreview.ts`, the `custom-context-menu` builder), plus a status bar
  toggle alongside Histogram, plus a keybinding. One entry, not seven.
- **Surface:** a floating **Measure panel**, built on the exact pattern already
  used by `debayer-panel.ts` / `metadata-panel.ts` / `layers-panel.ts` —
  draggable, `show()`/`hide()`/`toggle()`/`isVisible()`, state persisted in the
  webview state blob next to `isDebayerPanelVisible`. **No new UI paradigm.**
- **Panel contents (tabs or stacked sections, one panel):** tool strip
  (rectangle / ellipse / polygon / freehand / line / point / wand) · ROI list ·
  measurement readout · calibration · segmentation controls.
- **Canvas interaction:** ROI drawing lives in an overlay layer over the image
  canvas, coexisting with the pan/zoom modal state in `zoom-controller.ts`.
  Drawing is only armed while the panel is open and a tool is selected;
  otherwise mouse behavior is exactly as today.
- **Results:** the measurement table renders in the panel, and "Open as CSV"
  posts to the extension host to open a real editor document — no modal
  windows, no second webview.
- **Reuse, do not duplicate:** the ROI histogram is `histogram-overlay.ts`
  restricted to a mask; ROI statistics go through `ImageStatsCalculator`;
  region growing / labeling / threshold sweeps belong in the existing Rust/WASM
  crate next to `demosaic.rs`; heavy passes run in the decode worker.

### Core features (all seven, not a subset)

1. **Pixel calibration.** Auto-populate from TIFF `XResolution` /
   `YResolution` / `ResolutionUnit` and OME `PhysicalSizeX/Y/Z` where present —
   ImageJ usually asks; we should already know. Manual override by drawing a
   line on a scale bar and typing its real length. Anisotropic X/Y supported.
   Feeds a scale-bar overlay and physical-unit pixel readouts.
2. **ROI tools.** Rectangle, ellipse, polygon, freehand, straight/segmented
   line, multi-point. Editable vertices, move/resize, add/subtract composition,
   named ROIs, per-ROI color.
3. **Measurements.** Per ROI: area, perimeter, mean/min/max/median/StdDev,
   integrated density, centroid and center of mass, bounding box, fitted
   ellipse (major/minor/angle), Feret diameter (max/min/angle), circularity,
   solidity, aspect ratio. Selectable column set (ImageJ's "Set Measurements",
   without the modal dialog). Live-updating as an ROI is dragged.
4. **Line profile.** Intensity along a line or polyline, with adjustable line
   width (averaged perpendicular band). Reuses the plotting infrastructure from
   `histogram-overlay.ts`. Multi-channel plots one series per channel. Export
   as CSV.
5. **Threshold and particle analysis.** See the dedicated subsection below —
   this is where we do more than reimplement.
6. **Wand / click-to-select.** Click inside a region, get an ROI. Not ImageJ's
   naive fixed-tolerance flood fill; see below.
7. **Multi-point counter.** Numbered markers, running count, categories with
   distinct colors, export as CSV. Trivially cheap, heavily used.

### Where we beat ImageJ

- **ROIs as a text sidecar.** Persist as `image.tif.rois.json` next to the
  image: human-readable, diffable, reviewable in a pull request, editable by
  hand or by script. ImageJ's `.roi`/`RoiSet.zip` is opaque binary. This is the
  single strongest argument for "measurement inside the editor" and something
  none of Fiji/napari/QuPath offers.
- **ImageJ `.roi` interop (read and write).** The format is a documented binary
  header — magic `Iout`, version, type byte, bounds, then coordinates as int16
  offsets from the bounding box (polygon/freehand/traced), plus subtypes for
  ellipse/line/point and an optional trailing header2 with the name and
  per-ROI properties. `RoiSet.zip` is a plain ZIP of those entries, and **pako
  is already bundled**, so the container costs nothing. Import is the adoption
  path (people arrive with existing ROI sets); export is the escape hatch that
  makes trying us risk-free. Also worth supporting QuPath/GeoJSON on export.
  **Difficulty: 2** for read, +1 for write.
- **Measurements always on raw data.** Statistics run on the stored
  Float32Array, never on the post-normalization/gamma display buffer. We
  already model this distinction correctly (`colorPickerModeStatusBarEntry`,
  the raw-versus-modified split); ImageJ silently measures the display
  transform in several paths and it is a recurring source of wrong numbers.
  NaN/Infinity are excluded from statistics and reported as a separate count,
  using the same `!Number.isFinite()` guard as the render and histogram paths.
- **Real undo.** Full ROI edit history. ImageJ has effectively one level.
- **Interactivity.** Threshold and segmentation previews recompute per frame in
  WASM/GPU; in Fiji these stutter on large images and people stop exploring.
- **Results as an editor document.** CSV opens as a normal tab — copy, diff,
  commit. No modal Results window.
- **No setup.** No JVM, no Conda environment.

### Threshold + particle analysis — improve the workflow, don't copy it

The actual pain is not the computation, it is guessing the number. Four
changes, roughly in order of value:

- **Threshold stability curve.** Sweep the threshold across the full data range
  once (cheap in Rust: one pass per candidate on a downsampled image, or an
  incremental union-find over sorted pixels) and plot object count and total
  area against threshold. Plateaus are exactly the values where the answer does
  not depend on the guess. The user picks a plateau instead of nudging a slider
  blind. This is the MSER insight applied to the UI, and nothing in the field
  currently shows it.
- **Auto-threshold gallery.** Otsu, Li, Triangle, Yen, Huang, IsoData,
  MaxEntropy, Mean, Moments, Percentile, Shanbhag rendered as a live grid of
  small previews with object counts. ImageJ's "Try all" produces a static
  montage in a new window; ours is clickable and updates with the preprocessing
  chain.
- **Local adaptive thresholding** (Niblack, Sauvola, Phansalkar) plus optional
  non-destructive preprocessing for segmentation only — rolling-ball background
  subtraction, Gaussian blur — that never touches the displayed image. Uneven
  illumination is the number one reason a global threshold fails, and it is why
  people conclude "there is no right value".
- **Watershed splitting** of touching objects, with a preview of the split
  lines before committing.

For "I just want to mark this one cell", global thresholding is the wrong tool
entirely:

- **Click-to-segment with hover preview.** Seeded region growing from the click
  point with a tolerance derived from local statistics rather than a fixed
  global number. Hovering already renders the ROI a click would produce, so
  there is no click–undo–retry loop. Scroll wheel (or drag distance) widens or
  tightens tolerance live, with the boundary redrawn each frame.
- **Boundary-snapping trace (livewire / intelligent scissors)** for objects
  region growing cannot separate: click a few points, the path snaps to the
  strongest gradient between them.
- **Brush refinement.** Add/subtract to an existing ROI mask with a circular
  brush. Automatic segmentation is never perfect and every tool that lacks this
  forces a restart from scratch.

Explicitly **not** in scope: ML segmentation (Cellpose/StarDist/ilastik).
Different league — needs model weights and a GPU backend, and it does not
belong in an editor extension.

### Results and export workflow — kill the copy-into-Excel step

In practice, ImageJ output gets pasted into Excel almost universally. That is
not a preference for spreadsheets; it is three gaps in the tool, and each one
is fixable at the source.

**Gap 1 — provenance is dropped on export.** The Results table says
`Area 412.7` but not from which file, channel, Z-slice, calibration, or
threshold. Users rebuild that context by hand. Fix: emit **long/tidy CSV with
provenance columns by default** — `file`, `roi_id`, `roi_name`, `channel`,
`page`/`slice`, `unit`, `pixel_size_x/y`, `threshold_method`,
`threshold_value`, `preprocessing`, `extension_version`, `settings_hash`. One
row per ROI per channel. This alone removes a large share of the manual work.

**Gap 2 — no aggregation across images.** ImageJ measures one image at a time
and produces N tables; the actual question is "mean per condition, n, SEM".
Stacking those is the main reason Excel gets opened. Fix:

- A **single appending results table across the whole Image Collection** —
  that structure already exists in `imagePreview.ts` and needs no new concept.
- **Grouping columns derived from filenames** via a user-supplied capture
  pattern (e.g. `{condition}_{replicate}_{n}.tif` → real `condition` and
  `replicate` columns). This is precisely the join people perform manually.
- Optional per-group summary view (count, mean, SD, SEM) in the panel — for
  reading, with the raw long table still the exported artifact.

**Gap 3 — derived quantities.** Density as `IntDen/Area`, background
subtraction, normalization to a control. Fix: saved expression columns, stored
in the sidecar alongside the ROIs so a rerun reproduces them exactly.

**Things only we can do:**

- **Bidirectional row ↔ ROI linkage.** Selecting a table row highlights the ROI
  on the image and vice versa. Copy-paste into Excel destroys this link
  permanently — "which cell was row 47?" becomes unanswerable. Highest-value
  single item in this subsection.
- **Locale-correct and Excel-native output.** Write `.xlsx` directly in
  addition to CSV, and emit CSV with a UTF-8 BOM and a configurable decimal
  separator. German Excel reinterprets `412.7` as a date; that misparse is
  itself a cause of manual rework.
- **Python escape hatch.** Optionally drop an `analysis.py` or notebook next to
  the export that loads the CSV with pandas and groups by condition. Many users
  would prefer Python and are only avoiding the boilerplate — and we are
  already inside the editor where that file would live.
- **Reproducibility.** Because measurement settings live in the JSON sidecar,
  rerunning on the same image yields byte-identical numbers, and the sidecar
  diffs in review.

**Not in scope here:** built-in statistics (t-tests, ANOVA) or anything
resembling a spreadsheet. Export well and let Excel, pandas, or Prism do the
statistics.

**Difficulty: 2** for the CSV/provenance/collection-table core, +1 for xlsx
writing, expression columns, and filename-pattern grouping.

### Deliberately out of scope

- **The ImageJ macro language.** An idiosyncratic bespoke language with a
  recorder; enormous effort, and anyone who wants scripting reaches for Python.
  If automation becomes necessary, a small declarative JSON/TS recipe format.
- **3D/volume rendering, deconvolution, stitching, registration.** napari and
  Imaris territory; would distort the architecture. 3D specifically is not
  dropped but relocated — see item 10, which hands the volume to the
  `ply-visualizer` extension instead of growing a second render path here.
- **Full Bio-Formats** (~150 vendor microscopy formats, a Java monolith).
  OME-TIFF covers the overwhelming majority of what reaches this viewer.
- **A plugin API.** ImageJ's strength is a 25-year ecosystem; an empty plugin
  surface is pure maintenance cost. Only if users ask.
- **Destructive editing** (apply a filter, save the pixels). Non-destructiveness
  is a feature of this viewer, not a limitation.

### Suggested delivery order

1. Calibration (auto from tags + manual) and the Measure panel shell.
2. ROI tools, overlay layer, ROI list, JSON sidecar persistence.
3. Measurement table with the full column set, live update, bidirectional
   row ↔ ROI selection, and long-format CSV export with provenance columns.
4. Line profile.
5. ImageJ `.roi` / `RoiSet.zip` import, then export.
6. Threshold: live preview, auto-threshold gallery, stability curve, local
   adaptive methods, preprocessing chain.
7. Particle analysis: connected-component labeling in Rust, per-object
   measurements, size/shape filters, watershed.
8. Click-to-segment with hover preview, brush refinement, livewire.
9. Multi-point counter, scale-bar overlay, physical-unit readouts everywhere.
10. Collection-wide appending results table, filename-pattern grouping columns,
    expression columns, `.xlsx` output, optional pandas starter script.

**Difficulty: 4** overall (a multi-week epic; steps 1–4 alone are a **2–3** and
already deliver a usable product).

---

## 8. Multi-channel compositing (scientific "Display Adjustment")

> GFP green + DAPI blue + RFP red, additively blended, each channel with its own
> LUT, opacity and min/max — instead of one channel at a time.

**Why:** this is the single most recognizable feature of Imaris/arivis/Fiji's
Composite mode, and the point at which a microscopy user decides whether a
viewer was built for them. Item 2 already parses channel names and colors from
OME metadata, but the viewer still shows one channel per page.

**Do not confuse this with item 5.** The blend/composite machinery in the
layered-document work is about *authoring* semantics (Photoshop/GIMP blend
modes, clipping, groups, application-specific blend spaces). This is *raw
arithmetic* over scientific channels: each channel is scaled by its own
normalization range, tinted by its LUT color, and summed. It belongs to the
scientific arithmetic side of the blend-mode registry split described in item 5,
and should reuse that split rather than the creative blend path.

**Implementation notes:**

- A **Channels panel**, same pattern as `debayer-panel.ts` / `metadata-panel.ts`
  — one row per channel: visibility, color swatch (from OME `Channel/@Color`
  where present, otherwise a sensible cycle), opacity, and its own min/max
  slider pair backed by that channel's statistics.
- Composite rendering is a GPU-natural operation: upload the per-channel planes
  once, blend in the fragment shader in `webgl2-float-renderer.ts` / the WebGPU
  path. The CPU path stays as the fallback and correctness reference, as
  everywhere else.
- Per-channel statistics must be computed and cached separately; the existing
  `ImageStatsCalculator` currently reasons about the image as a whole.
- The histogram overlay already supports per-channel display — extend it to
  reflect the per-channel ranges rather than the global one.
- Colormaps: `getColormapLut()` supplies the tint LUTs, so pseudocolor and
  compositing share one source of truth.
- Interaction with the existing single-channel view is a mode, not a
  replacement: single-channel inspection stays the default for 1-channel images
  and remains reachable via channel solo.

**Difficulty: 2.** Highest value-per-effort item remaining after item 1.

---

## 9. Time and Z playback, frame export

> Press play and watch the time series, instead of dragging the T slider.

The C/Z/T sliders from item 2 and the page navigation from item 1 exist, but
everything is manual. Playback needs no new render path — only a timer over the
existing page-change path plus the already-planned neighbor prefetch.

**Implementation notes:**

- Play/pause/loop with configurable FPS, bound to the T axis by default and
  switchable to Z. Reuse the page overlay UI; a transport control belongs next
  to the existing slice indicator, not in a new panel.
- Playback makes the "cache decoded pages and preload neighbors" follow-up from
  item 1 a hard prerequisite rather than a nicety: stuttering playback is worse
  than no playback.
- **Frame export:** write the current view (with all display settings applied)
  across a T or Z range as a numbered PNG sequence, through the existing export
  path. Animated GIF/WebP output is a possible later addition; a numbered
  sequence is what people feed into ffmpeg anyway.
- Keyframe/camera animation as Imaris offers it is deliberately excluded — it
  only becomes meaningful with a 3D camera, and therefore belongs with item 10.

**Difficulty: 2** (playback), **+1** for frame-sequence export.

---

## 10. Hand a volume to the 3D viewer (ply-visualizer bridge)

> "Open stack in 3D viewer" — volume rendering and isosurfaces without a second
> render path in this extension.

Item 7 rules out 3D/volume rendering here, and that stays correct: the render
pipeline is 2D `ImageData`/canvas plus per-slice GPU paths, and a volume
raycaster is a fundamentally different renderer. But the neighboring
`ply-visualizer` extension already has Three.js, WebGPU, camera controls and
transform matrices — and knows nothing about intensity stacks, channels or
normalization, which is exactly what this extension does know.

So neither extension should grow the other's half. Build a **bridge** instead:

- A command that takes the currently decoded stack — the full Z (and optionally
  C/T) volume, voxel spacing from OME metadata, per-channel LUTs and
  normalization ranges — and hands it to `ply-visualizer`.
- Transfer as a typed-array payload with an explicit descriptor
  (dimensions, dtype, spacing, units, channel table), versioned, so the two
  repositories can evolve independently. This is the one piece of shared
  contract; everything else stays local to each extension.
- The 3D side (volume raycasting with a transfer-function editor, clipping
  planes, marching-cubes isosurface extraction, object/track overlays) is
  tracked in `ply-visualizer/docs/BACKLOG.md` and is not this repository's work.
- Isosurface extraction is the interesting split: the heavy pass would run in
  the Rust/WASM crate here (next to `demosaic.rs`), and the resulting mesh is an
  ordinary mesh for the 3D viewer to render — its core competence.

**Prerequisites:** item 1 (all pages decodable) and item 2 (voxel spacing,
channel semantics). Memory is the real constraint: a full float volume can be
gigabytes, so the descriptor must support sending a downsampled level, and
pyramidal loading (item 3 / whole-slide tiling) is what makes large volumes
practical.

**Difficulty: 3** for the bridge and payload contract on this side; the 3D
renderer itself is separate and lives in the other repository.

---

## Other ideas worth considering

- **Physical-unit readouts everywhere.** Once voxel spacing exists (item 2), show
  scale bars, measure distances/areas in µm, and report pixel positions in real
  units. Cheap once the metadata is parsed. Folded into item 7. **Difficulty: 2.**
- **Orthogonal views / max-intensity projection** for Z-stacks (XY / XZ / YZ, and
  MIP). Natural follow-on to items 1–2; leverages that all pages are decoded.
  **Difficulty: 3.**
- **Pyramidal/tiled BigTIFF viewport loading.** Many whole-slide (`.svs`) and
  large OME-TIFFs are pyramidal — decode only the visible tiles at the right
  resolution level. Shares the lazy-loading infra with item 3. **Difficulty: 4.**
- **Region-of-interest statistics.** Superseded by item 7, which covers this as
  its first deliverable.
- **Remove geotiff fallback.** Make sure the rust implementation covers all cases currently geotiff covers
- **Add debayering mode for grey scale images** Have a small menu, where you can select the typical debayering pattern, the offset and also allow infrared output. Then allow selecting the shown channel, rgb, just a single color channel or f.e. an infrared channel. All interactive and quick, thanks to rust. What is typical also done during debayering? Some white balancing or is this not required there?
- **Testdata:** Keep in mind a lot of test data is currently stored at /Users/florian/Projects/cursor/test_data/testfiles.

---

## Current hardening milestone — implemented

- [x] Replace the lightweight comparison-panel path for **Select for Compare** /
      **Compare with Selected** with VS Code's native side-by-side editor layout.
      Each side is a complete custom editor, so TIFF/HDR decoding, histogram,
      pixel inspection, and acceleration remain available.
- [x] Compare the currently displayed collection or dataset entry, not merely
      the URI that originally created the editor.
- [x] Refresh the Layers histogram from the rendered composite after edits on
      every compositor backend.
- [x] Keep hidden-histogram cost at zero readbacks/allocations/timers; when
      visible, cap composite sampling at 262,144 pixels and debounce gestures.
- [x] Explain that collections cannot be added inside Layers View and direct
      users to **Add Image as Layer**.
- [x] Hide/block original-versus-modified color-picker switching in Layers View,
      where pixel inspection represents the rendered composite.
- [x] Prefer WebGPU automatically for supported normal, HDR/scientific, dataset,
      and collection rendering; retain WebGL2 and CPU fallback, honor live GPU
      configuration changes, and expose the active renderer in Metadata.

## Suggested next steps

1. **Accelerator conformance and release budgets.** Expand the shared golden
   corpus so WebGPU, WebGL2, Wasm, and JavaScript are compared across normal,
   collection/dataset, and Layers surfaces, including HDR, NaN/Infinity,
   1/2/3/4 channels, normalization, gamma, colormaps, masks, and large images.
   Record cold/warm upload, settings-only rerender, canvas-copy, and histogram
   costs on supported desktop and web VS Code targets.
2. **Unify view-state semantics.** Give side-by-side full editors optional
   synchronized zoom/pan and make the active backend/fallback reason visible
   without opening developer tools. Keep settings session-wide, but viewports
   independent unless synchronization is explicitly enabled.
3. **Large-image GPU tiling.** Add texture tiling for normal and Layers views
   beyond a device's `MAX_TEXTURE_SIZE`, retaining WebGL2/Wasm/CPU fallback
   until all tiles are resident and avoiding full-canvas CPU readback.
4. **OME channel-to-layer compositing.** This is the strongest user-facing next
   feature now that multidimensional navigation and the layer engine both
   exist; add per-channel tint/colormap settings and a merged channel view.
5. **OME-Zarr, local first.** Reuse dataset navigation, then add chunked remote
   access once local hierarchy, metadata, and cache behavior are stable.
6. **Pyramidal/tiled viewport loading.** Decode only visible tiles at the
   appropriate level for whole-slide and very large OME-TIFF data.
7. **Lens undistortion.** Independent and ready to schedule when calibrated
   camera workflows become a priority.
8. **Measurement and ROI analysis (item 7).** The largest unclaimed
   user-facing niche — no VS Code extension does it, and the incumbents are all
   separate heavyweight applications. Independent of the format and accelerator
   work, so it can run in parallel. Start with calibration + ROI tools +
   measurement table; the threshold/segmentation half is where the genuine
   workflow improvements over ImageJ live.
