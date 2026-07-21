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
- Remote support also means handling URLs, range requests, and caching in the
  decode worker; today everything assumes local file bytes.

**Difficulty: 4 (OME-Zarr) → 5 (HDF5 + general remote/lazy infra).** Recommend
scoping to **OME-Zarr, local first, then remote URLs**, and deferring HDF5.

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

---

## 5. Lens undistortion (Fisheye624 and other camera models)

> Toggle between raw fisheye/distorted capture and a rectified view, using a
> real camera model instead of a generic lens-correction filter.

**Prerequisites:** none — independent of the multi-IFD/OME-TIFF/format work
above. Pure webview/worker render-path addition; no decoder changes needed. Can
be slotted in whenever, including before OME-TIFF.

**Reuse from ply-visualizer:** the neighboring `ply-visualizer` project already
has most of the hard math. Its WASM crate lives at
`ply-visualizer/wasm/tiff-decoder/src/camera_models.rs` — note it's the *same*
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
rectified *image* back through per-pixel remapping — there's no "undistort this
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

## Other ideas worth considering

- **Physical-unit readouts everywhere.** Once voxel spacing exists (item 2), show
  scale bars, measure distances/areas in µm, and report pixel positions in real
  units. Cheap once the metadata is parsed. **Difficulty: 2.**
- **Orthogonal views / max-intensity projection** for Z-stacks (XY / XZ / YZ, and
  MIP). Natural follow-on to items 1–2; leverages that all pages are decoded.
  **Difficulty: 3.**
- **Pyramidal/tiled BigTIFF viewport loading.** Many whole-slide (`.svs`) and
  large OME-TIFFs are pyramidal — decode only the visible tiles at the right
  resolution level. Shares the lazy-loading infra with item 3. **Difficulty: 4.**
- **Region-of-interest statistics.** Draw a rectangle/polygon, get min/max/mean/std
  for that region — high value for scientific users, mostly webview UI on top of
  existing stats code. **Difficulty: 2.**
- **Remove geotiff fallback.** Make sure the rust implementation covers all cases currently geotiff covers
- **Testdata:** Keep in mind a lot of test data is currently stored at /Users/florian/Projects/cursor/test_data/testfiles.

---

## Suggested sequencing

1. **Multi-IFD decoding primitive** (item 0) — unblocks everything.
2. **Multi-page navigation** (item 1) — highest value-per-effort.
3. **OME-TIFF** (item 2) — the flagship feature; reuses layers + navigation.
4. **FITS + DICOM** (item 4) — broad, tractable audiences.
5. **OME-Zarr** (item 3, local then remote) — deferring HDF5 and the proprietary
   microscopy formats until there's demand.
