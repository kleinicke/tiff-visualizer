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

**Open as Point Cloud** passes a depth image (TIFF, PFM or NPY) to the
[3D Point Cloud and Mesh Visualizer](https://marketplace.visualstudio.com/items?itemName=kleinicke.ply-visualizer)
extension, which must be installed separately. If it is not installed the
command explains that rather than failing silently.

## Paste Position

**Paste Position** reads a coordinate from the clipboard and moves the view
there. Combined with copying a pixel position, this is how two people compare
notes about the same location in the same file.
