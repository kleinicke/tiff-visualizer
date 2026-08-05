# Change Log

## Unreleased

- Add full in-editor documentation. **TIFF Visualizer: Show Documentation**
  (Command Palette, or the right-click menu inside an open image) opens it in
  VS Code's markdown preview. Twelve pages covering formats, viewing,
  normalization, datasets, collections, measurement, layers, export, a generated
  command reference, and troubleshooting. Nothing opens on install.
- `docs/commands.md` is generated from `package.json` by
  `npm run docs:commands`; `pretest` fails if it is stale.

- Add a **Channels** panel (right-click menu or command palette) for
  multi-channel compositing: several channels shown at once, each with its own
  tint, display range and opacity, added together the way emission combines at
  the detector. Channel names and colours are taken from OME metadata where the
  file provides them. Works for interleaved multi-sample images and for OME-TIFF
  where each channel is its own page, whose sibling planes are decoded in the
  background. Solo dims the other channels rather than reconfiguring them, and
  "Auto" uses a percentile range so one hot pixel cannot flatten the signal.
  Compositing is off until switched on, so single-channel viewing is unchanged.
- Add a **Measure** panel (context menu, or Ctrl/Cmd+Shift+M) with ROI drawing,
  measurements, thresholding, and particle analysis. Nothing about it is visible
  until the panel is opened.
- Spatial calibration is read automatically from OME-TIFF physical pixel sizes
  or baseline TIFF resolution tags, and can be set from a drawn line of known
  length. A scale bar and physical-unit readouts follow from it.
- ROI tools: rectangle, ellipse, polygon, freehand, line, polyline, multi-point
  counter, magic wand, brush, and an edge-snapping trace (livewire). Full undo
  history.
- Measurements per ROI: area, perimeter, mean/StdDev/min/max/median/mode,
  integrated density, centroid and centre of mass, bounding box, fitted ellipse,
  Feret diameters, circularity, solidity, aspect ratio, roundness. Statistics
  always run on the raw sample values, never on the displayed (normalised,
  gamma-corrected, colormapped) image, and NaN/Infinity are excluded and
  reported rather than counted as zero.
- Intensity profile along a line or polyline, with an averaged perpendicular
  band and CSV export.
- The threshold is painted over the image while you tune it: red for everything
  it selected, green for the objects that survive the particle filters, so
  "selected but filtered out" is visible instead of only implied by a smaller
  count. Hovering a method in the gallery previews its effect immediately, and
  clicking a row in the results table scrolls that object into view and boxes
  it.
- Thresholding shows thirteen global and five local auto-threshold methods as a
  live gallery that previews each on hover, a
  **stability curve** that plots object count against threshold so a plateau —
  a value the answer does not depend on — is visible rather than guessed, and
  local adaptive methods (Sauvola, Niblack, Phansalkar, mean, median) for
  unevenly illuminated images. Gaussian blur and rolling-ball background
  subtraction can be applied to the segmentation copy without touching the
  displayed image.
- Particle analysis with connected-component labelling, hole filling, size and
  shape filters, edge exclusion, and two ways to separate touching objects:
  a distance-transform watershed for overlapping round objects, and a split at
  intensity maxima with an adjustable prominence — the equivalent of ImageJ's
  Find Maxima with "Segmented Particles", for objects that touch without their
  outline pinching. In ImageJ that workflow needs two images combined with an
  AND in the Image Calculator; here the threshold mask is simply the region the
  maxima are found in.
- A **Summary** table (n, mean, SD, SEM, min, max per measured column) — ImageJ's
  "Summarize", which is usually the number that actually gets written down.
- The magic wand previews its selection on hover and can pick its own tolerance,
  so a click produces the object instead of starting a click-undo-retry loop.
- ROIs are stored as a readable JSON sidecar next to the image
  (`image.tif.rois.json`), so they diff in review and can be edited by hand.
  ImageJ `.roi` and `RoiSet.zip` are supported for import and export.
- Measurement ROIs and their calibration survive a webview reload: they are kept
  in the editor's own state as well as in the sidecar, so moving a tab, splitting
  the editor, or an extension host restart no longer discards the work.
- Exported CSV, scripts, and spreadsheets open in a side editor without stealing
  focus, so the image preview stays visible and the measurement session is
  untouched.
- **Measure** is available from the command palette.
- A column chooser for the results table, grouped the way ImageJ's "Set
  Measurements" is. Exports are unaffected and always carry every measured
  column.
- Opening an image that has `*.rois.json` beside it loads those ROIs
  automatically — unless ROIs are already on screen, in which case nothing is
  discarded and the panel says the file is there.
- **Collect results from every image I measure** accumulates rows across a
  collection into one export, with each row keeping the scale, threshold and
  grouping columns it was actually measured with.
- Rectangles and ellipses can be rotated by a grip above the shape; corner
  handles then resize in the shape's own frame instead of shearing it.
- The Segment tab leads with a draggable histogram: drag either edge of the
  shaded band to set the threshold range and watch the mask on the image follow.
- Global and local threshold methods are one list, so the hover preview always
  shows what clicking would actually apply. Previously a local method could be
  selected while the gallery kept previewing a global cut.
- The stability curve is click- and drag-scrubbable, and picks the value under
  the cursor instead of one offset by the plot margin.
- Mask and ROI visibility toggle from the panel header or with M and O, and
  holding H hides everything to compare against the raw image.
- Hovering a row in the results table highlights its object on the image, so
  finding an object no longer requires selecting it.
- Results export in long/tidy form with provenance columns on every row, as CSV,
  German-locale CSV (semicolon separator, comma decimal mark), or `.xlsx`.
  Grouping columns can be captured from the filename, derived columns from
  expressions, and a pandas script can be written alongside the CSV — generated
  from the session, carrying the columns that exist, the scale and threshold in
  force, and any derived expressions translated for pandas.
  Selecting a table row highlights its ROI on the image and vice versa.

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
