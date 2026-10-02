<!--
JetBrains Marketplace and IDE plugin description. The source of truth.

build.gradle.kts converts this file (GitHub-flavoured Markdown) to HTML and
writes it into plugin.xml's <description>. Every upload replaces the Marketplace
page with it, so do not edit the description on the Marketplace website.
HTML comments like this one are stripped before conversion.

Where to add things:
  - New file format ........ the format list under the title, a row in
                             "Sample types", and "Not yet supported" if partial
  - New viewer feature ..... "Features" (one bullet, bold name first)
  - New dataset navigation . "Multi-dimensional data"
  - New limitation ......... "Requirements and limitations"
  - Release notes .......... NOT here: <change-notes> in plugin.xml

Only describe what works inside the JetBrains host. This plugin embeds the
standalone web viewer in JCEF, so VS Code-only features (explorer commands,
image collections, comparison panel, DICOM folder import) do not belong here.

Marketplace rules (best-practices-for-listing): the first 40 characters must be
an English summary; no marketing adjectives or unverifiable claims.
-->

Inspect scientific, HDR and standard images in editor tabs: exact pixel values, normalization, gamma and exposure. Decoding runs locally in Rust compiled to WebAssembly; image data is never uploaded.

Supports TIFF/OME-TIFF (including multi-file OME filesets), OpenEXR, NumPy NPY/NPZ, FITS, DICOM, classic NetCDF, Zeiss CZI, Nikon ND2, Leica LIF, Becker & Hickl SDT, Radiance HDR, PFM, PPM/PGM/PBM, SGI RGB, TGA, JPEG XL, JPEG XR, JPEG 2000, PNG, JPEG, WebP, AVIF, BMP and ICO. Layered documents from OpenRaster, Krita, Photoshop PSD/PSB, GIMP XCF and Affinity Photo are previewed too.

## Sample types

| Format | uint8 | uint16 | float16 | float32 | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| TIFF / OME-TIFF | Yes | Yes | Yes | Yes | Multi-page and multi-file OME C/Z/T navigation |
| EXR | No | No | Yes | Yes | HDR floating point |
| NPY / NPZ | Yes | Yes | Yes | Yes | Also float64 and signed/unsigned integers up to 64 bit |
| FITS / DICOM / NetCDF / CZI / ND2 / LIF / SDT | Yes | Yes | No | Yes | Numeric HDUs, DICOM frames, NetCDF variables, microscopy stacks, FLIM/TCSPC histograms |
| HDR | No | No | No | Yes | Radiance RGBE, decoded to float32 |
| PFM | No | No | No | Yes | Portable Float Map |
| PPM / PGM / PBM | Yes | Yes | No | No | PBM is 1-bit, shown as 8-bit |
| PNG | Yes | Yes | No | No | Palette PNGs become 8-bit RGBA |
| SGI RGB | Yes | Yes | No | No | Uncompressed and RLE, grey or RGB with optional alpha |
| JPEG / WebP / AVIF / BMP / ICO / TGA | Yes | No | No | No | 8-bit |
| JPEG XL | Yes | Yes | No | Yes | At the file's own sample type |
| JPEG XR | Yes | Yes | No | Yes | Including scene-referred float |
| JPEG 2000 | Yes | Yes | No | No | Native precision: a 12-bit band normalizes against 4095 |
| ORA / KRA / PSD / PSB / XCF / Affinity Photo | Yes | PSD/PSB | No | PSD/PSB | Embedded previews; common layer stacks are composed |

## Features

- **TIFF in Rust**: high-bit-depth, floating-point, multi-channel, tiled and stripped TIFF with LZW, Deflate, PackBits, Zstd, LZMA, LERC (including GDAL's LERC_DEFLATE and LERC_ZSTD), PNG-in-TIFF, JPEG, JPEG 2000, JPEG XR, JPEG XL, WebP or CCITT fax compression.
- **Pixel inspection**: hover over a pixel to see its exact value in the status bar, with every channel of multi-channel images.
- **Normalization**: automatic min/max, a custom range, or integer images viewed as normalized floats.
- **Gamma and exposure**: separate source and target gamma; exposure is applied in linear space.
- **Histogram and metadata**: histogram overlay, image statistics (min/max/mean/std), file information and Exif/GPS tags.
- **Multi-channel compositing**: several channels at once, each with its own tint, display range and opacity, as in Fiji's Composite mode. Channel names and colors come from OME metadata. Solo, percentile auto-range and an optional colormap per channel.
- **Measurement**: regions of interest with area, perimeter, mean/StdDev/min/max, integrated density, centroid, fitted ellipse, Feret diameters and circularity, in physical units from OME-TIFF or TIFF resolution tags. Line intensity profiles, a magic wand, eighteen auto-threshold methods compared side by side, and particle analysis with watershed splitting. Statistics use the raw sample values and report NaN/Infinity instead of counting them as zero. ROIs save as JSON; ImageJ `.roi` and `RoiSet.zip` can be imported; results export as CSV or `.xlsx`.
- **Layers**: composite several images, for example to take a difference or apply a mask. Layered documents keep nested groups, visibility and filters; approximated or unsupported operations are reported, not hidden.
- **NaN color**: choose how NaN values are displayed.
- **Export**: save the rendered view as PNG.
- **Controls**: zoom, size, normalization, gamma and exposure are IDE status bar widgets; other actions are in the viewer's right-click menu.

## Multi-dimensional data

- **OME-TIFF**: series, channels, Z slices and timepoints from OME-XML. A multi-file dataset behaves as one image: changing C/Z/T opens the right file and page. `BinaryOnly` members follow metadata in a master OME-TIFF or a companion `.ome`/`.ome.xml` file.
- **Multi-page TIFF**: step through pages, even without dimension metadata.
- **DICOM**: frames of multi-frame objects, including JPEG Baseline.
- **CZI / ND2 / LIF**: arrow keys for Z, `[` and `]` for channels, or one slider per axis; channel sliders show the dye name. Mosaic tiles are assembled into the full frame. ND2 adds time and stage-position axes; LIF adds a series selector.
- **SDT**: FLIM/TCSPC histograms as integrated intensity, mean photon arrival time in nanoseconds, or a single time bin.
- **NetCDF**: pick a numeric variable and step through its non-spatial dimensions. X/Y grids render as rasters; MPAS `nCells` fields render as cell polygons.

## Requirements and limitations

- IDE build 2024.3 or later with JCEF (the default JetBrains Runtime). Tested in PyCharm.
- PNG, JPEG, BMP, ICO, WebP and AVIF keep the IDE's own image editor by default; switch to this viewer's editor tab to use it.
- Viewer settings are not restored when an editor is reopened.
- Not yet supported: NetCDF-4/HDF5, multi-file CZI, compressed and pre-2012 ND2, and DICOM JPEG XR and video transfer syntaxes.
- Images above about 268 megapixels decode, and their values, metadata and statistics remain available, but cannot be displayed: a browser canvas is limited to 2^28 pixels.
- DICOM folder import, image collections and side-by-side comparison are currently only in the VS Code extension.

**Medical-use notice:** DICOM support is intended for development, research and scientific visualization. This plugin is not a certified or cleared medical device and must not be used for diagnosis, treatment planning, clinical decisions or any other clinical use.

## Links

- [Source, issues and feature requests](https://github.com/kleinicke/tiff-visualizer/issues). Suggestions for more formats are welcome.
- [Documentation](https://github.com/kleinicke/tiff-visualizer/blob/main/docs/index.md)
- [Web version](https://images.f-kleinicke.de/): the same viewer in the browser
