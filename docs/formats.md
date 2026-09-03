[← Documentation index](./index.md)

# Supported formats

## Sample type matrix

| Format | uint8 | uint16 | float16 | float32 | Notes |
| --- | :---: | :---: | :---: | :---: | --- |
| TIFF / OME-TIFF | Yes | Yes | Yes | Yes | Rust/WASM decoding; multi-page and multi-file OME C/Z/T navigation |
| EXR | No | No | Yes | Yes | HDR floating-point |
| NPY / NPZ | Yes | Yes | Yes | Yes | Also float64 and signed/unsigned integers up to 64 bit |
| FITS / DICOM / NetCDF | Yes | Yes | No | Yes | Numeric HDUs, DICOM series/frames, classic NetCDF variables, MPAS meshes |
| CZI | Yes | Yes | No | Yes | Zeiss microscopy; uncompressed/JPEG/LZW/JPEG XR/Zstd/CHUNKED subblocks, Z/C/T plane selection, mosaic tiles |
| ND2 | Yes | Yes | No | Yes | Nikon microscopy; modern chunk-based files, uncompressed frames, T/P/Z/C plane selection |
| LIF | Yes | Yes | No | Yes | Leica microscopy; multi-series files, Z/T/mosaic plane selection, planar channels |
| SDT | No | Yes | No | Yes | uint16/uint32/float64 source histograms; intensity, mean-arrival, and raw time-bin views |
| HDR | No | No | No | Yes | Radiance RGBE, decoded to float32 |
| PFM | No | No | No | Yes | Portable Float Map |
| PPM / PGM / PBM | Yes | Yes | No | No | PBM is 1-bit, shown as 8-bit |
| PNG | Yes | Yes | No | No | Palette PNGs become 8-bit RGBA |
| JPEG / WebP / AVIF / BMP / ICO / TGA | Yes | No | No | No | Decoded as 8-bit |
| JPEG XL (`.jxl`) | Yes | Yes | No | Yes | Decoded in Rust; 8/16-bit and float, greyscale or RGB(A) |
| ORA / KRA / PSD / PSB / XCF / Affinity | Yes | PSD/PSB | No | PSD/PSB | Previews, and layer composition where supported — see [layers](./layers.md) |

File extensions registered by the extension:
`tif tiff tf2 tf8 btf exr pfm npy npz ppm pgm pbm hdr tga jxl jxr wdp hdp
jp2 jpf jpx j2k j2c jpc fits fit fts dcm dicom nc cdf czi nd2 lif sdt ora
kra psd psb xcf afphoto af` open automatically;
`png jpeg jpg bmp ico webp avif` are available via **Open With…**.

## How decoding works

Every format is reduced to the same internal representation — a `Float32Array`
of samples plus a description of what those samples are (bit depth, channel
count, integer or float, and the type's nominal maximum). Rendering,
statistics, the histogram and measurement all operate on that one
representation, which is why a 16-bit TIFF, a float EXR and a NumPy array behave
identically once loaded.

Decoding runs in a worker thread wherever possible, so a large file does not
freeze the editor. Bytes are transferred rather than copied. Every worker path
retains a main-thread fallback, so decoding still works if workers are
unavailable.

## Format notes

### TIFF and OME-TIFF

Decoded by a Rust/WebAssembly decoder built on
[image-tiff](https://github.com/image-rs/image-tiff), with a JavaScript fallback
for files it cannot yet handle. Handles horizontal and floating-point
predictors, tiled and stripped layouts, both planar configurations,
multi-channel data, and bit depths of 8, 16, 32 and 64 in unsigned, signed and
floating-point sample formats. Big TIFF (`tf8`, `btf`) is included. Tiles that
a sparse GeoTIFF never wrote read as zeros.

Compression: none, LZW, Deflate, PackBits, Zstd, LZMA, LERC (including GDAL's
LERC_DEFLATE and LERC_ZSTD), PNG-in-TIFF, JPEG, JPEG 2000 (including the
Aperio 33003/33004/33005 codes slide scanners write), JPEG XR (34934, and the
22610 code Hamamatsu NDPI files use), JPEG XL (50002), WebP, and CCITT Group 3/4 and Modified
Huffman fax. Every one of these is decoded in pure Rust, so they
work the same in VS Code Web as on the desktop. LERC is lossy when it was
written that way; the decoder reproduces the reconstruction its own encoder
defines, and pixels a LERC blob marks invalid read as zero. JPEG 2000 decodes
at its native bit depth, so a 16-bit image stays 16-bit.

JPEG 2000, JPEG XR, LERC, LZMA and WebP are decoded by a second WebAssembly
module downloaded only when a file declares one of them — see "How the decoder
is packaged" below.

Not decoded: old-style JPEG (compression 6), and the legacy
PixarLog, SGILog, ThunderScan, NeXT and JBIG codecs. Files using any of these
report the codec by name rather than failing silently.

Multi-page files are navigable with `[` and `]`. OME-TIFF adds semantic
dimensions and multi-file datasets — see [datasets](./datasets.md).

TIFF resolution tags and OME-XML physical pixel sizes are read automatically and
used to pre-fill the measurement scale, so an ROI area can come out in µm²
without you typing anything.

### JPEG XR

Standalone `.jxr`, `.wdp` and `.hdp` files, decoded by the same Rust codec that
handles JPEG XR inside TIFF ([crates/jpegxr](../crates/jpegxr), a vendored
translation of Microsoft's JXRLib). Grey and RGB(A) at 8, 16 and 32 bits are
supported, unsigned or IEEE float, so a scene-referred float JPEG XR keeps its
range and normalizes like an EXR rather than being flattened to 8-bit.

JPEG XR's packed pixel formats — 5:6:5, 10:10:10, RGBE, the fixed-point layouts
— are reported by name rather than guessed at; reading one as if it were plain
samples would produce a plausible-looking wrong picture.

### GeoTIFF

A GeoTIFF is an ordinary TIFF carrying a few extra tags, so these files open
like any other TIFF — what changes is what the viewer can tell you about them.

The GeoKeyDirectory (34735, with values indirected through 34736 and 34737) is
unpacked into named keys, so the metadata panel shows
`ProjectedCSTypeGeoKey — EPSG:32631 (WGS 84 / UTM zone 31N)` where a raw tag
dump shows `1, 1, 1, 8, 1024, 0, 1, 1, ...`. UTM zone names are computed from
the EPSG code, so all 120 WGS 84 zones are named; a code outside the handful
otherwise recognized reports its bare number rather than a guess.

Hovering a pixel reports its position in the raster's own coordinate system,
next to the pixel index. Georeferencing is read from ModelPixelScale (33550)
plus ModelTiepoint (33922), or from ModelTransformation (34264) when the raster
is rotated — 34264 wins where a file carries both, since the scale/tiepoint
pair cannot express rotation. GTRasterTypeGeoKey is honoured: PixelIsArea
anchors coordinates at a pixel's corner and so reads out its centre half a
pixel in, while PixelIsPoint is already a centre and is taken as-is.

Two deliberate limits. A file with multiple tiepoints and no scale describes a
GCP warp rather than an affine placement, and that is declined rather than
approximated by its first point. And projected coordinates are NOT converted to
latitude/longitude — that needs the projection maths and a datum database, and
a wrong latitude would look entirely plausible. Rasters that are already
geographic do read out as lon/lat, because no projection is involved.

### JPEG 2000

Standalone `.jp2`, `.jpf`, `.jpx`, `.j2k`, `.j2c` and `.jpc` files, decoded by
the same Rust codec that handles JPEG 2000 inside TIFF (compression 34712 and
Aperio's 33003/33004/33005). Both spellings open: the boxed JP2/JPX container
and the bare SOC/SIZ codestream a `.j2k` holds.

This exists mostly for remote sensing. Every Sentinel-2 L1C/L2A band inside a
`.SAFE` product is a standalone `.jp2`, and those files carry no wrapper to
describe their samples.

The decode is at NATIVE precision, and the precision is read off the
codestream rather than from the storage width — which matters more than it
sounds. A Sentinel-2 band is 12-bit data stored in 16-bit samples: normalizing
it against 65535 would render a perfectly correct decode at a sixteenth
brightness. The viewer normalizes against 4095 instead, and defaults such files
to auto-normalize, because reflectance values occupy only the low end of even
the 12-bit range.

Signed codestreams are not supported: the decoder clamps negative samples to
zero, so a signed image would already have lost them. They are vanishingly rare
outside specialist medical data.

### EXR

Half and full float, grayscale, RGB and RGBA. EXR stores rows bottom-up, so the
viewer flips the Y axis on load; the pixel coordinates you see are ordinary
top-left-origin image coordinates.

Because EXR is scene-referred, the default is gamma mode with a 0–1 range rather
than auto-normalization. Values above 1 are real, not errors — use the histogram
and the normalization range to explore them.

### NPY / NPZ

Native NumPy parsing, no Python required. Handles `f2`, `f4`, `f8` and the
integer types `u1 u2 u4 u8 i1 i2 i4 i8`. Shape is interpreted as
`(H, W)`, `(H, W, C)` for 1, 3 or 4 channels. NPZ archives expose their member
arrays for selection.

This is usually the shortest path from a research script to a picture: save an
intermediate tensor with `np.save`, click it in the Explorer.

### FITS, DICOM, NetCDF, CZI, ND2, LIF and SDT

These share a lifecycle: parse the container, list the numeric arrays it
holds, let you pick one, then treat it as an image with extra dimensions.

- **FITS** — numeric HDUs from astronomy pipelines.
- **DICOM** — series, slices, frames, echoes and time points. Use
  **Open Folder as DICOM Dataset** for extensionless studies; the viewer reads
  headers rather than filenames, groups by series, drops duplicate SOP
  instances, and orders slices spatially.
- **NetCDF** — classic (v3) format. Regular X/Y variables render as rasters;
  MPAS `nCells` fields render on their unstructured cell polygons in an
  equirectangular mesh view.
- **ND2** — Nikon microscopy. Pixels live in one chunk per acquired frame,
  addressed by a flat sequence index; the multi-dimensional shape is
  reconstructed from the experiment loop descriptors, so a time series over
  stage positions presents as separate `T` and `P` sliders. Where a loop is
  present in the data but absent from the header, the leftover factor of the
  frame count is recovered as an extra innermost axis rather than collapsing
  the file into an undifferentiated list of frames. An 8-bit three-component
  frame is treated as a colour image; other multi-component frames are
  fluorescence channels and are shown one at a time behind a `C` selector.

- **LIF** — Leica microscopy. One file holds many image series of different
  shapes, selected with the `S` slider. Addressing is entirely stride-driven
  (each channel and each dimension carries its own byte increment), so planar
  and interleaved layouts, Z stacks, time series and mosaics all decode
  through the same arithmetic. `.lifext` sidecars hold derived data such as
  histograms and are not needed to read pixels.

- **CZI** — Zeiss microscopy (ZISRAW). Each plane is stored as its own
  subblock, so the overlay gives one slider per non-spatial axis (Z, C, T, ...)
  and mosaic tiles are assembled into the full frame. Arrow keys step through Z
  and `[` / `]` through channels, as for a dataset. Channel sliders are
  labelled with the dye name from the embedded metadata, and pixel scaling is
  reported in micrometres. Uncompressed, JPEG, LZW, JPEG XR, Zstd-0/Zstd-1,
  and experimental CHUNKED subblocks decode. CHUNKED supports both zstd and
  LZ4 chunks plus the optional 16-bit hi-lo preprocessing.

- **SDT** — Becker & Hickl FLIM/TCSPC measurements. Each spatial pixel stores
  a photon-arrival histogram rather than one intensity. The `Mode` control
  shows integrated intensity, a photon-weighted mean arrival time in
  nanoseconds, or one raw time bin selected with `T`; multi-block files add a
  `B` control. Uncompressed and ZIP-compressed uint16/uint32 histogram blocks
  are supported. Mean arrival is an exploratory visualization, not a fitted
  fluorescence lifetime.

See [datasets](./datasets.md) for navigation.

### HDR, PFM, PPM/PGM/PBM

Small, plain formats with no surprises. HDR is Radiance RGBE expanded to
float32. PFM is float32 with the scale-sign endianness convention. The NetPBM
family supports both binary and ASCII variants.

### PNG, JPEG and the browser formats

PNG carries real bit depth information, and 16-bit PNG is preserved rather than
being crushed to 8. JPEG, WebP, AVIF, BMP, ICO and TGA are decoded as 8-bit
image data. These formats are worth opening here mainly when you want pixel
inspection, the histogram, measurement, or comparison against a scientific
image.

### How the decoder is packaged

Most of what the viewer decodes lives in one WebAssembly module that every
image open downloads. Three groups of codecs do not, because they are large and
rarely needed, and carrying them would slow down every ordinary TIFF:

- **JPEG 2000, JPEG XR, LERC, LZMA, WebP**, and the DICOM JPEG-LS and lossless
  JPEG transfer syntaxes, live in a second module fetched the first time a file
  declares one of them. Since these are codestream codecs, that one module
  serves every container — the same JPEG XR decoder answers for a TIFF tile, a
  CZI subblock and a standalone `.jxr`.
- **JPEG XL** lives in a third, for the same reason (see below). That module
  also carries the shared TIFF and DICOM parsers for embedded codestreams.

Nothing is fetched speculatively: the decoder recognises the codec while
reading the file's header, before any pixel work, and only then downloads what
it needs. A file that uses none of them never pays for any of it.

### JPEG XL

Decoded by [jxl-rs](https://github.com/libjxl/jxl-rs) at the file's own sample
type: an 8-bit `.jxl` arrives as 8-bit, a 16-bit one as 16-bit, and a float one
as float32 with its range intact. Greyscale and RGB are supported, with or
without alpha; the first frame of an animation is shown.

Its decoder is a **separate WebAssembly module** from the one every other
format shares, downloaded the first time you open a `.jxl` or a TIFF/DICOM
declaring JPEG XL, and never otherwise
— it is large enough that carrying it in the main module would slow down every
TIFF open to no purpose. TIFF compression 50002 and DICOM transfer syntaxes
`.4.110`, `.4.111`, and `.4.112` retry the complete container through this
module, preserving page, metadata, sample-type, and Bits Stored handling.

### Layered documents

OpenRaster, Krita, Photoshop PSD/PSB, GIMP XCF and Affinity Photo files open
through their saved or embedded preview, and — where the format's layer data is
readable — can be composed layer by layer in the [layers view](./layers.md).

The rule this follows: an operation that cannot be reproduced exactly is
reported as approximated or unsupported rather than silently skipped. A
composite that looks slightly wrong with an explicit badge is more useful than
one that looks plausible and is wrong.

## Not supported

- NetCDF-4 / HDF5 containers (classic NetCDF only)
- Legacy (pre-2012) ND2 files, which use a different container entirely, and
  ND2 files written with Nikon's lossless or lossy compression
- Multi-file CZI sets. CZI subblocks decode when uncompressed or compressed
  with JPEG, LZW, JPEG XR, Zstd-0/Zstd-1, or experimental CHUNKED
- SDT LZ4-frame-compressed blocks and non-image curve-only measurements
- DICOM JPEG XR transfer syntaxes, the MPEG/HEVC video ones, and
  lossless JPEG with predictor 5 or 6 — the pure-Rust decoder reproduces
  selection values 1-4 and 7 exactly and those two incorrectly, so they are
  refused rather than returned wrong (transfer syntax .70 mandates value 1)
- Writing back to any scientific format — export targets are listed in
  [export](./export.md)

Small synthetic files for manual checks live in `test-samples/scientific/` in
the repository.
