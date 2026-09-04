# Change Log

## 1.11.0 (2026-)

- Noticeable speedup for tiff, exr, png, jpg and other image formats by improving the startup procedure
- Add several additional tiff compression standards
- Read GeoTIFF georeferencing: named GeoKeys and a CRS label in the metadata panel, and map coordinates under the cursor
- Open standalone JPEG 2000 files (`.jp2`, `.jpf`, `.jpx`, `.j2k`, `.j2c`, `.jpc`) at native precision
- Render multi-band GeoTIFFs correctly: a band past the colour samples is treated as alpha only when the file's `ExtraSamples` tag says so, which previously made a 2-band COG almost entirely transparent
- Treat a pyramidal TIFF's overviews (COG, whole-slide) as resolution levels of one image rather than as extra pages, with a Level selector that names each level
- Prefer the patch over a large whole-level decode when zooming in: with region decoding on, a Sentinel-2 band's zoom settles in 2957 ms rather than 5055 ms and holds 30 megapixels rather than 120, and a 40000x40000 scene holds 25 megapixels rather than 400 — while showing the same stored pixels where you are looking
- Draw a sharp patch of a finer pyramid level over the visible area (behind `tiffVisualizer.experimentalRegionDecode`), so a 40000x40000 scene shows its stored pixels at high zoom — no canvas can hold that level whole, but the part on screen is a few tiles
- Fix zooming out on a very large image: the 10% floor made it impossible to see the whole picture, and a pyramid now drops to a coarser level as you zoom out instead of holding the fine one
- Fix a pyramidal file's Level control turning into a page selector after a fallback decode, and refinement stalling several levels short when the level a zoom asked for was too large to draw
- Decode a rectangle of a large tiled TIFF instead of the whole page: a 1600x1000 view of a 10980x10980 band reads 4 tiles in 26 ms where the page takes 974 ms, and the cost barely grows with the image. Behind `tiffVisualizer.experimentalRegionDecode`, this reports the value actually stored under the cursor while a reduced pyramid level is displayed
- Offer **Auto** in the level selector of a pyramidal TIFF, with a status line under it saying which level is loaded, how much of the scene is in view, and how much detail that gives — so the automatic choice is visible, and a manual one can be handed back
- Choose a pyramidal TIFF's resolution level automatically: a level sized for the window when full resolution would be slow (a 10980x10980 Sentinel-2 band opens in ~200 ms instead of ~4 s) or cannot be drawn at all, refining as you zoom in — and the pixel readout says when values come from an overview rather than from the stored pixels
- Apply GDAL's per-band scale/offset to the pixel readout, and use band descriptions as channel names
- Draw `GDAL_NODATA` pixels in the nodata colour and report them as `nodata` instead of as their sentinel value
- Add **transparent** as a third choice for pixels with no value, alongside black and fuchsia: they become real holes, so a layer underneath shows through and an exported PNG carries a hole rather than a coloured patch (what GDAL and QGIS do with nodata). The command cycles the three.
- Open an image from an `https://` link — a command in the extension, a link box and `?url=` on the website
- Log one line per load naming what became visible (size, samples, type, level), but only when it says something the "Opened" line did not — a page or level selection, or a drawn size below the file's own
- Fix the first render of a JPEG XL, JPEG XR, JPEG 2000, FITS, DICOM, NetCDF, CZI, ND2, LIF or SDT image normalizing against [0, 1] instead of the decoded type range: a 16-bit JPEG XL opened almost entirely white and only corrected itself after a settings change
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
