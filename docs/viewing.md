[← Documentation index](./index.md)

# Viewing and inspecting

## Pixel inspection

Hover anywhere on the image. The status bar shows the pixel coordinate and the
sample value at that position — all channels for multi-channel images, at full
stored precision. This is the raw value from the file, not the value being
drawn.

**Toggle Color Picker: Show Modified Values** switches that behaviour: the
inspector then reports the value after normalization, gamma and brightness have
been applied. Use it when you are debugging the display pipeline itself, or
checking whether something is clipping. Switch back before you quote a number.

In the [layers view](./layers.md) inspection always reports the rendered
composite — there is no single source value to report, so the original/modified
switch is intentionally unavailable there.

**Copy Image Information to Clipboard** (`Ctrl`/`Cmd` + `Shift` + `I`) copies a
text summary of the current image: dimensions, format, bit depth, channels and
statistics. It is the fastest way to paste context into an issue or a message.

**Paste Position** takes a coordinate from the clipboard and moves the view to
it, which is how you get two people looking at the same pixel of the same file.

## Zoom and pan

Wheel or pinch to zoom, drag to pan, click the zoom status bar entry to fit the
image again. **Zoom In**, **Zoom Out** and **Reset Zoom** are also commands, so
they can be bound to your own keys.

Beyond a certain magnification the viewer stops interpolating and draws hard
pixel edges. Individual samples stay countable, which matters when you are
checking alignment or looking for single-pixel artefacts.

## Histogram

`Ctrl`/`Cmd` + `H`, or **Toggle Histogram**, or the status bar entry.

The histogram is a draggable overlay showing the distribution of the current
image. It is computed from raw sample values, and it updates as you change the
display settings so you can see where your normalization range sits relative to
the actual data.

- **Scale toggle** switches between linear and square-root vertical scale.
  Sqrt is the default because scientific images are usually dominated by a huge
  background peak that flattens everything else in linear scale.
- **Per-channel display** — grayscale images show one distribution, RGB images
  show three.
- **Hover a bin** to read its value range and count.

The practical use: open the histogram, see two clusters, set the normalization
range around the one you care about.

When a histogram is visible in the layers view it follows your layer edits using
a bounded sample of the composite. A hidden histogram costs nothing — no
readback and no scheduled work.

## Metadata panel

`Ctrl`/`Cmd` + `M`, or **Toggle Metadata Panel**.

Three collapsible sections:

- **File** — path, size, format label, dimensions, bit depth, channels.
- **Statistics** — min, max, mean and standard deviation of the current image.
- **Tags** — every tag found in the file, grouped as TIFF, GeoKeys, Exif and
  GPS. Tags are listed generically rather than filtered to a known list, so
  vendor-specific and unusual tags show up instead of being hidden.

The copy button in the panel header copies all metadata and statistics as JSON.

## Debayer (demosaic)

**Debayer (Demosaic CFA Image)** opens a panel for raw sensor images stored as a
colour filter array — one sample per pixel, colour determined by position.

Patterns: **RGGB**, **BGGR**, **GRBG**, **GBRG** (standard Bayer),
**RGB-IR 4×4** (OmniVision-style), **X-Trans 6×6** (Fuji), **RCCB** and **RCCC**
(automotive, with clear sites), **RGBW** (panchromatic), and **Quad Bayer 4×4**
(tetracell).

Algorithms:

| Algorithm | Behaviour |
| --- | --- |
| **Malvar-He-Cutler** | Gradient-corrected linear. Best detail. 2×2 Bayer only; other patterns fall back to bilinear. |
| **Bilinear** | Plain linear interpolation. Works for every pattern. |
| **Nearest (no interpolation)** | Copies the nearest sampled site. Invents no values — **use this if you intend to measure the result.** |

The channel view buttons show **RGB**, the individual **R**, **G**, **B**
channels, the fourth **IR/clear/white** channel where the pattern has one, and
**Raw** — the undemosaiced mosaic exactly as stored. Per-channel gains are
available for a quick white balance.

The nearest-neighbour warning is worth repeating: every interpolating demosaic
algorithm fabricates two thirds of the colour data. That is fine for looking and
wrong for measuring.

**Revert to Original Image** returns to the stored mosaic.

## Point clouds

**Open as Point Cloud** hands a depth image (TIFF, PFM or NPY) to the
[3D Point Cloud and Mesh Visualizer](https://marketplace.visualstudio.com/items?itemName=kleinicke.ply-visualizer)
extension, which must be installed separately. Depth maps are the one case where
a 2D view genuinely hides the thing you need to see.
