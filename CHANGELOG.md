# Change Log

## Unreleased

- Rename the Command Palette category and the settings section from "TIFF Visualizer" to "Scientific Image Visualizer". Command IDs are unchanged, so keybindings and tasks keep working.
- Massive rust rewrite
- Build the Rust/WASM decoder with SIMD128 enabled.
- Add full in-editor documentation, opened with **Scientific Image Visualizer: Show Documentation** from the Command Palette or the right-click menu. Nothing opens on install.
- Add a measurement panel (`Ctrl`/`Cmd` + `Shift` + `M`): ROI tools with full undo, calibrated area/perimeter/shape/intensity statistics, intensity profiles along a line, and a results table linked both ways to the image.
- Read spatial calibration automatically from OME-TIFF physical pixel sizes or TIFF resolution tags, or set it from a drawn line of known length; add a scale bar and physical-unit readouts.
- Add thresholding with eighteen global and local methods previewed on hover, a draggable histogram, a stability curve for judging how robust a threshold is, and non-destructive blur and background subtraction.
- Add particle analysis with hole filling, size and shape filters, watershed and intensity-maxima splitting, and a summary table. The segmentation is painted over the image while you tune it.
- Store ROIs as a readable JSON file next to the image, loaded automatically on open; import and export ImageJ `.roi` and `RoiSet.zip`.
- Export results as tidy CSV with full provenance, German-locale CSV, `.xlsx`, or a generated pandas script, optionally accumulated across a whole collection.
- Add a channels panel for multi-channel compositing — per-channel tint, display range and opacity, rendered with WebGPU where available — and a per-channel histogram to match.
- Measurement statistics always read raw sample values, never the displayed image, and exclude NaN/Infinity rather than counting them as zero.

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
