[← Documentation index](./index.md)

# Layers view

**Open Layers View** creates a dedicated compositing window from the currently
displayed image. It is also reachable from the layers status bar entry.

Use it to difference two images, mask one with another, stack channels, or open
a layered document from Photoshop, GIMP, Krita or Affinity and inspect how it is
built.

## Creating a stack

From an open image, run **Open Layers View**. If you are viewing a
[collection](./collections.md), you are asked whether to use only the current
image or stack the complete collection.

Add more layers with the **+** button in the Layers panel, with **Add Image as
Layer**, or by right-clicking a file in the Explorer and choosing **Add Image as
Layer** while a layers window is active.

## Blend modes

| Mode | Typical use |
| --- | --- |
| **Normal** | Plain stacking with opacity |
| **Difference** | **The one you want for comparing two images.** Identical pixels go black; anything non-black is a real difference |
| **Subtract**, **Add** | Signed arithmetic on the sample values |
| **Divide** | Ratio images, flat-field correction |
| **Multiply**, **Screen** | Masking and lightening |
| **Overlay** | Contrast composite |
| **Darken**, **Lighten** | Per-channel min / max |
| **Exclusion** | Softer difference |

Difference blending is the fastest way to answer "did this processing change
anything, and where". Two files that should be identical produce a black frame;
if it is not black, turn up the brightness and the discrepancy will appear.

## Filters

Non-destructive adjustments attached to a layer, editable and removable at any
time:

- **Levels** — remap input/output ranges
- **Curves** — arbitrary transfer function
- **Exposure** — linear-space brightness in stops
- **Threshold** — binarise
- **Posterize** — quantise levels
- **Invert** — negate

Filters are listed under their layer and can be reordered, edited or deleted.
Layer and filter changes support keyboard undo/redo.

## Groups

Imported layered documents keep their nested group structure. The panel
provides:

- Collapsible groups with persistent expansion state
- Group visibility toggles
- **Shift-click to solo** a layer or group — isolate one element without
  clicking every other visibility toggle
- Inline renaming
- Source-compatibility badges (see below)

## Imported documents and honesty about fidelity

When a PSD, XCF, KRA or ORA file uses an operation this extension cannot
reproduce exactly, the layer carries a badge saying so — **approximated** or
**unsupported** — instead of being silently rendered wrong.

What this covers today: compatible PSD adjustment layers, Krita filter masks and
filter layers, and GIMP 3 XCF layer effects are approximated. PSD cached raster
and group layers, ORA layers, Krita paint layers and common XCF rasters compose
properly.

If you are checking whether a composite matches what Photoshop shows, read the
badges first. Broader layer reconstruction is tracked in the
[backlog](https://github.com/kleinicke/tiff-visualizer/blob/main/BACKLOG.md).

## Rendering backend

Unlike the main viewer, the layers view exposes its backend explicitly —
WebGPU, WebGL2 or CPU — with diagnostics. Compositing is where GPU differences
actually show up, so it is worth being able to see and control which path is
running.

Full-resolution compositing happens off the UI thread in a worker, which also
produces scaled previews for interaction so dragging an opacity slider stays
responsive on large stacks. The synchronous CPU path remains the fallback and
the correctness reference for export.

## Layers and collections are exclusive

You cannot have both in one window. If a layers window is active, **Add Images
to Collection** will tell you to add the image as a layer instead.

Two other differences in layers view:

- **Pixel inspection reports the rendered composite.** There is no single
  source value to report, so the original/modified colour picker switch is
  unavailable.
- **A visible histogram follows layer edits** using a bounded sample of the
  composite. A hidden histogram adds no readback and no scheduled work.

## Export

Layer stacks export to PNG (flattened), OpenRaster, GIMP 3 XCF, Krita and
Photoshop PSD. See [export](./export.md).
