[← Documentation index](./index.md)

# Export and interchange

## Export…

The **Export…** command writes the current image or layer stack. Targets:

| Format | What it writes |
| --- | --- |
| **PNG** | The rendered image as displayed — normalization, gamma, brightness and colormap baked in |
| **OpenRaster (.ora)** | Layer stack, open standard, opens in Krita and GIMP |
| **GIMP 3 XCF (.xcf)** | Layer stack for GIMP 3 |
| **Krita (.kra)** | Layer stack for Krita |
| **Photoshop (.psd)** | Layer stack for Photoshop and compatible tools |

The distinction to keep straight: **PNG export is display output**, 8-bit, with
your view settings applied — it is what you paste into a paper or a slide. The
layered formats preserve the stack structure so you can keep editing elsewhere.
Neither is a way to write scientific data back out; this extension is a viewer,
not a converter.

Export correctness is referenced against the synchronous CPU compositing path,
so an exported composite matches the CPU render regardless of which GPU backend
was driving your screen.

## Copy Image

**Copy Image** puts the rendered image on the clipboard, ready to paste into a
document, chat or issue. Same rule as PNG export: what you see is what you get,
including the current display settings.

## Copy Image Information

`Ctrl`/`Cmd` + `Shift` + `I` copies a text summary — dimensions, format, bit
depth, channels, statistics. Pair it with a screenshot when reporting anything;
it saves a round trip of questions.

The metadata panel's copy button does the fuller version: all metadata and
statistics as JSON.

## Measurement results

Covered in detail in [measurement](./measure.md): tidy CSV with provenance,
German-locale CSV, real `.xlsx`, a generated pandas script, and standalone CSV
export for line profiles.

ROIs themselves live in a JSON sidecar next to the image and interchange with
ImageJ `.roi` and `RoiSet.zip`.

## Point clouds

**Open as Point Cloud** sends the currently selected single-channel image plane
as an NPY file to the **3D Point Cloud and Mesh Visualizer** extension
(`kleinicke.ply-visualizer`), which must be installed separately. It uses the
selected array, slice or frame and the decoded sample values, without display
normalization, gamma or colormaps. Any source format exposing a scalar decoded
plane can use this handoff; it is not limited to the 3D viewer's depth formats.

RGB images, channel composites, layer blends, unavailable original samples and
in-progress loads are rejected. Samples are written as float64 to preserve their
existing decoded precision, at the decoded plane's resolution. Camera intrinsics,
pose and matching RGB are not transferred; the 3D viewer retains its usual
camera-parameter workflow.

The intermediate file is kept in the extension's cache while the 3D tab is open
and removed when that tab closes in the same session. Files retained across an
editor shutdown remain available for restoring the tab. Invoking the command
with a file outside the active image preview retains the original format-specific
handoff.

## Paste Position

**Paste Position** reads a coordinate from the clipboard and moves the view
there. Combined with copying a pixel position, this is how two people compare
notes about the same location in the same file.
