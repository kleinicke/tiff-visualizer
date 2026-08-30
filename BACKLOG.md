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
      projection. DICOM RLE Lossless is also decoded. NetCDF-4/HDF5 and the
      remaining DICOM transfer syntaxes (JPEG Lossless, JPEG-LS, JPEG 2000, and
      video) remain part of the heavier codec/container follow-up described
      below.
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

**Hard constraint on codec dependencies: pure Rust only.** No C or C++ library
may be pulled in, including via `cc`/`bindgen` or as a prebuilt Emscripten
`.wasm` module. The drawbacks — toolchain fragility across the desktop and web
build targets, cross-compilation to `wasm32-unknown-unknown`, opaque memory and
failure behavior, and the maintenance cost of a second build system — outweigh
what any individual codec buys us. A codec with no viable pure-Rust decoder
stays unsupported and errors honestly rather than being worked around. This
rules out CharLS and OpenJPEG/OpenJPH as C/C++ sources; the `openjp2` crate (a
pure-Rust translation of OpenJPEG) is acceptable in principle but must be
verified to build for `wasm32-unknown-unknown` before being planned around.

1. ~~**DICOM RLE Lossless.**~~ Implemented — `decode_rle_lossless` in
   `crates/image-decoders/src/formats/dicom.rs` unpacks the PackBits byte
   planes straight from the encapsulated fragments.
2. **JPEG Lossless and JPEG 2000 DICOM transfer syntaxes**, in the order set out
   under "DICOM transfer syntax coverage" below. JPEG-LS depends on a pure-Rust
   decoder existing at all, so it is gated on that survey rather than scheduled.
3. **JPEG 2000 / HTJ2K standalone files (`.jp2`, `.j2k`, `.j2c`)**, sharing the
   decoded-pixel path with the encapsulated DICOM frames. Preserve signedness,
   component count, and 12/16-bit samples instead of converting through 8-bit
   RGBA.
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

**Format expansion sequence from the current state:** DICOM JPEG Lossless →
JPEG 2000/HTJ2K → NIfTI → NRRD/MetaImage → MRC/CCP4 → OME-Zarr.

### DICOM transfer syntax coverage

Supported today: Implicit VR LE (`1.2.840.10008.1.2`), Explicit VR LE (`.1`),
Explicit VR BE (`.2`), JPEG Baseline (`.4.50`), and RLE Lossless (`.5`).
Everything else is rejected in `parse_dicom_context` with "Compressed or
unsupported DICOM Transfer Syntax". Ranked by how often each actually appears
in files users try to open, under the pure-Rust constraint above:

**1. JPEG Lossless, Non-Hierarchical, First-Order Prediction
(`1.2.840.10008.1.2.4.70`).** Best value per unit of effort and the recommended
next codec. This is the syntax behind a large share of legacy CT/MR/CR archive
data, so it accounts for most real "won't open" reports. It is also a small
codec — DPCM predictor plus Huffman, no DCT — on the order of a few hundred
lines of Rust. `jpeg-decoder` does not cover it (baseline and progressive
only), so this is a hand-rolled decoder or a dedicated pure-Rust crate. Its
sibling `.4.57` (Process 14 without SV1) follows almost for free.
**Difficulty: 3.**

**2. Deflated Explicit VR Little Endian (`1.2.840.10008.1.2.1.99`).** Not a
pixel codec at all: everything after the file meta group is raw-deflate
compressed. Inflate it, then hand the result to the existing native element
walk unchanged. Uncommon in practice, but close to free and worth taking
whenever the surrounding code is already open. **Difficulty: 1.**

**3. JPEG 2000 Lossless / Lossy (`1.2.840.10008.1.2.4.90` / `.91`).** The
dominant compressed syntax in modern PACS — mammography, ultrasound, most
vendor-neutral archives — so it has the highest coverage of anything on this
list, and by far the largest codec. The only route compatible with the
pure-Rust constraint is the `openjp2` crate; confirm it builds for
`wasm32-unknown-unknown` and behaves under the worker's memory limits before
committing to it, and do not fall back to a C/C++ OpenJPEG or OpenJPH build if
it does not. **Difficulty: 4**, mostly dependency and validation risk rather
than integration.

**4. JPEG-LS Lossless / Near-Lossless (`1.2.840.10008.1.2.4.80` / `.81`).**
Increasingly common on newer DX/CR equipment. Blocked on decoder availability,
not on our own work: dicom-rs routes JPEG-LS through CharLS, which is C++ via
`cc` and therefore excluded. Needs a survey for a mature pure-Rust JPEG-LS
(LOCO-I) decoder; if none exists, this stays unsupported and errors honestly.
Do not schedule before that survey. **Difficulty: 4**, or unbounded if a
decoder has to be written from the spec.

**Explicitly out of scope for now:** MPEG-2/MPEG-4/HEVC (`.4.100`–`.102`,
`.106`) — cine ultrasound and endoscopy need a video decoder plus playback UI,
a different feature entirely, and the pure-Rust constraint makes it harder
still. JPEG Extended 12-bit (`.4.51`) is niche. HTJ2K (`.4.201`–`.203`) is
worth revisiting once JPEG 2000 exists, since it shares codestream
infrastructure.

Whatever is added, keep the existing shape: decode to native-form samples, then
run them back through the same `read_sample` / Rescale Slope-Intercept /
MONOCHROME1 pipeline the native path uses, so behavior stays uniform across
transfer syntaxes.

### DICOM color photometric interpretations

Color DICOM already works for the common cases: Samples Per Pixel 1/3/4 is
accepted, Planar Configuration 1 is de-planarized into interleaved output, and
the channel count flows through `ScientificParsed` into the normal render
pipeline. Compressed frames come back interleaved, and a JPEG Baseline frame is
reported as RGB because the decoder applied the inverse colour transform. Two
gaps remain, both in `crates/image-decoders/src/formats/dicom.rs`, where
`photometric` is otherwise only consulted for the MONOCHROME1 inversion:

- **Native (uncompressed) `YBR_FULL` / `YBR_FULL_422`.** No color conversion is
  applied, so raw Y/Cb/Cr samples are handed to the renderer as if they were
  R/G/B and the image displays with wrong colors instead of failing. Add the
  YBR→RGB conversion (and 422 chroma upsampling) after `decode_native_frame`,
  before Rescale Slope/Intercept.
- **`PALETTE COLOR`.** Samples Per Pixel is 1 plus Palette Color Lookup Table
  tags (0028,1101–1103 descriptors and 0028,1201–1203 data, 8- or 16-bit
  entries with a first-mapped-value offset). Those tags are never read, so the
  image renders as a grayscale index map rather than its intended color.
  Expanding it to three channels also has to bypass the Rescale Slope/Intercept
  and MONOCHROME1 paths, which are meaningless for indexed data.

Samples Per Pixel 4 is accepted but uninterpreted (no ARGB/CMYK handling) — it
becomes four generic channels. Left as-is until a real fixture turns up.

**Difficulty: 2.** Both are self-contained additions to the existing native
decode path; the main cost is fixtures, since neither variant is common enough
to have one lying around.

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

## 7. Measurement and quantitative analysis (ImageJ-class) — implemented

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

### Delivery status

- [x] Calibration (auto from OME and TIFF resolution tags, manual, and from a
      drawn line of known length) and the Measure panel shell.
- [x] ROI tools, overlay layer, ROI list, JSON sidecar persistence.
- [x] Measurement table with the full column set, live update, bidirectional
      row ↔ ROI selection, and long-format CSV export with provenance columns.
- [x] Line profile, with perpendicular band averaging and CSV export.
- [x] ImageJ `.roi` / `RoiSet.zip` import and export.
- [x] Threshold: live preview, auto-threshold gallery, stability curve, local
      adaptive methods, preprocessing chain.
- [x] Particle analysis: connected-component labelling, per-object
      measurements, size/shape filters, hole filling, watershed. Implemented in
      TypeScript rather than Rust — it is fast enough at these image sizes, and
      keeping it beside the ROI model avoids a WASM boundary for every slider
      drag. Move it to the crate only if a real image proves it too slow.
- [x] Click-to-segment with hover preview, brush refinement, livewire.
- [x] Multi-point counter, scale-bar overlay, physical-unit readouts.
- [x] Filename-pattern grouping columns, expression columns, `.xlsx` output,
      pandas starter script.

**Implementation notes:** the subsystem lives in `media/modules/measure/`
(`types`, `geometry`, `statistics`, `threshold`, `particles`, `segmentation`,
`imagej-roi`, `roi-io`, `expression`, `calibration`, `roi-manager`,
`roi-overlay`, `xlsx-writer`) with the UI in `media/modules/measure-panel.ts`.
`test/measurement-test.js` (`npm run test:measurement`) checks the numbers
against analytic answers and synthetic images with planted objects, not against
recorded output.

### Delivered after the first pass

Kept here so the history of what was added when stays legible:

- [x] Threshold preview overlay on the image (red = selected, green = survives
      the particle filters), hover previews in the method gallery, and results
      rows that scroll their object into view.
- [x] Draggable histogram range, scrubbable stability curve.
- [x] Split touching objects by intensity maxima with an adjustable prominence
      — ImageJ's Find Maxima with "Segmented Particles". Replaces the two-image
      AND workflow the Image Calculator needs there.
- [x] Any global method applied per window ("Auto Local Threshold"), with a
      minimum-contrast guard so uniform background is not carved up.
- [x] Maximum-area filter, and a **Summary** table (n, mean, SD, SEM, min, max
      per column) — ImageJ's "Summarize".
- [x] ROIs and calibration persisted in webview state, so a reload does not
      discard unsaved work.
- [x] Collection-wide results: rows accumulate across images, each keeping the
      scale, threshold and grouping it was measured with, so one export covers a
      whole folder without a per-image column lying about the others.
- [x] Automatic sidecar loading. Opening an image with `*.rois.json` beside it
      loads it, unless ROIs are already on screen — an automatic action must
      never discard work.
- [x] Column chooser, grouped the way ImageJ's "Set Measurements" is. It governs
      the table only; exports always carry every measured column.
- [x] Rotated rectangle and ellipse handles, with resizing done in the shape's
      own frame so a rotated box resizes rather than shears.

**Nothing from item 7 is outstanding.** What remains excluded is what its scope
excluded from the start (ML segmentation, 3D, a plugin API, the macro
language), plus one cross-item follow-up recorded under item 9.

**Difficulty: 4** overall (delivered as a multi-week epic).

---

## 8. Multi-channel compositing (scientific "Display Adjustment") — implemented

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

### Delivered

- [x] Channels panel (`channels-panel.ts`) with per-channel visibility, tint,
      opacity, black/white points and solo, plus auto/full range for one channel
      or all.
- [x] Additive compositing over raw values (`channel-composite.ts`), with
      per-channel statistics and a percentile auto-range. Covered by
      `test/channel-composite-test.js` (`npm run test:channels`).
- [x] Channel names and colours from OME `Channel/@Name` / `@Color`, with a
      distinguishable fallback palette.
- [x] Both storage layouts: interleaved multi-sample images, and OME-TIFF where
      each channel is its own IFD — sibling planes are decoded through the
      existing worker path at the current Z/T, generation-checked so a
      superseded navigation drops its results.
- [x] Colormap per channel as an alternative to a flat tint, sharing
      `getColormapLut()` with the pseudocolor path.

- [x] WebGPU compositing (`webgpu-channel-compositor.ts`), with the CPU path as
      the fallback and the correctness reference. The colour lookup table is
      built by the shared `prepareChannels()` for both backends, so the shader
      only normalises and accumulates and the two cannot drift apart. No WebGL2
      variant, deliberately: a second GPU path would double the surface for a
      backend on its way out. Over eight visible channels falls back to the CPU
      rather than truncating.
- [x] Per-channel histograms: one tinted curve per visible channel over its own
      display range, honouring solo, with out-of-range samples collected in the
      end bins so clipping stays visible.

**Nothing from item 8 is outstanding.**

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
- **Measure an ROI across the axis** (item 7 × item 9). Once frames can be
  stepped automatically, the natural extension is measuring the same ROI on
  every T (or Z) and emitting one row per frame — a kinetic curve instead of a
  single value. The measurement side needs nothing new beyond driving the page
  change and tagging each row with its frame index; the ROI model already
  carries `page`. This is the cheapest way to turn playback from a viewing
  convenience into an analysis feature. **Difficulty: 1** on top of playback.

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

### Implemented (August 2026) — DICOM series, uncompressed

The payload is **NRRD**, not a bespoke descriptor. It is a documented standard
(3D Slicer, ITK) that already carries a full affine, world units, dtype and
endianness, so the two repositories share a format instead of a private
contract they would have to version against each other — and the written file
is independently useful rather than being a wire message.

- `src/imagePreview/volumeExport.ts` assembles a series into one float volume
  and writes gzip NRRD in LPS with `space directions`/`space origin`.
- `dicomDataset.ts` now also reads `PixelSpacing` (0028,0030) and
  `SliceThickness` (0018,0050). It already had position and orientation, but
  only used them for a sort key; the 3D side needs the physical geometry.
- The bridge converts DICOM millimetres to the 3D viewer's metre-based world
  space while writing the NRRD affine and declares `space units: "m"`.
- DICOM window center/width and photometric interpretation are carried as NRRD
  key/value metadata for the 3D viewer's orthogonal-slice presentation.
- Slice spacing is measured from consecutive `ImagePositionPatient`, not from
  `SliceThickness` — thickness describes how thick a slice is, not how far
  apart consecutive slices sit, so it silently ignores gaps and overlap. When
  positions are unusable the export falls back and *says so* in a warning.
- `PixelSpacing` is `[between rows, between columns]`, so it cross-assigns to
  the column/row direction vectors. Swapping the two is the classic way to
  produce a subtly stretched volume.
- Rescale slope/intercept were already applied by `parseDicom`, so CT volumes
  carry true Hounsfield units; the export labels them `units:=HU` (CT only) and
  the 3D side uses that to default its isosurface to a physically meaningful
  threshold instead of an arbitrary one.
- Command: **Open DICOM Volume in 3D Viewer**
  (`tiffVisualizer.openVolumeIn3D`). Its multi-select defaults to the series
  currently on screen, writes every chosen series into a unique handoff folder
  in extension global storage, then asks ply-visualizer to open the first NRRD
  and add the remainder to the same scene. Large selections warn before decode.
- `test/volume-export-test.js` covers the geometry derivation, exports every
  series in the real dataset, and round-trips the 640x640x44 MR series through
  ply-visualizer's own NRRD parser.

**Known limit:** the host-side path uses `parseDicom`, which handles only
uncompressed transfer syntaxes. Compressed series (JPEG Baseline, JPEG-LS,
JPEG-2000) decode in the webview's WASM codecs, which the extension host cannot
reach — the export reports this rather than producing a volume with holes.
Fixing it means either running the assembly in the webview and posting bytes
back, or exposing the codecs host-side; the latter is item 11's shared-core
work.

**Gotcha this hit, worth remembering:** `src/` is bundled twice — `platform:
'node'` for `out/extension.js` and `platform: 'browser'` for
`out/extension.web.js`. So nothing under `src/` may import a Node builtin or use
`Buffer`; `import * as zlib from 'zlib'` type-checks and passes the Node build,
then fails the web build with "Could not resolve". The volume writer uses
`CompressionStream` and hand-rolled byte concatenation instead, which also keeps
it symmetric with the `DecompressionStream` the reader on the other side uses.

**Note on the tsconfig change this needed:** `rootDir: "src"` was dropped so the
host can import `media/modules/scientific-format-parsers.ts` rather than
reimplementing DICOM pixel reading. `typecheck:src` is `--noEmit` and the
shipped bundle comes from esbuild, so this constrains nothing and only widens
what is type-checked. It is a small down payment on item 11.

---

## 11. Shared core, host abstraction, and a possible desktop app

> Three steps in order. Step 1 pays off on its own, step 2 pays off on its own,
> and only both together make step 3 a shell rather than a port.

**The measurements this is based on** (August 2026): tiff-visualizer is ~40,100
lines of TypeScript against 5,800 lines of Rust; ply-visualizer is ~47,800
lines of TypeScript/Svelte against 7,560 of Rust. **Rust is roughly 13% of the
combined codebase** — the renderers, panels, layer compositor and format
processors are all web code. Any plan that implies rewriting those is not worth
evaluating.

### Product and web distribution decision (August 2026)

The public web presence is a **portfolio of independently shipped products**, not
one universal viewer and not a website loaded remotely by the extensions:

- Create a new repository for the main `f-kleinicke.de` landing page. It shows
  the current projects and links to each live application, marketplace listing,
  source repository, results page, and—when available—desktop download.
- Keep each substantial application on its own subdomain and deployment. The
  existing extension-statistics site remains at `extensions.f-kleinicke.de`;
  the point-cloud viewer, scientific-image viewer, and future barcode-scanning
  results get separate subdomains. They may share branding and navigation, but
  their build and release pipelines must not depend on one another.
- The standalone scientific-image site is another **host of the same local
  image engine** extracted below. The VS Code extension bundles that engine in
  its VSIX; it must not embed or depend at runtime on the hosted site. This
  preserves offline use, reproducible extension releases, CSP isolation, and
  privacy for local scientific and medical data.
- The point-cloud site continues to use `ply-visualizer/engine`, which already
  serves both its standalone browser application and VS Code webview. Do not
  revive the older separate `website-ply` implementation that drifted behind
  the extension.
- A future downloadable Tauri application combines the image and point-cloud
  engines in one desktop product. The two VS Code extensions remain separate,
  focused marketplace products.

Both extension repositories now use **npm** and commit only `package-lock.json`.
Do not introduce a cross-repository workspace: matching package managers do not
require coupling their builds or releases.

Suggested public shape (final subdomain names are a deployment concern):

```text
f-kleinicke.de                 portfolio / project landing page
extensions.f-kleinicke.de      VS Code extension statistics
<3d>.f-kleinicke.de            point-cloud and mesh live application
<images>.f-kleinicke.de        scientific-image live application
<barcode>.f-kleinicke.de       barcode-scanning results / demo
```

The landing page owns discovery; each linked application owns its actual UI,
assets, tests, hosting, and release cadence.

### Do not merge the two extensions

Stated here so the question stops being reopened. Against a merge: two
marketplace listings are two discovery paths for two audiences; the render
stacks share nothing (a Three.js scene with camera controls versus a 2D
canvas/WebGPU pipeline with normalization and a layer compositor), so a merge
means maintaining both inside one extension; and the only real synergy — 3D
volumes — is already covered by item 10 at difficulty 3 instead of 5.

Merge the **building blocks**, not the products. That is step 1.

### Step 1 — extract a shared core

**Status (August 2026): decoder extraction complete in this repository.**
[`crates/image-decoders`](crates/image-decoders) is now the plain-Rust,
feature-gated decoder crate, while `wasm/tiff-decoder` is a thin WASM adapter
plus application-specific measurement and compositor kernels. Moving that
directory to its own repository and switching PLY Visualizer from its old fork
to a pinned Git dependency are the remaining distribution/migration steps.

There is genuine duplication today: ply-visualizer reads TIFF, PNG, PFM, NPY,
NPZ and EXR as depth images — exactly six formats for which this repository
already has mature decoders, including the Rust/WASM path. Colormap tables
exist twice.

- Inventory first: which parsers are actually equivalent versus superficially
  similar (ply's depth readers care about camera models and invalid-pixel
  semantics this viewer does not model, and this viewer preserves sample depth
  and metadata that a depth reader discards). Only genuinely equivalent code
  moves.
- Shape: an npm workspace for the TypeScript side, a Cargo workspace for the
  crates. `wasm/tiff-decoder` and `ply-visualizer/wasm/pointcloud-parser`
  become members rather than islands.
- Candidates in likely order of payoff: format decoders → colormaps →
  statistics helpers → the WASM loading/worker plumbing.
- Low risk and reversible: neither product changes behavior, and both keep
  shipping independently. Combine with item 10, whose payload descriptor is the
  first real consumer of a shared type.

**Difficulty: 3**, mostly inventory and packaging rather than new logic.

### Step 2 — host abstraction in the webview

**Status (August 2026): first standalone browser host implemented.** The
`web/` host supplies local file selection, drag-and-drop, collections,
downloads, persisted state, themes, bottom-bar display controls, the existing
right-click analysis tools, multi-frame DICOM navigation, and browser
equivalents for the main viewer commands. Selecting all members together also
supports embedded multi-file OME data. `npm run web:build` produces the
independently deployable `web-dist/` application while continuing to bundle the
same `media/` viewer sources used by VS Code. The remaining work is to replace
the compatibility `acquireVsCodeApi` shim with the narrower `Host` interface
below and add an explicit directory-permission flow for folder DICOM studies
and referenced external OME metadata.

**The number that matters: 153 `postMessage` call sites across 18 modules**,
reaching down into the format processors themselves. The webview is not
host-agnostic, and that is the entire cost of running this code anywhere other
than a VS Code webview.

- Introduce one `Host` interface (message transport, file/byte access,
  persisted state, configuration, "open document" style commands) and route
  every current call through it. Format processors should not know what a
  `vscode` API is.
- The VS Code implementation is the existing `acquireVsCodeApi` transport; a
  plain-browser implementation is a few dozen lines.
- **This is worth doing even if the desktop app never happens.** ply-visualizer
  demonstrates the payoff: its standalone `engine/` page is its fastest test
  surface, because Playwright runs against a browser page instead of booting
  VS Code/Electron. This repository's Playwright suite currently pays the
  Electron cost on every run.
- Secondary benefit: a standalone web build becomes a public demo, the same way
  the point-cloud engine is. Deploy it independently on the image viewer's
  subdomain and link it from the portfolio landing page; do not couple its
  deployment to the landing-page repository.

**Difficulty: 3.** Mechanical but broad; do it incrementally, one module group
at a time, with the VS Code host as the only implementation until the last
call site is converted.

### Step 3 — one downloadable Tauri desktop app (optional, and only after 1 and 2)

If a desktop app happens, it should be **one** app covering both images and 3D,
not two — the marketplace-discovery argument that keeps the extensions separate
does not exist off-marketplace, and "one scientific data viewer" is the
stronger desktop positioning.

**Framework: Tauri 2, not a Rust UI toolkit.** egui, iced, Slint and Dioxus
native are UI frameworks; adopting one means rewriting ~88,000 lines of
renderer and UI. Tauri keeps the webview frontend and makes the Rust side
native instead of WASM.

What that actually buys, in order of importance to this project's roadmap:

- **Memory.** wasm32 is capped at a 4 GB address space, and the VS Code webview
  adds its own heap limit on top. Native Rust has neither. This is the binding
  constraint for whole-slide TIFFs (item 3), volumes (item 10) and large
  collections — not a micro-optimization.
- **Real threads.** `rayon` instead of WASM threads with their COOP/COEP and
  SharedArrayBuffer requirements. Debayering, marching cubes, threshold sweeps
  and particle analysis (item 7) are all embarrassingly parallel.
- **File access.** `mmap`, lazy range reads, directory watching, OS-level file
  associations — which makes tile-driven pyramid loading substantially simpler
  than through the VS Code file API.
- **Native GPU** via `wgpu`, without the WebGPU subset.

Honest costs:

- Tauri uses the **OS webview** (WKWebView / WebView2 / WebKitGTK), whose
  WebGPU support is uneven and weakest on WebKitGTK. Having just gone
  WebGPU-first, expect to fall back to WebGL2 on some desktops — survivable
  because that fallback exists, but it is not the "native" win one imagines.
- Code signing and notarization (Apple ~$99/year, a Windows certificate),
  auto-update, crash reporting, three-OS testing. Permanent overhead that the
  extension model provides for free.
- **Strategic:** the reason people use this is *that it is in the editor* — no
  setup, no JVM, no Conda, works over SSH remotes and in vscode.dev. A desktop
  app competes head-on with Fiji, napari and Imaris and gives up the one
  argument that distinguishes it. This is a second product with a different
  market, not an improvement of the existing one.

A cheaper intermediate exists: an installable PWA of the standalone build from
step 2 costs almost nothing and gives a window and an icon — but none of the
memory or threading benefits, which are the only reasons to leave the browser.

**Difficulty: 4** as a shell once steps 1 and 2 are done; **5** and a rewrite if
attempted before them.

### Step 3e — TIFF strip decoding: single-threaded path landed, parallelism next

**Why the earlier `exp/strips` attempt was a dead end, concretely:** the float
TIFFs that matter here (`nl_01_depth.tif`, `nl_01_depth_x2.tif`) use
**predictor 3**, the floating-point predictor. Neither
`try_decode_general_strips_tiles` (planar or tiled-LZW only, <=16bpp) nor
`try_decode_uncompressed_strips` (predictor 1 only) accepted them, so they fell
through to the `tiff` crate's monolithic `read_image()` — which cannot be
parallelized from outside. Any strip-level worker pool built on top of that was
always going to be a dead end, no matter how the JavaScript side was arranged.

**Done:** `try_decode_float_predictor_strips` in
[strips.rs](crates/image-decoders/src/formats/tiff/strips.rs) decodes
predictor-3 float strips directly — decompress, accumulate the horizontal
differences over the row's raw bytes, de-planarize the byte planes, per strip,
independently. Measured (best-of-3 x 3 alternating runs, WASM, single-threaded):

| File | Before | After | Delta |
| --- | --- | --- | --- |
| `nl_01_depth.tif` 5120x5120 f32, Deflate+pred3 | 689 ms | 440 ms | **-36%** |
| `l_01_depth.tif` 3600x3000 f32, Deflate+pred3 | 330 ms | 230 ms | **-30%** |
| `nl_01_depth_x2.tif` 10240x10240 f32, Deflate+pred3 | 2743 ms | 1811 ms | **-34%** |
| `bl_..._zlib.tif` uint16 (not predictor 3) | 166 ms | 166 ms | unchanged |

Verified byte-identical against the previous decoder on all 52 TIFFs in
`test-samples/` plus `test_data/`, with a new multi-strip regression sample
(`test-samples/deflate_pred3_f32.tif`, 6 strips) checked against its
uncompressed twin in `test:wasm`.

**Strip-parallel API: done and measured; webview integration still to do.**
Two WASM entry points now expose the split:

- `tiff_float_strip_plan(data)` — parses only the IFD and reports the layout
  (dimensions, bits, compression, predictor, sample format, endianness,
  rows-per-strip, and every strip's offset/length), or nothing if the file is
  not a byte-aligned chunky strip shape.
- `decode_tiff_float_strip_range(blob, counts, first_strip, ...)` — decodes one
  contiguous run of strips from **only those strips' compressed bytes**. The
  caller slices the file per worker, so total bytes crossing the worker boundary
  is one file's worth, not one copy per worker.

**It is not predictor-3-only.** The plan and the per-strip decoder cover
predictors 1 (none), 2 (horizontal) and 3 (floating-point) across 8/16/32/64-bit
chunky strip layouts, uint/int/float. Predictor 2 is undone per sample in the
file's byte order; predictor 3 undoes byte-wise differencing then de-planarizes.
Measured with real 5120x5120 images and Node `worker_threads` (10-core machine,
best of 3, output verified identical to the whole-image decoder at every split):

| File | predictor | serial | 8 workers | speedup |
| --- | --- | --- | --- | --- |
| `nl_01_depth.tif` f32 Deflate | 3 | 464 ms | 65 ms | **7.1x** |
| `l_01_depth.tif` f32 Deflate | 3 | 241 ms | 30 ms | **8.0x** |
| `nl_01_depth_x2.tif` f32 Deflate 10240<sup>2</sup> | 3 | 2460 ms | 369 ms (6 workers) | **6.7x** |
| `pred1_f32_deflate.tif` | 1 | 370 ms | 68 ms | **5.5x** |
| `pred2_u16_deflate.tif` | 2 | 197 ms | 37 ms | **5.4x** |
| `pred1_u16_deflate.tif` | 1 | 172 ms | 40 ms | **4.3x** |
| `pred1_f32_none.tif` uncompressed | 1 | 133 ms | 21 ms (6 workers) | **6.5x** |
| `pred2_rgb8_deflate.tif` | 2 | 156 ms | 77 ms | 2.0x |

Scaling tracks how much work each strip carries. The 8-bit RGB case scales
worst (2x) because its strips are small and cheap, so fixed per-range cost
dominates; the uncompressed case is erratic because it is memory-bandwidth
bound, not CPU bound.

**Wired into the webview and shipping.** [strip-parallel-decode.ts](media/modules/strip-parallel-decode.ts)
owns the pool; [strip-decode-worker.ts](media/strip-decode-worker.ts) is its
member (its own bundle, since N of them each instantiate a WASM module).
[tiff-processor.ts](media/modules/tiff-processor.ts) tries it before the
ordinary decode-worker route and falls through untouched when it returns null.

Measured in a real VS Code session (median of 3 warm opens, cold first open
discarded):

| File | MB | decode before | decode after | total before | total after |
| --- | ---: | ---: | ---: | ---: | ---: |
| `nl_01_depth.tif` pred 3 | 29.3 | 660 ms | **168 ms** | 907 ms | **412 ms** |
| `nl_01_depth_x2.tif` pred 3 | 76.6 | 2905 ms | **774 ms** | 4369 ms | **1302 ms** |
| `pred1_f32_deflate.tif` pred 1 | 37.5 | 320 ms | **173 ms** | 718 ms | **575 ms** |
| `pred1_f32_none.tif` pred 1 | 100.0 | 297 ms | **105 ms** | 677 ms | **479 ms** |
| `pred1_u16_deflate.tif` pred 1 | 14.4 | 298 ms | **98 ms** | 648 ms | **455 ms** |
| `pred2_u16_deflate.tif` pred 2 | 10.0 | 341 ms | **119 ms** | 669 ms | **475 ms** |

Design decisions worth keeping:

- **Ranges are balanced by compressed bytes, not strip count.** Strips vary in
  cost and an even split leaves workers idle — 160 strips over 8 workers
  measured slower than over 6 before this.
- **Each worker receives only its own strips' bytes**, so total data crossing
  the worker boundary is one file's worth rather than one copy per worker.
- **The WASM module is compiled once on the main thread and instantiated N
  times.** Pool workers run from a blob URL and cannot fetch webview-resource
  URLs themselves.
- **Min/max is computed per range inside the workers** and combined on
  assembly, keeping the stats pass parallel and off the main thread.
- **Eligibility is decided in Rust.** `tiff_float_strip_plan` returns nothing
  for orientation flips, palette, CMYK or CFA, so the parallel path never has to
  re-implement a pixel transform that is only correct on the whole image.
- Gates: >= 4 MB file (reading the plan needs a main-thread WASM instance, not
  worth instantiating below that), >= 16 strips, >= 2M pixels, pool capped at 8
  and at `hardwareConcurrency - 1`.

**Cold opens.** The pool's cost is almost entirely startup — fetching the worker
bundle, compiling the WASM once, instantiating it N times — so `prewarmStripPool()`
and `getWasmModule()` are kicked off from `imagePreview.ts` as soon as a TIFF is
recognised, overlapping with the file read rather than being paid serially
before the first decode. Cold `nl_01_depth.tif`: 1480 ms -> 1318 ms total, with
decode 917 ms -> 310 ms. The gap between cold and warm (556 ms) is startup that
prewarming overlaps but cannot remove.

**Coverage note.** The first implementation rejected `bits_per_sample == 16`,
which silently excluded half-float TIFFs — a real and common shape (a 1.96 MB
3600x3000 fp16 file in `depth_scene/`). Predictor 3's byte-plane form is
width-agnostic, so 16-bit works identically; the crate now converts binary16 to
binary32 directly rather than pulling in `half`. That file went from
`decode 208ms [wasm (worker)] / total 413ms` to `decode 90ms / total 232ms`.

**The pool must be retired after a large decode.** WebAssembly linear memory
grows but never shrinks, so eight workers whose heaps each expanded to hold a
slice of a 419MB raster retain that memory for the session, and the main
thread's following WebGL upload contends with it. Measured at 10240x10240,
keeping the pool alive more than doubled `webgl-texture-upload` (201ms ->
491ms), eating a large part of the decode win. `pool.retire()` now runs before
the result is returned, above the same 64MB threshold the decode worker uses for
`retireWorker`, keeping the compiled module so respawning only repays
instantiation.

**Where the time actually goes now** (medians of 4 warm opens, cold discarded):

| Phase | `nl_01_depth.tif` 29MB | `nl_01_depth_x2.tif` 77MB |
| --- | ---: | ---: |
| fetch | 170 ms | 258 ms |
| decode (workers) | 130 ms | 552 ms |
| decode (assemble) | 12 ms | 188 ms |
| WebGL upload | 35 ms | 247 ms |
| **total** | **431 ms** (was 800) | **1342 ms** (was 3038) |

1.9x and 2.3x end to end. The total improves less than decode alone because
decode was 82-86% of the time before and is now 35-54%: what remains is the
webview fetch ceiling (~330-500 MB/s regardless of API, see the fetch experiment)
and the WebGL upload of a 104-419MB float texture, neither of which
parallelizing the decoder touches.

**Carrier types matter more than the decode.** The pool originally returned
`Float32Array` for every image, which is what the f32 conversion in Rust
produced. For integer TIFFs that was wrong twice over: `canUseStoredInterleaved`
in [tiff-processor.ts](media/modules/tiff-processor.ts) rejects a mismatched
carrier and rebuilds the interleaved buffer, and the WebGL renderer accepts
integer data only in a `Uint16Array`. `decode_tiff_strip_range_raw` now returns
native little-endian sample bytes and the worker wraps them in the carrier the
pipeline expects (`Uint8Array` / `Uint16Array` / `Float32Array`) with no
conversion pass at all — which also makes the float path zero-copy.

Measured on `pred2_rgb8_deflate.tif` (5120x5120 RGB8, 78.6M samples):

| Phase | Before | After |
| --- | ---: | ---: |
| decode | 886 ms | 307 ms |
| interleave | 213 ms | skipped |
| finite-scan | 112 ms | 54 ms |
| **total** | **1415 ms** | **644 ms** |

Worth remembering when reading these numbers: decode cost tracks SAMPLE COUNT,
not file size. That RGB8 file is 1.2 MB but holds 78.6M samples (314 MB
decoded), while `pred1_u16_deflate.tif` is 14.4 MB and holds 26.2M — twelve
times the file size, a third of the work.

**Integer images were rendering on the CPU because of one missing property.**
`isFloat` was passed to `canRender()` but not to `render()`, and
`_getTextureFormat` treats a missing value as float (`isFloat !== false`) — so
integer data was given an `r32f` texture, the upload failed, and the renderer
silently fell back to the CPU path. Forwarding it, and adding native 8-bit
integer textures (`r8ui`/`rgb8ui`/`rgba8ui`, since `canRender` previously
required a `Uint16Array`), moved them onto the GPU:

| File | `render` before | after |
| --- | ---: | ---: |
| `pred1_u16_deflate.tif` | 187 ms | **23-31 ms** |
| `pred2_u16_deflate.tif` | 240 ms | **34 ms** |
| `pred2_rgb8_deflate.tif` | 159 ms | 123 ms |

Traces confirm `webgl-texImage2D-r16ui` / `-rgb8ui` with `canvas-upload-skipped`.
RGB8 gains least because it is now genuinely upload-bound (78.6 MB texture)
rather than CPU-render-bound. Only tiff-processor had the bug: png and ppm
already forwarded `isFloat`, and exr/npy/pfm are float-only so the missing value
happened to select the right branch.

**Assembly now overlaps decode.** The pool awaited `Promise.all` and then copied
every range in one serial pass; it now copies each range as it arrives, so the
copies hide behind the ranges still decoding. Verified identical at every split.
NOT cleanly measured: the machine was under load average 17 during the
comparison, with totals swinging 1210-2274 ms on identical builds, so no
improvement is claimed — only that the change cannot be slower and removes
`strip-assemble` from the critical path by construction.

**The non-finite pre-scan was dead work for integer images.** `renderTiffWithSettings`
walks every sample of every plane checking `Number.isFinite` before choosing the
render path. That is necessary when integer VALUES sit in a `Float32Array`
carrier (geotiff.js output, and signed/wide integers per `tiffNeedsFloatCarrier`),
because such a carrier can hold Infinity. Once the strip pool started returning
genuine `Uint8Array`/`Uint16Array` carriers, the scan became provably incapable
of finding anything for those images — and it showed up in the `[Perf]` line as a
`stats` phase appearing only on integer files (20ms on uint16, 54ms on 8-bit
RGB). Now skipped when every plane is an integer typed array; the float-carrier
case still scans.

**`texSubImage2D` overlap is blocked on the load pipeline, not the renderer.**
Uploading ranges to the GPU as they decode needs the target canvas at decode
time, but `_ensureContext(canvas)` binds to the display canvas that only exists
once rendering starts, and the assembled buffer is required regardless (pixel
inspection, stats, histogram and layers all read `rawTiffData.data`, and without
`SharedArrayBuffer` the workers cannot write into one shared buffer). So this
would not remove the assembly, only overlap the GPU upload — a ceiling of the
`webgl-texture-upload` phase, roughly 46 ms at 5120x5120 and 247 ms at
10240x10240, in exchange for restructuring decode/settings/stats/render into an
interleaved pipeline. Not worth it at that ratio. -- it transferred one buffer directly, while the
pool copies N slices into one array. Uploading per strip range with
`texSubImage2D` instead of assembling first would remove it and overlap upload
with decode. Also: a 10240x10240 f32 image is 419 MB assembled with
each worker holding its slice on top, so a memory budget that shrinks the pool
for very large images is still missing; and there is no committed regression
sample for predictor 3 with 16-bit floats (it is verified only against
`test_data`, which is outside the repo).

**Note on the whole-image path.** `try_decode_float_predictor_strips` still
returns early for predictors 1 and 2: its reassembly reads big-endian floats,
which is correct only for the byte-plane form. Predictor 1 and 2 files keep
their existing whole-image routes. Widening *that* path is a separate, smaller
win than the parallel one.

### Step 3a — how ply-visualizer gets included

Step 3 says "one app covering both images and 3D" without saying how the two
codebases meet. They should **not** be merged into one repository up front.
ply-visualizer is a shipping extension with its own pnpm workspace, webpack
config, Playwright suite and release cadence; folding that into a restructure
happening simultaneously here means two moving targets and no clean bisect when
something breaks.

Ranked options:

1. **Path dependency (do this first).** The desktop app declares
   `"pointcloud-engine": "link:../ply-visualizer/engine"` — pnpm supports this
   natively — and Cargo uses
   `pointcloud-parser = { path = "../ply-visualizer/wasm/pointcloud-parser" }`.
   Both repositories stay independent. `ply-visualizer/engine` is already a
   proper package with its own `package.json` and `main: src/main.ts`, so it is
   consumable as-is today, with no changes on the ply side. The cost is that a
   clone needs both repositories side by side — fine locally, a wrinkle in CI.
2. **`git subtree add` once the desktop app is real.** Brings ply in with full
   history, no submodule friction. Deliberately deferred until step 3 has
   proven itself.
3. **Avoid git submodules.** The detached-HEAD and forgotten-`--recursive` tax
   is not worth it for two repositories the same person owns and edits together.

**The ply side already solved the host problem.** `engine/src/main.ts:32` does
`const isVSCode = typeof acquireVsCodeApi !== 'undefined'` and branches; the
standalone `engine/index.html` host is what website-ply deploys. That is step 2
of this item, already shipping over there. Read that implementation before
designing this repository's `Host` interface rather than inventing a second one.

**Delete ply's decoder fork as part of this.**
`ply-visualizer/wasm/tiff-decoder` is a single-`lib.rs` fork wrapping the `tiff`
crate, entirely superseded by `crates/image-decoders`. Retiring it is the
concrete first deliverable of step 1's remaining migration work, and it is
worth doing whether or not the desktop app happens.

### Step 3b — execution order for the restructure

The point of this ordering is that the extension keeps building and passing
tests at every checkpoint.

1. **Verify the boundary before moving anything.** `media/` must import nothing
   from `src/`. The only coupling should be `acquireVsCodeApi` and the message
   protocol. Fix any leak found here first — everything below assumes it.
2. **Move `media/` sources to `packages/image-engine/`.** Mechanical, but three
   things will bite: the entry points and `mediaModuleTsFiles` list in
   `esbuild.js`; the webview resource URIs in `imagePreview.ts` and
   `imagePreviewManager.ts`; and the `build:wasm` script in `package.json`,
   which hardcodes `media/wasm/`. Consider keeping the *build output* landing in
   `media/` at the repository root so only sources move.
3. **Checkpoint.** `npm run compile`, `npm run test`, and F5 into the Extension
   Development Host. This is the commit worth being able to return to.
4. **Extract the state layer** (see step 3c — it is a shared prerequisite).
5. **Extract `host-adapter`** — one interface (`openFile`, `saveFile`,
   `prompt`, `pickList`, `notify`, `store`) that the *existing* extension
   implements, replacing direct `vscode.*` calls in `commands.ts` a group at a
   time. This is step 2 of this item done incrementally, with the extension's
   own test suite validating each move. When it is finished, the result is both
   a working extension and a written spec of what Tauri must provide.
6. **Scaffold `apps/desktop`** (Tauri 2 + Vite) against `packages/image-engine`
   with an `acquireVsCodeApi` shim over `host-adapter`. Target for this step is
   narrow: open a TIFF and render it. Nothing else.
7. **Add ply** via the path dependency from step 3a, routing by file extension
   with `import()` so Three.js is not downloaded or parsed when opening a TIFF.

**The shim is the cheap on-ramp, not a replacement for step 2.** A desktop
`acquireVsCodeApi()` that routes `postMessage` to a same-window TypeScript host
lets the entire webview run unmodified before a single one of the 153 call
sites is converted. Use it to get to a rendering window fast; still do the
proper `Host` interface afterwards, because the shim leaves the format
processors knowing about a VS Code-shaped protocol.

**Package-manager decision: npm for both extension repositories.** The future
Tauri repository can make its own choice when it is created; consuming two built
engines does not require a cross-repository workspace. Vite remains the natural Tauri
bundler because it handles Svelte, WASM and web workers cleanly, but leave
esbuild in this extension and webpack in ply—there is no reason to touch two
working extension builds to get a third target.

Keep this extension's `package.json` at the repository root for now. That is the
least surprising layout for npm and `vsce`; moving it to `packages/vscode-tiff/`
would add release churn without helping the first browser-host extraction.

### Step 3c — adopt Svelte for the panel UI

**Verdict: yes, scoped to the panels and to the new desktop chrome, and only
after the workspace split.** ply-visualizer already ran this exact migration —
`ply-visualizer/docs/SVELTE_MIGRATION_PLAN.md` has phases 0–6 all marked DONE,
30 components, and a `mount()`-into-existing-DOM island pattern
(`errorOverlayMount.ts` and friends). Follow that plan; do not write a new one.

What is in scope here, by measurement:

| Module | LOC | Svelte helps? |
| --- | --- | --- |
| `measure-panel.ts` | 2,618 (89 `createElement`) | yes |
| `layers-panel.ts` | 1,494 (108 `createElement`) | yes |
| `histogram-overlay.ts` | 1,426 | partly — canvas drawing stays |
| channels / debayer / metadata / range panels | ~1,050 | yes |
| `imagePreview.ts` | 6,855 (47 `createElement`) | partly — orchestration only |
| decoders, compositors, renderers, workers, processors | ~27,000 | **no** |

`media/` currently has 353 `createElement`/`innerHTML` calls and 165
`addEventListener` calls. Roughly 6–7k lines of imperative DOM are in scope,
concentrated in the two panels where the manual-DOM tax is worst. The other
~27k is untouched, exactly as ply's plan documents in its "What Svelte does NOT
touch" section.

**The argument that actually decides it is the desktop port, not the panels.**
Going to Tauri means rebuilding UI that VS Code currently provides for free: 17
`showInputBox`/`QuickPick` calls, 46 `showError`/`Information`/`WarningMessage`
toasts, 10 status bar entry classes, file dialogs, progress indicators. ply
already has `Modal.svelte`, `FileList.svelte`, `ErrorOverlay.svelte`,
`LoadingOverlay.svelte`, `PerformanceStats.svelte` and `FileItem.svelte`. If
both engines share one framework, that chrome is written once; if this side
stays vanilla, it gets hand-rolled in imperative DOM while an equivalent sits in
the sibling repository. So the real question is not "should the extension use
Svelte" but "should the merged desktop app have one UI layer or two" — and the
answer is one.

Sequencing, and **do not run this concurrently with the restructure** — bisect
is worth more than parallelism:

- The useful overlap is ply's **phase 1, the state layer**, which its plan calls
  "the real prerequisite". Pulling settings and UI state out of the panels into
  stores is substantially the same work as decoupling them from
  `vscode.postMessage` for `host-adapter`. Do it once; it serves both. This is
  why it appears as step 4 in 3b above.
- Then Svelte phase 0 tooling, then leaf islands — toasts, overlays, modals.
  These are *new* UI needed for the desktop app anyway, so build them in Svelte
  from the start rather than migrating anything.
- Migrate `layers-panel` and `measure-panel` **last**: largest, riskiest, and
  deferrable indefinitely without blocking the desktop app. The panels keep
  working as vanilla DOM alongside Svelte islands, which is what ply's phase 2
  demonstrated.
- Do **not** rewrite `imagePreview.ts`. It stays the imperative shell that
  mounts islands, the same role ply's `main.ts` plays today.

Honest cost: esbuild does not do Svelte, so `packages/image-engine` moves to
Vite — which is wanted for Tauri regardless. That changes the extension's
webview build too, which is the one genuine risk, and the reason the workspace
split in 3b comes first.

**Difficulty: 3** for the state layer and leaf islands, **4** including the two
large panels.

### Step 3d — compositing backend on desktop: benchmark before porting

Step 3 lists "native GPU via `wgpu`" as a benefit. There is a cheaper and more
portable option worth measuring first, specifically for the **2D layer
compositor** — not for ply's 3D renderer, where the GPU is the whole point.

`wasm/tiff-decoder/src/compositor/` is already 1,746 lines of Rust. Compiled
natively rather than to WASM it gets real SIMD, `rayon` across all cores, and —
the significant one — no texture upload/readback on every layer edit. For a
moderate number of layers at moderate resolution that plausibly beats the
WebGPU path end-to-end, because that path is transfer-bound rather than
math-bound. At 20 layers on 8K it plausibly does not. **This is a benchmark, not
a decision already taken**; the existing compositor interface is the seam to put
a third backend behind.

**Caveat found later: simd128 is not output-neutral for JPEG.** The claim that
decoded output is byte-for-byte identical holds for TIFF (verified across all 49
`test-samples` files) and EXR, but NOT for lossy JPEG. Enabling simd128 shifts
`decode_jpeg_fast` output by +/-1 on a minority of samples — measured at 3687 of
262144 on a 512x512 JPEG-baseline DICOM, maximum absolute difference 1.

Neither build is wrong: ISO/IEC 10918-1 does not specify a bit-exact inverse
DCT, only an accuracy tolerance, so conformant decoders routinely differ by
+/-1. zune-jpeg's own SIMD is AVX2-gated and inactive on wasm32; what changes is
LLVM autovectorizing its scalar IDCT once simd128 is available.

Scope, measured rather than assumed:

| Input | Affected? |
| --- | --- |
| DICOM `1.2.840.10008.1.2.4.50` (JPEG baseline, lossy) | **yes**, 1.4% of samples by +/-1 |
| DICOM `1.2.840.10008.1.2.1` (uncompressed) | no, bit-exact |
| JPEG-in-TIFF (`jpeg_ycbcr*.tif`, compression 7) | no, bit-exact |
| WebP-in-TIFF, CCITT, palette, all other TIFF | no, bit-exact |

**Resolved:** the golden was re-captured, accepting IDCT variance as the cost of
simd128's 4-32% decode win. `node scripts/capture-goldens.js` rewrote exactly one
of 140 goldens — `dicom-fixture-external-0002-dcm`, one `dataDigest` line, with
dimensions and per-sample structure unchanged — which is itself confirmation
that the effect is confined to lossy JPEG. The reasoning lives on
`decode_jpeg_fast` in [lib.rs](crates/image-decoders/src/lib.rs) so it is found
from the code rather than only here.

**This does not transfer to the extension.** In the webview the same Rust
compiles to WASM, and `wasm/tiff-decoder/Cargo.toml` has neither `rayon` nor
`simd128` enabled — it is single-threaded scalar, and WASM threads would need
`SharedArrayBuffer` plus COOP/COEP headers that a VS Code webview does not
reliably provide. **Keep WebGPU in the extension.** The native/WASM split is an
argument *for* the shared core: one Rust source, two compile targets, backend
chosen per host at runtime.

**Done, and unrelated to the desktop app: `simd128` is now enabled** in
`build:wasm` and `scripts/build-wasm.sh` via
`RUSTFLAGS="-C target-feature=+simd128"`. A build-flag change with no code
change. Measured on 3072x3072 single-strip TIFFs, best-of-7 x 4 alternating
runs, decode plus `get_data_as_f32`:

| Sample | Before | After | Delta |
| --- | --- | --- | --- |
| u8 RGB, uncompressed | 41.0 ms | 14.9 ms | **-64%** |
| u16 gray, uncompressed | 29.5 ms | 21.3 ms | **-28%** |
| u8 RGB, Deflate + predictor 2 | 230.5 ms | 191.3 ms | **-17%** |
| u16 gray, Deflate + predictor 2 | 122.3 ms | 109.1 ms | **-11%** |
| f32 gray, Deflate | 220.3 ms | 208.2 ms | -5% |
| f32 gray, uncompressed | 62.8 ms | 62.9 ms | none |

The pattern is what autovectorization predicts: widening and interleaving loops
vectorize well, inflate does not, and the f32 uncompressed path is already a
straight memory copy with nothing to vectorize. Decoded output is byte-for-byte
identical (checksums matched on every sample; `test:wasm`, `test:formats` and
`test:behavior` all pass). The module grows 2.97 MB to 3.00 MB, +1.3%.

Not yet explored, and the obvious follow-up: the same reasoning applies to the
compositor and measurement kernels, and explicit `std::simd` in the hot loops
would go beyond what LLVM autovectorizes on its own.

For ply's Three.js `WebGPURenderer` (`engine/src/rendering/rendererBackend.ts`),
the realistic desktop options are, worst to best: rely on the OS webview's
WebGPU and ship a WebGL2-fallback Linux build; render natively offscreen and
read back (do not — the per-frame readback negates it); or put a native `wgpu`
surface in the Tauri window with a transparent webview stacked over it for UI.
Only the third beats the browser, and it means replacing Three.js as ply's
renderer — a rewrite of much of that engine, plus z-order, transparency, DPI and
input-forwarding quirks on three window systems. Ship on the existing
WebGPU-with-WebGL2-fallback path first; `rendererBackend.ts` is already an
abstraction boundary, so a native backend can go behind it later if profiling on
real datasets justifies it.

---

## 12. Rust-first migration of the data and pixel layers

> The goal is **not** "mainly Rust" measured in lines — that target is
> unreachable and pursuing it produces worse code. The goal is a single rule:
> **anything that parses bytes or touches pixels lives in Rust; anything that
> touches the DOM, a GPU API, or the VS Code API stays in TypeScript.**
> Consistent with item 11, this plan rewrites no renderer and no panel.

**Measurements (August 2026):** ~7,300 lines of TypeScript in `src/`
(extension host), ~44,000 in `media/` (webview), against 5,800 lines of Rust in
[`wasm/tiff-decoder`](wasm/tiff-decoder/src/lib.rs). Rust already owns TIFF,
EXR, HDR, PNG16, JPEG and demosaic, all reached through
[`media/decode-worker.ts`](media/decode-worker.ts).

The migratable surface is roughly **12,000 of the 44,000 webview lines** — about
27% by volume, but close to 100% of the code where correctness bugs and
frame-time actually live. Expect the crate to grow to roughly 15–18k lines.

### Phase 0 — split the crate first (prerequisite) — implemented

`lib.rs` was 5,121 lines. It is now 572 lines holding only the
`#[wasm_bindgen]` surface and the result structs, with the logic moved verbatim
into `formats/{exr,hdr,png}.rs`, `formats/tiff/{mod,tags,strips,codecs,
orientation,cmyk}.rs`, `pipeline/stats.rs`, and
`compositor/{mod,adjustments,blend}.rs` (`demosaic.rs` unchanged). No
`formats/jpeg.rs` exists: the whole JPEG path is `#[wasm_bindgen]` surface, so
it stayed in `lib.rs`. The generated `pkg/tiff_wasm.d.ts` is byte-identical to
the pre-split build, so the exported API did not move.

Still to settle as the ports land — these conventions get replicated ~30 times:

- Zero-copy out via `take_data_as_f32()`/`take_data_as_u8()` — the existing
  pattern; never return `Vec` by clone.
- Errors as `Result<_, JsValue>` with a structured reason string, so the
  fallback-reason plumbing (`wasmFallbackReason`) keeps working unchanged.
- Metadata as one JSON string per result (as `all_tags_json` already does)
  rather than dozens of getters.
- One `wasm-pack` build feeding both the decode worker and the compositor
  worker; do not create a second crate.

**Difficulty: 2.** Pure refactor, no behavior change. Done.

### Phase 1 — remaining decoders (~3,500 lines)

Highest value, lowest risk: pure byte-in/array-out, no DOM, and each port
collapses a WASM-plus-JS-fallback pair into one code path.

- [`scientific-format-parsers.ts`](media/modules/scientific-format-parsers.ts)
  (1,050) — FITS, DICOM, NetCDF. DICOM is the strongest candidate of the three:
  transfer syntaxes and pixel representation are exactly where hand-written JS
  accumulates edge cases, and `dicom-rs` exists.
- [x] [`pfm-processor.ts`](media/modules/pfm-processor.ts) `_parsePfm` →
      [`formats/pfm.rs`](wasm/tiff-decoder/src/formats/pfm.rs),
      [`ppm-processor.ts`](media/modules/ppm-processor.ts) `_parsePpm` →
      [`formats/netpbm.rs`](wasm/tiff-decoder/src/formats/netpbm.rs), and
      [`npy-processor.ts`](media/modules/npy-processor.ts)
      `_parseNpy`/`_parseNpz` → [`formats/npy.rs`](wasm/tiff-decoder/src/formats/npy.rs).
      These validated the boundary conventions. **Note the line counts above were
      misleading:** only ~65 / ~215 / ~130 lines of each file are byte-parsing;
      the rest is render orchestration that correctly stays TypeScript.
      The worker prefers WASM and falls back to the TS parser
      (`decodePfm`/`decodePpm`/`decodeNpy`, mirroring `decodePng16`), so the
      fallback pair is not collapsed yet — see below.
- [x] FITS and classic NetCDF from
      [`scientific-format-parsers.ts`](media/modules/scientific-format-parsers.ts)
      → [`formats/fits.rs`](wasm/tiff-decoder/src/formats/fits.rs) and
      [`formats/netcdf.rs`](wasm/tiff-decoder/src/formats/netcdf.rs), sharing
      `scientific_common.rs` and `json_value.rs`. `test:rust-scientific` covers
      47 cases: 14 real corpus fixtures, the whole BITPIX matrix, BSCALE/BZERO,
      BLANK, NaN/±Inf, multi-block headers, 3-axis cubes, CDF-1/CDF-2, record
      dimensions, scale/offset, `_FillValue`, every NetCDF element type, and
      matching rejection text.
- [x] Zeiss CZI → [`formats/czi.rs`](wasm/tiff-decoder/src/formats/czi.rs). The last
      TypeScript byte-parser; `media/modules/scientific-format-parsers.ts` no longer
      exists. Fixed a latent table bug on the way: `CZI_PIXEL_TYPES[13]` (Gray64)
      reported 32 bits per sample, copied from the float32 entries above it.
- [x] **Deleted the TypeScript parsers for every ported format.** A fallback is
      only worth its cost when the two paths cover *different* things — true for
      WebGPU (hardware varies), and true for geotiff.js at the time this was
      written. It no longer is on codec coverage: geotiff.js has since been
      measured as a strict SUBSET of the Rust decoder (see "Remove the
      geotiff.js fallback" below), so the only difference left is tolerance of
      malformed files. It was NOT true for the ported formats: the Rust
      is conformance-proven identical, so the TS parser only guarded "the wasm
      failed to load", a scenario already fatal for TIFF, while costing two
      parsers to keep in sync and masking Rust bugs behind a `console.warn`.
      The suites moved to golden + hand-computed assertions first, so deleting
      the oracle cost no coverage; every golden's `dataDigest` is unchanged
      across the whole migration.
- [ ] **`ome-tiff.ts` stays TypeScript — deliberately, not pending.** The
      byte-level half is already Rust (`extract_ome_xml` pulls the document out
      of TIFF tag 270). What remains maps XML *text* onto a typed model
      (`OmeMetadata`, channels, objectives, `TiffData`) consumed by
      dataset-navigation UI in four files across both bundles. Rust's advantage
      here is nil — the bugs it prevents (buffer overruns, byte order, integer
      overflow) do not occur in text parsing, while the bugs that do occur
      (namespace handling, `DimensionOrder` mapping) are unaffected. Porting it
      would send the model over the boundary as JSON for TypeScript to re-parse
      into the same interfaces, costing type safety and adding an XML dependency
      to the crate for something that is not a decoder.
      The one cost of keeping it here would be a split shared surface: a crate
      consumer gets pixels plus the raw OME-XML string and would have to
      interpret it itself. That cost does not apply to the extraction actually
      planned — the consuming library has no use for OME metadata, only for the
      pixel decoders. So this is settled, not deferred.
      **Revisit only if** a future consumer genuinely needs the OME model; then
      expose `parse_ome_xml(xml) -> json` from the crate rather than moving the
      typed model across the boundary.
- Retires the standing **"remove the geotiff.js fallback"** item below, plus the
  `parse-exr`, `upng` and `pako` fallbacks, once each Rust path is conformance-
  tested against the golden corpus. They are no longer general fallbacks for
  anything ported. For geotiff.js specifically the conformance half is now
  done — what remains is the instrumentation step in that item, not more
  porting.

**Difficulty: 3.** Mostly volume; DICOM alone is a 3.

**Porting rule: reproduce quirks, fix defects in both sides at once.** A port
matches the TS exactly so conformance is provable — but where the TS was
genuinely wrong, fix TypeScript and Rust together in the same change, never
just one. Two were found and fixed this way during the NPY port: `>f8`
(big-endian float64) was read little-endian because the TS decoded it through a
native-endian `Float64Array` view that ignores the dtype prefix; and NPZ entries
using a data descriptor (general-purpose flag bit 3, `compSize` left as 0 or
`0xFFFFFFFF`) relied on `ArrayBuffer.slice` clamping, which found only the first
array in a multi-entry archive.

**Conformance suites need absolute assertions, not just agreement.** The `>f8`
bug survived the first conformance pass because the suite only asserted
TS == Rust, and both were wrong. Every port's suite must also assert decoded
values against known-correct expectations.

### Phase 2 — the pixel pipeline (~3,000 lines)

[`normalization-helper.ts`](media/modules/normalization-helper.ts) (1,512) is
the hottest file in the project: per-pixel normalization, gamma in/out,
brightness, NaN/Infinity handling and LUT generation. It is exactly what the
`wide` SIMD dependency is already in `Cargo.toml` for.

- Also: histogram binning inside
  [`histogram-overlay.ts`](media/modules/histogram-overlay.ts) (the *drawing*
  stays TS), [`colormaps.ts`](media/modules/colormaps.ts) LUT generation and the
  32³ inverse cube, [`colormap-converter.ts`](media/modules/colormap-converter.ts),
  [`channel-composite.ts`](media/modules/channel-composite.ts), and the CPU
  fallback in [`layer-compositor.ts`](media/modules/layer-compositor.ts).
- **Caveat worth stating plainly:** on WebGPU/WebGL2 paths this math already
  runs in shaders, so Phase 2 speeds up the *CPU fallback and the export
  reference path*, not the common interactive case. Its real payoff is having
  one authoritative implementation of the pipeline semantics that shaders are
  validated against — today CPU, WASM and two shader backends each restate it.
- Non-finite handling must stay bit-identical across backends (see the
  `!Number.isFinite()` rule in CLAUDE.md); this is the conformance test that
  gates the phase.

**Difficulty: 3.**

### Phase 3 — measurement algorithms (~3,800 lines)

The `measure/` core is the best pure-compute fit in the repository:
[`threshold.ts`](media/modules/measure/threshold.ts) (1,067),
[`particles.ts`](media/modules/measure/particles.ts) (607),
[`segmentation.ts`](media/modules/measure/segmentation.ts) (542),
[`geometry.ts`](media/modules/measure/geometry.ts) (624),
[`statistics.ts`](media/modules/measure/statistics.ts) (493),
[`imagej-roi.ts`](media/modules/measure/imagej-roi.ts) (516),
[`roi-io.ts`](media/modules/measure/roi-io.ts) (594).

Connected-component labeling and particle analysis over large images are where
JS hurts most, and interactive threshold sweeps (item 7) are the feature most
limited by it. ROI *drawing and hit-testing*
([`roi-overlay.ts`](media/modules/measure/roi-overlay.ts), 1,633) stays TS — it
is canvas and pointer code.

**Difficulty: 3–4.** Highest test burden, since ImageJ-comparable numeric output
is the acceptance criterion.

### Phase 4 — export writers (~1,500 lines)

[`xcf-writer.ts`](media/modules/xcf-writer.ts) and
[`layer-document-writers.ts`](media/modules/layer-document-writers.ts)
(ORA/KRA/PSD): binary struct packing plus zip/zlib, where Rust has mature
crates and JS has hand-rolled byte writers. Lowest urgency — export runs once
per user action, so this is a correctness and maintenance win, not a
performance one.

**Difficulty: 2–3.**

### What deliberately stays TypeScript (~18,000 lines)

- **All of [`src/`](src/) (7,300).** The VS Code extension API is JS-only.
  Commands, status bar entries, the custom-editor provider and message routing
  have no Rust path that is not net-negative.
- **The GPU compositors (~4,200):**
  [`webgl2-layer-compositor.ts`](media/modules/webgl2-layer-compositor.ts),
  [`webgpu-layer-compositor.ts`](media/modules/webgpu-layer-compositor.ts),
  [`webgl2-float-renderer.ts`](media/modules/webgl2-float-renderer.ts),
  [`webgpu-channel-compositor.ts`](media/modules/webgpu-channel-compositor.ts).
  Driving WebGPU from WASM means wasm-bindgen glue per call while the actual
  compute already lives in shaders. (Note the interaction with item 11 step 3:
  under Tauri these would become native `wgpu`, which is a *different* rewrite
  and not a reason to do this one now.)
- **All DOM and UI (~7,000):** [`measure-panel.ts`](media/modules/measure-panel.ts)
  (2,453), [`layers-panel.ts`](media/modules/layers-panel.ts) (1,494),
  [`channels-panel.ts`](media/modules/channels-panel.ts),
  [`debayer-panel.ts`](media/modules/debayer-panel.ts), histogram and ROI
  drawing, [`zoom-controller.ts`](media/modules/zoom-controller.ts),
  [`mouse-handler.ts`](media/modules/mouse-handler.ts).
- **Orchestration:** [`imagePreview.ts`](media/imagePreview.ts) (6,871), worker
  plumbing, `postMessage`, canvas/`ImageData` handoff.

### Honest costs

- Every port needs its boundary designed to avoid copies; a naive port can be
  *slower* than the JS it replaces once marshalling is counted.
- `wasm-pack` becomes a hard CI dependency rather than an optimization, and
  `wasm-opt` is currently disabled in `Cargo.toml` to avoid exactly that kind of
  build-time download.
- Debugging regresses: stack traces, `console.log` and breakpoints are all worse
  across the boundary.
- wasm32's 4 GB address-space cap applies to everything moved into Rust — the
  same constraint item 11 step 3 identifies.
- Bundle size grows on every phase; the extension ships the `.wasm` in the VSIX.

### Amendment to CLAUDE.md

The current instruction — *"whenever you see the option to transition code to
rust do it"* — is too broad and would justify porting click handlers. Replace it
with the byte/pixel-versus-DOM/GPU/API rule at the top of this item.

### Suggested order

Phase 0 → 1 → 2 → 3 → 4. Phases 1 and 3 carry most of the value; phase 2 is
worth doing mainly for the single-source-of-truth argument; phase 4 can slip
indefinitely. Phase 1 also feeds item 11 step 1 directly — shared decoders are
far easier to extract once they are one Rust crate rather than a Rust path plus
a JS fallback.

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
- **Remove the geotiff.js fallback.** The codec argument is settled — what is
  left is a question about malformed files in the wild, and a way to answer it.

  **What was measured** (re-runnable; see "Decoder coverage sweep" below).
  geotiff.js registers exactly seven decoders: raw, LZW, JPEG, Deflate,
  PackBits, LERC and WebP, and throws on old-style JPEG (6). The Rust decoder
  covers all seven plus CCITT G3/G4, ZSTD, LZMA, PNG-in-TIFF, JPEG XR and
  JPEG 2000 — a strict superset. Across 91 corpus TIFFs and a 77-file generated
  matrix, geotiff.js decoded **nothing** the Rust path could not; the Rust path
  decoded 19 files geotiff.js could not. So the older claim in this file that
  geotiff.js "covers TIFF cases Rust does not yet" no longer holds for any
  codec, layout or sample type that was tested.

  **What is therefore NOT the blocker:** codec coverage, bit depths, planar or
  tiled layouts, predictors, BigTIFF, multipage, photometric interpretations.

  **What IS the blocker:** files that violate the spec. geotiff.js is laxer than
  the `tiff` crate about malformed IFDs, wrong tag counts and truncated strips,
  and the corpus is synthetic — every file in it was written by a conformant
  encoder, so it cannot exercise that difference at all. Whether real users hit
  it is unknown, and unknowable from here.

  **The condition to remove it, in order:**
  1. **Instrument first.** `TiffProcessor` reaches the fallback via a
     `console.warn` nobody reads. Record it where it is visible instead — the
     loading log already shows the decode engine, so a line naming the Rust
     rejection reason belongs there, and in the extension a one-time notice is
     reasonable too. This is the whole cost of finding out.
  2. **Ship it for a release or two** and collect what the rejection reasons
     actually are. Note that `[external-codec:…]` no longer reaches this path
     at all (it routes to the codec module), so anything logged is a genuine
     Rust refusal.
  3. **Remove when either holds:** no report of the fallback firing on a real
     file, OR every reason that did fire has been fixed in Rust. A reason that
     turns out to be a permissiveness difference is a decision, not
     automatically a fix: "the tiff crate rejects this and geotiff.js guesses"
     may well be the better behaviour, in which case the file should get a
     clear error rather than a silent second decoder.
  4. **When removing**, delete in one change: `loadGeoTiff` and the `geotiff`
     entry in `lazy-vendor-loader.ts`, the fallback block in `tiff-processor.ts`,
     `buildTagsFromGeotiffImage` in `tiff-tag-utils.ts`, the `geotiff` dependency
     and its `media/geotiff.min.js` copy step in `esbuild.js`, and the
     `geotiff` vendor-asset URL in `imagePreview.ts` and `web/vendor-assets.js`.

  **Already dead, removable now regardless:** `decodeTiffGeotiff` in
  `media/decode-worker.ts`. Its `WorkerGeoTIFF` global is declared but never
  assigned, nothing calls the function, and esbuild already strips it from
  `decodeWorker.bundle.js` — so it is source-level clutter that reads like a
  live path and is not one.

  Still folded into item 12 phase 1, which retires the `parse-exr`, `upng` and
  `pako` fallbacks on the same criterion — each of those needs its own version
  of step 1, since none of them is instrumented either.

- **Decoder coverage sweep — keep it re-runnable.** The comparison above came
  from generating a TIFF matrix with `tifffile` (9 sample types x 6 codecs, plus
  planar, tiled, RGB/RGBA, palette, CMYK, YCbCr, MINISWHITE, predictors 2 and 3,
  BigTIFF, multipage and bilevel) and decoding every file through the core
  module, the codec module and geotiff.js, then diffing which decoder accepted
  what. It is worth keeping as a script rather than a one-off: it is how the
  geotiff question gets re-answered after the decoders change, and it is what
  found the half-float bugs below.

  Two files failed **both** decoders in that sweep, and neither is an argument
  for keeping geotiff.js:

  1. `f16 + LZMA` — a **real Rust gap, since fixed**. Half floats reached the
     block-codec path only under a codec like LZMA, and that path rejected
     sample format 3 at 16 bits while every other path read it. Fixing it
     exposed a second, worse bug: `half_bits_to_f32` was wrong for **subnormals**
     (off by one in the exponent), which was live in the parallel strip pool for
     any float16 TIFF with values below 6.1e-5. Both fixed; the conversion now
     has one implementation in `formats::half` with an exhaustive test over all
     65536 bit patterns. The lesson worth keeping: there were two half-float
     converters and only one was tested.
  2. `predictor 3 + uint16` — **not a bug**. `tifffile` refuses that combination,
     leaving an 8-byte header stub on disk; both decoders correctly reject it.
     Recorded only so a future sweep does not re-investigate it.

  **Known limit of this method:** every file is written by a conformant encoder,
  so the sweep says nothing about malformed input — which is exactly the
  question the geotiff removal turns on. Widening it would mean fuzzing or a
  corpus of real-world files, not more `tifffile` variants.
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

   **There are two independent ceilings; tiling addresses only the first.**

   | Stage | Ceiling | 20480x20480 float32 |
   | --- | --- | --- |
   | Metadata | none (headers) | fine |
   | Decode (Rust/wasm32) | 4 GB address space | 1.6 GB, near the wall |
   | Raw samples in JS | multi-GB typed arrays | fine |
   | Pixel inspection | none — O(1) index | fine |
   | Histogram | subsamples to 262,144 px | fine |
   | ImageData | width x height x 4 | 1.6 GB |
   | **2D canvas** | **2^28 px (Chromium)** | **419 Mpx — exceeded** |

   Display is the only stage that must materialize every pixel at once into a
   browser-managed surface, which is why everything else keeps working on an
   image that will not render. Today that costs three full-size buffers at
   once (samples + ImageData + canvas backing store, ~4.8 GB at 20480x20480),
   which is what actually killed the webview before the guard in
   `renderImageDataToCanvas` was added. Tiled display removes the ImageData and
   canvas copies, leaving only the decoded samples resident.

   Passing the *decode* ceiling is separate work: it needs region-wise decoding,
   which is natural for tiled TIFF and Zarr, awkward for stripped TIFF, and
   impossible for formats that must be decoded whole.

   **Decide the decode contract before writing any tiling code** — retrofitting
   it later is expensive:

   - Can a decoder be asked for a sub-region, and how does it advertise that?
     Suggested shape: an optional `decode_region(data, x, y, w, h, level)`
     alongside the existing whole-image entry point, with a capability flag per
     format, so callers can ask rather than guess.
   - What does a decoder that cannot do regions return — an error, or the whole
     image with the region ignored? It must be explicit; a silent whole-image
     decode inside a tile loop would decode the file once per tile.
   - Who owns tile lifetime and eviction: the compositor, or a shared cache
     used by all four backends?
   - How do whole-image statistics (auto-normalize min/max, histogram) work
     when no single tile sees the whole image? Either a pre-pass over tiles or
     an explicitly documented approximation.
   - Halo/overlap policy for any operation that reads neighbouring pixels;
     getting this wrong shows up as visible seams.

   **Prerequisite already met:** every backend must fail loudly rather than
   silently. WebGPU used to report a successful render for a texture it could
   not allocate — as one image that was a blank canvas, but per tile it would
   be an intermittently blank patch, far harder to diagnose. `createTexture`
   now rejects over-budget allocations up front and `renderNow` brackets the
   whole render in `out-of-memory`/`validation` error scopes.
4. **OME channel-to-layer compositing.** This is the strongest user-facing next
   feature now that multidimensional navigation and the layer engine both
   exist; add per-channel tint/colormap settings and a merged channel view.
5. **OME-Zarr, local first.** Reuse dataset navigation, then add chunked remote
   access once local hierarchy, metadata, and cache behavior are stable.
6. **Pyramidal/tiled viewport loading.** Decode only visible tiles at the
   appropriate level for whole-slide and very large OME-TIFF data.
7. **Lens undistortion.** Independent and ready to schedule when calibrated
   camera workflows become a priority.
8. **Playback (item 9).** After the page cache/prefetch follow-up from item 1 —
   stuttering playback is worse than none. Its cross-item follow-up (measuring
   one ROI across every frame) is what turns it from a viewing convenience into
   an analysis feature.
9. **OME-Zarr, local first** (item 3), reusing the dataset navigation before
   adding chunked remote access.
10. **Rust-first migration, phases 0 and 1** (item 12). Splitting the crate is a
    prerequisite for anything else added to it, and porting the remaining
    decoders is what finally retires the parse-exr/upng fallbacks (geotiff.js
    now needs only the instrumentation step, not more porting) and
    makes the shared-core extraction in item 11 step 1 tractable.
