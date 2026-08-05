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
case for exported studies — run **TIFF Visualizer: Open Folder as DICOM
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
