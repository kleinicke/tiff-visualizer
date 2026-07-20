# Backlog / Roadmap

Feature ideas for the TIFF Visualizer, with prerequisites, an implementation
sketch grounded in the current architecture, and a rough difficulty/effort
estimate. Difficulty is **1–5** (1 = a few hours, 5 = multi-week epic).

Ordering below is by suggested priority, not by the numbering the ideas came in
with.

---

## Foundational unlock: multi-IFD decoding (do this first)

Almost everything scientific below depends on one missing primitive. Today the
Rust/WASM decoder reads only the **main IFD** (`image_ifd()` in
`wasm/tiff-decoder/src/lib.rs`), so the extension treats every TIFF as a single
image. The `image-tiff` crate already exposes `next_image()` / `more_images()`
to walk every IFD in the file.

**The primitive to build:** teach the decoder to (a) enumerate all IFDs and
report a page count, and (b) decode an arbitrary page by index, not just the
first. Expose this through `tiff-wasm-wrapper.ts` and the decode worker.

Once this exists, both **multi-page navigation** and **OME-TIFF** become mostly
UI + metadata work. Build it once, reuse it everywhere. **Difficulty: 2–3.**

---

## 1. Multi-page / N-dimensional TIFF navigation

> `← Slice 12 / 325 →`, Time 4, Channel 2

Navigate the pages inside a single multi-page TIFF (Z-stacks, time series,
channels) instead of showing only page 0.

**Prerequisites:** the multi-IFD primitive above.

**Implementation sketch:**

- Reuse the existing image-collection navigation UI in
  `src/imagePreview/imagePreview.ts` (the `_imageCollection` / `_currentImageIndex`
  logic and the "2 / 5" overlay). Generalize it from "list of file URIs" to
  "list of pages within one decoded file," or run a second parallel index.
- Add prev/next keybindings for the page axis (the t/r keys are already taken by
  the file collection — pick new ones, or make the collection navigation
  page-aware when the current file is multi-page).
- Cache decoded pages; preload neighbors for smooth scrubbing (the collection
  already has a preload pattern to copy).
- Plain multi-page TIFFs have no semantic axis labels — so this first version
  shows "Page N / M." The Channel/Z/Time _labels_ come from OME metadata (item 2).

**Difficulty: 2** on top of the primitive. This is the highest value-per-effort
item — it makes the tool useful for microscopy/medical stacks immediately.

---

## 2. OME-TIFF support

> `cell_image.ome.tif` should expose Channels (GFP/DAPI/RFP), Z slices, Time
> points, Objectives, Voxel spacing.

The biggest single feature for attracting microscopy users. OME-TIFF is a
regular multi-page TIFF whose **first IFD's `ImageDescription` tag (270)**
contains an **OME-XML** document describing how the flat list of pages maps onto
the (Channel, Z, Time) dimensions, plus physical metadata.

**Prerequisites:** multi-IFD primitive (item 0) + multi-page navigation (item 1)
for the UI. We already read tag 270 for metadata display in `tiff-tag-utils.ts`
/ the metadata panel, so the tag is in hand — we just don't parse it as OME-XML.

**Implementation sketch:**

- Detect `.ome.tif`/`.ome.tiff` or an `ImageDescription` starting with `<OME`.
- Parse the OME-XML (a small dependency-free parser, or a tiny XML lib in the
  worker) to extract: `SizeC/SizeZ/SizeT`, `DimensionOrder` (e.g. `XYZCT`),
  per-`Channel` `Name`/`Color`, `PhysicalSizeX/Y/Z` (voxel spacing), and
  objective/instrument info.
- Map a `(c, z, t)` selection → flat IFD index using `DimensionOrder`. This is
  the whole trick; it turns item 1's "Page N" slider into three labeled sliders.
- Surface channel names as **layers** — the layer system
  (`layer-manager.ts` / `layer-compositor.ts`) already composites single-channel
  images with per-channel colormaps, which is exactly how you'd render GFP+DAPI+RFP
  as a merged pseudo-color image. This is a strong existing fit.
- Show voxel spacing / objective in the metadata panel; feed spacing into the
  size/pixel-position readout for real-world units.

**Difficulty: 4.** The XML parsing and dimension mapping are moderate; the payoff
is large. Split it: (a) parse + labeled sliders, (b) channel→layer compositing,
(c) physical units.

- Afterwards: Implement FITS, DICOM and NetCDF see below since they are also straight forward.

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
