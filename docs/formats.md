[← Documentation index](./index.md)

# Supported formats

## Sample type matrix

| Format | uint8 | uint16 | float16 | float32 | Notes |
| --- | :---: | :---: | :---: | :---: | --- |
| TIFF / OME-TIFF | Yes | Yes | Yes | Yes | Rust/WASM decoding; multi-page and multi-file OME C/Z/T navigation |
| EXR | No | No | Yes | Yes | HDR floating-point |
| NPY / NPZ | Yes | Yes | Yes | Yes | Also float64 and signed/unsigned integers up to 64 bit |
| FITS / DICOM / NetCDF | Yes | Yes | No | Yes | Numeric HDUs, DICOM series/frames, classic NetCDF variables, MPAS meshes |
| CZI | Yes | Yes | No | Yes | Zeiss microscopy; uncompressed subblocks, Z/C/T plane selection, mosaic tiles |
| HDR | No | No | No | Yes | Radiance RGBE, decoded to float32 |
| PFM | No | No | No | Yes | Portable Float Map |
| PPM / PGM / PBM | Yes | Yes | No | No | PBM is 1-bit, shown as 8-bit |
| PNG | Yes | Yes | No | No | Palette PNGs become 8-bit RGBA |
| JPEG / WebP / AVIF / BMP / ICO / TGA / JXL | Yes | No | No | No | Decoded as 8-bit |
| ORA / KRA / PSD / PSB / XCF / Affinity | Yes | PSD/PSB | No | PSD/PSB | Previews, and layer composition where supported — see [layers](./layers.md) |

File extensions registered by the extension:
`tif tiff tf2 tf8 btf exr pfm npy npz ppm pgm pbm hdr tga jxl fits fit fts dcm
dicom nc cdf ora kra psd psb xcf afphoto af` open automatically;
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
for files it cannot yet handle. Supports LZW and Deflate compression with
predictors, tiled and stripped layouts, multi-channel data, and bit depths of 8,
16, 32 and 64 in unsigned, signed and floating-point sample formats. Big TIFF
(`tf8`, `btf`) is included.

Multi-page files are navigable with `[` and `]`. OME-TIFF adds semantic
dimensions and multi-file datasets — see [datasets](./datasets.md).

TIFF resolution tags and OME-XML physical pixel sizes are read automatically and
used to pre-fill the measurement scale, so an ROI area can come out in µm²
without you typing anything.

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

### FITS, DICOM, NetCDF and CZI

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
- **CZI** — Zeiss microscopy (ZISRAW). Each plane is stored as its own
  subblock, so the overlay gives one slider per non-spatial axis (Z, C, T, ...)
  and mosaic tiles are assembled into the full frame. Arrow keys step through Z
  and `[` / `]` through channels, as for a dataset. Channel sliders are
  labelled with the dye name from the embedded metadata, and pixel scaling is
  reported in micrometres. Only uncompressed subblocks decode; JPEG, JPEG XR
  and Zstd subblocks report the codec they would need.

See [datasets](./datasets.md) for navigation.

### HDR, PFM, PPM/PGM/PBM

Small, plain formats with no surprises. HDR is Radiance RGBE expanded to
float32. PFM is float32 with the scale-sign endianness convention. The NetPBM
family supports both binary and ASCII variants.

### PNG, JPEG and the browser formats

PNG carries real bit depth information, and 16-bit PNG is preserved rather than
being crushed to 8. JPEG, WebP, AVIF, BMP, ICO, TGA and JXL are decoded as 8-bit
image data. These formats are worth opening here mainly when you want pixel
inspection, the histogram, measurement, or comparison against a scientific
image.

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
- Compressed CZI subblocks (JPEG, JPEG XR, Zstd) and multi-file CZI sets
- DICOM compression other than JPEG Baseline
- Writing back to any scientific format — export targets are listed in
  [export](./export.md)

Small synthetic files for manual checks live in `test-samples/scientific/` in
the repository.
