[← Documentation index](./index.md)

# Multi-dimensional datasets

Scientific images are frequently not one image. A microscopy acquisition has
channels, Z slices and time points; a CT study has slices and series; a climate
file has depth and time. This extension presents those as one logical image with
dimension controls, rather than as a folder of files sorted by name.

Navigate the primary dimension with `←` and `→`; the remaining dimensions get
their own controls in the viewer.

## OME-TIFF

Reads OME-XML and exposes **image/series**, **channel (C)**, **Z slice** and
**timepoint (T)**.

Multi-file datasets are the interesting case: an OME dataset often spreads
planes across many physical TIFF files. The viewer presents the whole thing as
one image and transparently opens the right file and the right IFD as you change
C, Z or T. You navigate the experiment, not the filesystem.

`BinaryOnly` members automatically follow the metadata stored in a master
OME-TIFF or a companion `.ome` / `.ome.xml` file, so opening any member of a
dataset gets you the full dimensional structure.

Physical pixel sizes from OME-XML pre-fill the [measurement](./measure.md)
scale.

## DICOM

For a folder of DICOM files — including extensionless ones, which is the normal
case for exported studies — run **Scientific Image Visualizer: Open Folder as DICOM
Dataset**.

The viewer then:

- reads technical headers rather than trusting filenames
- groups images into **acquisition series**
- removes duplicate SOP instances
- orders slices **spatially**, not alphabetically

You pick a series and navigate its slices plus whatever other dimensions exist —
time, echo, and frame. Multi-frame objects, including JPEG Baseline compressed
ones, expose a **Frame** control.

The spatial ordering matters more than it sounds. Filename-sorted DICOM slices
are a well-known way to produce a stack that looks fine and is anatomically
scrambled.

> **Medical-use notice:** this is for developer, research and scientific
> visualization workflows. It is not a certified or cleared medical device and
> is not intended for diagnosis, treatment planning, clinical decision-making or
> other clinical use. Do not rely on it as the sole means of viewing or
> interpreting medical images.

## Multi-page TIFF

Plain multi-page TIFFs with no dimensional metadata are navigable by page with
`[` / `]` or `PageUp` / `PageDown`, and with the arrow keys when no dataset or
collection is loaded.

## Pyramidal TIFF (COG, whole-slide)

Some TIFFs store the same scene several times at halving resolutions — a
Cloud-Optimized GeoTIFF and most whole-slide images do. Those extra images are
**levels**, not pages: they are the same data, downsampled. The overlay offers
a **Level** selector for them, showing each level's reduction and size
(`Full · 10980x10980`, `1/4 · 2745x2745`), and a Page selector as well only
when the file really does hold more than one image.

**The level is chosen for you.** Opening a file picks the level that matches
your window, zooming in loads a finer one, and the image stays the same size on
screen across the switch — so what you see always looks like full resolution for
the area you are looking at. The selector reads **Auto** while that is
happening; picking a level from it pins that one, and choosing Auto again hands
the decision back.

Under the selector is a line saying what is actually on screen:

    Loaded 1/8 · 1373x1373 of 10980x10980 · viewing 0,0 10240x5760 (49% of the
    scene) · 0.13x detail

— which level is decoded, how much of the full-resolution scene is in view, and
how many screen pixels each stored pixel gets (1.0 means every stored pixel is
on screen; below that the view is coarser than the file).

What it chooses, and why:

- **Full resolution** whenever the image is small enough that you would not wait
  for it (about 40 megapixels), because the values under the cursor come from
  whatever was decoded, and a reduced level means an approximate readout.
- **The level that matches your window** for anything larger — a 10980x10980
  Sentinel-2 band opens in about 200 ms this way instead of four seconds, and at
  fit-to-window it looks identical. While a reduced level is showing, the pixel
  readout says so (`… · 1/8 overview`), so an approximate value never passes for
  a stored one.
- **The largest level that can be drawn at all** when even that is too big.
  Browsers cap how many pixels a canvas can hold, so a 40000x40000 raster can
  never be shown whole; it opens at a usable level instead of failing.

Zooming back out keeps the sharper data already decoded. Picking a level from
the selector yourself pins it — automatic refinement stops until you reopen the
file.

One limit worth knowing: refinement loads a whole level, not just the part you
are looking at. For an image whose full resolution exceeds the canvas limit,
zooming in cannot reach the stored pixels.

**On Auto, the viewer lifts that limit for the part you are looking at.** The
decoder can read a rectangle — a 1600x1000 view of a 10980x10980 band is four
tiles and about 25 ms, against a second for the whole page — so while the level
is chosen automatically:

- a sharp **patch** of a finer level is drawn over the visible area, and a
  40000x40000 scene shows its stored pixels at high zoom even though no canvas
  could ever hold that level whole. The coarse image underneath is unchanged and
  still the image for every other purpose;
- that coarse image stops growing once it passes the size worth decoding (about
  40 megapixels), since the patch already shows the detail where you are looking.
  Zooming into a 10980x10980 band settles in about 3 seconds rather than 5, and
  holds a quarter of the pixels;
- hovering reads the value actually **stored** under the cursor rather than the
  overview's average, so the readout is exact and drops its `overview` caveat.

Choosing a level by hand turns all of that off: a pinned level is a statement
about which resolution you want to look at, and laying a finer one over it would
contradict the choice. Selecting **Auto** again brings it back.

## CZI

Zeiss microscopy stacks. The overlay gives one slider per non-spatial axis
(Z, C, T, ...), and channel sliders are labelled with the dye name read from the
embedded metadata.

- `←` / `→` step through **Z**, so a stack scrubs like a dataset does. They wrap
  at either end, and defer to a dataset or a multi-image collection if one is
  loaded.
- `[` / `]` or `PageUp` / `PageDown` step through **channels**.

The overlay repeats these bindings under the sliders. Dragging a slider updates
the image continuously rather than on release: one plane loads at a time and the
newest handle position is kept as the trailing request, so the image tracks the
handle as fast as the machine allows and always settles on the released value.

Mosaic tiles are assembled into the full frame rather than offered as a
selectable axis. Uncompressed, JPEG, LZW, JPEG XR and Zstd subblocks decode; see
[formats](./formats.md).

Pixel scaling from the CZI metadata is adopted as the measure
[calibration](./measure.md) in micrometres, including ScalingZ as the slice
depth, so a stack draws a real scale bar and measures in µm without being told
the scale.

Stepping planes re-decodes from bytes the decode worker keeps between requests,
so only the first plane of a file pays the read cost.

## NetCDF

Classic (v3) NetCDF. Select a numeric **variable**, then move through its
non-spatial dimensions.

- Regular X/Y arrays render as rasters.
- **MPAS** `nCells` fields render on their unstructured cell polygons in an
  equirectangular mesh view — unstructured climate model output does not fit a
  raster grid, so it is drawn as the polygons it actually is.

NetCDF-4 / HDF5 containers are not supported.

## FITS

Numeric HDUs are listed for selection and then behave like any other image, with
full float support and the usual normalization controls — which matter here more
than most places, since astronomical dynamic range rarely survives a naive 0–255
mapping.
