[← Documentation index](./index.md)

# Getting started

## Opening an image

Click any supported file in the Explorer. For the formats this extension owns
outright — TIFF, EXR, NPY, FITS, DICOM, NetCDF, PFM, PPM, HDR, TGA, JXL and the
layered document formats — the viewer opens automatically.

For formats VS Code can already display (PNG, JPEG, BMP, ICO, WebP, AVIF) the
built-in image preview stays the default and this extension is offered as an
option. To use it:

- **Right-click the file → Open With… → Scientific Image Visualizer**, or
- set it as the permanent default for that extension via **Open With… →
  Configure default editor**.

That split is deliberate: taking over PNG for everyone would be rude, but a
16-bit PNG depth map is exactly the case where you want this viewer.

## Opening an image from a URL

**Scientific Image Visualizer: Open Image from URL...** takes an `https://`
link and opens the image behind it. Scientific imagery increasingly lives at a
URL — a STAC catalogue hands out `https://` hrefs to Sentinel-2 bands, for
instance — and this saves downloading a file by hand before you can look at it.

The viewer reads a small prefix of the response and identifies supported
formats from their binary signature. The URL may therefore have no extension,
use a download endpoint, or even have a misleading suffix. A detected TIFF
still stays remote and range-backed; other detected formats use their normal
decoder. If the host blocks the probe or the format has no distinctive header,
the filename and browser-native fallback remain in effect.

TIFF stays at its original URL and is read in ranges so large tiled files can
stream only the required blocks. Other formats are fetched into the extension's
own storage. Nothing is written into your workspace.

The same works in the [browser version](https://images.f-kleinicke.de): paste a
link into the box on the start screen, or append `?url=<link>` to the address,
which makes a viewer link you can share. The bytes travel from the host to your
browser and nowhere else — which also means a host that refuses cross-origin
reads cannot be worked around; download the file in that case.

## The editor

The viewer fills the editor tab. There is no sidebar and no tool palette by
default — everything is either in the status bar, in the right-click menu, or in
a panel you open explicitly. Nothing overlays your image until you ask for it.

| Where | What you get |
| --- | --- |
| Status bar (bottom) | Size, pixel position, zoom, normalization range, gamma, brightness, histogram toggle, layers toggle, file size |
| Right-click in the image | The full command menu for the current image |
| Command Palette | Every command, prefixed **Scientific Image Visualizer:** |
| Panels | Histogram, Metadata, Measure, Debayer, Layers — each opened by command or status bar click |

Most status bar entries are clickable. Clicking the zoom entry resets zoom;
clicking the normalization entry prompts for a range; clicking gamma or
brightness prompts for values.

## Moving around

| Action | Input |
| --- | --- |
| Zoom | Mouse wheel, trackpad pinch, or **Zoom In** / **Zoom Out** |
| Reset zoom to fit | Click the zoom status bar entry, or **Reset Zoom** |
| Pan | Click and drag |
| Inspect a pixel | Hover — the value appears in the status bar |

Zoom is centred on the cursor, and past a certain zoom level the viewer switches
to nearest-neighbour sampling so individual pixels stay crisp and countable
rather than being blurred by interpolation.

## Keyboard shortcuts

These are active when a Scientific Image Visualizer tab has focus:

| Shortcut | Action |
| --- | --- |
| `Ctrl`/`Cmd` + `H` | Toggle histogram |
| `Ctrl`/`Cmd` + `M` | Toggle metadata panel |
| `Ctrl`/`Cmd` + `Shift` + `M` | Toggle measure panel |
| `Ctrl`/`Cmd` + `Shift` + `I` | Copy image information to clipboard |
| `←` / `→` | Step through the dataset, collection, or TIFF pages (see below) |
| `[` / `]` or `PageUp` / `PageDown` | Previous / next page of a multi-page TIFF, or CZI channel |

The arrow keys pick one target, in this order: the primary dimension of a
[multi-dimensional dataset](./datasets.md) if one is loaded, otherwise the
[collection](./collections.md) if it holds more than one image, otherwise the
Z planes of a [CZI](./formats.md) stack, otherwise the pages of a multi-page
TIFF. They are ignored while you are typing in a panel
field.

Inside the [measure panel](./measure.md) single letters select tools: `V`
select, `R` rect, `E` ellipse, `P` polygon, `F` freehand, `L` line, `N` points,
`W` wand, `B` brush.

## A first pass on a float image

If you open a 32-bit float TIFF or an EXR and see a black or white rectangle,
nothing is wrong — the data simply does not live in 0–1. Do this:

1. Press `Ctrl`/`Cmd` + `H` to show the histogram and see where the values are.
2. Click the normalization entry in the status bar and enter a range that covers
   them, or use auto-normalization to fit the actual min/max.
3. If the image is linear-light (rendered output, HDR capture), set gamma to
   2.2 out so it looks the way it would on a display.

[Normalization, gamma and brightness](./rendering.md) explains what each control
actually does to the numbers.

## Where settings live

Settings persist for the lifetime of the VS Code window and apply to every image
you open in it. They are not written to your workspace or user settings, and
they reset when the window closes. Per-format defaults mean a float TIFF and a
uint8 PNG start from sensible but different places.

The one real VS Code setting is `tiffVisualizer.gpuAcceleration` (default on).
See [troubleshooting](./troubleshooting.md) for when to turn it off.
