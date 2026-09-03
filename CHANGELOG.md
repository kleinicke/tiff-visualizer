# Change Log

## 1.11.0 (2026-)

- Noticeable speedup for tiff, exr, png, jpg and other image formats by improving the startup procedure
- Add several additional tiff compression standards
- Read GeoTIFF georeferencing: named GeoKeys and a CRS label in the metadata panel, and map coordinates under the cursor
- Open standalone JPEG 2000 files (`.jp2`, `.jpf`, `.jpx`, `.j2k`, `.j2c`, `.jpc`) at native precision
- Render multi-band GeoTIFFs correctly: a band past the colour samples is treated as alpha only when the file's `ExtraSamples` tag says so, which previously made a 2-band COG almost entirely transparent
- Treat a pyramidal TIFF's overviews (COG, whole-slide) as resolution levels of one image rather than as extra pages, with a Level selector that names each level
- Open images that exceed the canvas limit at their largest usable pyramid level instead of failing, and refine to a finer level when zooming in
- Apply GDAL's per-band scale/offset to the pixel readout, and use band descriptions as channel names
- Draw `GDAL_NODATA` pixels in the nodata colour and report them as `nodata` instead of as their sentinel value
- Add **transparent** as a third choice for pixels with no value, alongside black and fuchsia: they become real holes, so a layer underneath shows through and an exported PNG carries a hole rather than a coloured patch (what GDAL and QGIS do with nodata). The command cycles the three.
- Open an image from an `https://` link — a command in the extension, a link box and `?url=` on the website
- Log one line per load naming what became visible (size, samples, type, level)
- Explain complex-sample TIFFs (SAR single-look-complex) instead of reporting them as a decode failure

## 1.10.0 (2026-08-22)

- Rename the Command Palette category and the settings section from "TIFF Visualizer" to "Scientific Image Visualizer".
- Massive rust rewrite
- Speedup through parallelism, rust, gpu and general optimizations
- Improve performance logs and automatic tests
- Add measurement palette for segmenting objects
- Add experimental debayering mode, to try out different debayering schemes.
- Improve DICOM reading and add CZI, nd2, lif compatibility
- Add documentation command to see
- Set max canvas size to 268 megapixel
- Created corresponding website version

## 1.9.0 (2026-07-24)

- Add a metadata panel with file details, image statistics, and EXIF/GPS tags.
- Expand TIFF decoding support and handle additional sample, compression, orientation, and metadata edge cases.
- Add multidimensional navigation for OME-TIFF, FITS, DICOM, and NetCDF datasets.
- Add embedded or saved previews for ORA, KRA, PSD/PSB, XCF, and Affinity Photo documents.
- Reconstruct editable layers from ORA, KRA, PSD/PSB, and XCF, including groups, masks, clipping, common blend modes, and compatible adjustment filters.
- Add layer/filter duplication, filter copying, undo/redo, persistent layer state, and responsive worker-based compositing.
- Add compatibility-aware export to PNG, PSD, GIMP 3 XCF, KRA, and ORA.

## 1.8.0 (2026-06-20)

- Support more tiff compression formats
- Improve colormap support
- Speed up loading and decoding by in average 30% by using WebGL2/GPU
- Use Rust/WASM for HDR, 16bit PNG, EXR and TIFF

## 1.7.0 (2026-06-14)

- Add more file formats: webp, hdr, jxl, tga, bmp and ico files
- Renamed extension to Scientific Image Visualizer
- Improving the collection feature to have multiple images next to each other.
- Adding a layer feature allowing to compose multiple images with each other.
- Reworked colormaps into a unified feature: apply a colormap (pseudocolor) to any single-channel image as a non-destructive render setting that also works in layers, and decode colormapped RGB images back to float through the central pipeline.

## 1.6.0 (2026-03-30)

- Add option to add multiple files to collection
- Stabilize quick switching between images

## 1.5.0 (2025-12-01)

- Use a centralized rendering pipeline
- Use Rust decoding for tiff and npy files
- Use native png and jpg decoding
- Speedup webview creation time
- Improve Histogram appearance
- Can convert 8 bit rgb images into 24 bit float images

## 1.4.0 (2025-11-12)

- Add support for OpenEXR (.exr) HDR image files
- Support for 16-bit half-float and 32-bit full-float EXR images using the parse-exr library with Single channel (grayscale/depth), RGB, and RGBA support
- Speed up normalization changes
- Add right click menu with previously hidden commands
- Allow color picker to show modified values
- Add simple histogram support

## 1.3.0 (2025-10-21)

- Allow manual normalizations for all data formats
- Simplify the normalization implementations
- Allow interpreting rgb uint8 images as 24 bit image
- Fix several implementation issues regarding the normalizations

## 1.2.0 (2025-09-09)

- Fix Image size visualization
- Allow masks to filter images
- Add option to switch NaN color to fuchsia
- Fix Image jumps to top left when starting to zoom in
- Add support for npy, png, jpg, pfm, ppm and pgm files

## 1.1.0 (2025-07-01)

- Add automatic float normalization and gamma/brightness settings for float images

## 1.0.0 (2025-06-15)

- Initial release of TIFF Visualizer.
