[← Documentation index](./index.md)

# Normalization, gamma and brightness

This page explains how a stored sample value becomes a screen pixel, and what
each control does to that chain. If an image looks black, white, washed out or
posterised, the answer is here.

## The pipeline

```
raw sample  →  normalize to 0…1  →  gamma in  →  brightness  →  gamma out  →  8-bit pixel
              (range min/max)      (decode)     (exposure)     (encode)
```

Only the last step is what you see. The raw sample is what the status bar
reports on hover, what the histogram counts, and what
[measurement](./measure.md) computes on. Changing anything on this page changes
the picture and nothing else.

## Normalization

Normalization decides which input range maps to black-to-white. There are three
modes.

**Auto-normalize** uses the actual minimum and maximum of the image data. This
guarantees you see structure, and it is the right first move on unfamiliar data.
Its downside is that it is per-image: two frames of the same scene with
different extremes get different mappings, so brightness is not comparable
between them.

**Manual range** maps a range you specify. Click the normalization entry in the
status bar or run **Set Normalization Range**, and enter min and max. This is
the mode to use whenever you are comparing images, because the mapping stays
fixed as you step through a collection.

**Gamma mode (type range)** maps the type's nominal range: 0–255 for uint8,
0–65535 for uint16, 0–1 for floats. This is the "show me what a normal viewer
would show" mode, and the default for integer formats.

For integer images there is also **RGB as 24-bit grayscale**
(`toggleRgb24Mode`), which reinterprets an RGB triple as one 24-bit integer.
Depth maps are sometimes packed this way; without it they look like colourful
noise.

## Gamma

Two separate values, and the distinction matters:

- **Gamma in** decodes the stored values into linear light. Set it to 2.2 when
  the file holds display-encoded sRGB-ish values and you want brightness
  operations to behave physically.
- **Gamma out** encodes linear values for the display. Set it to 2.2 when the
  file holds linear data (rendered output, HDR capture, radiometric
  measurements) that would otherwise look far too dark.

Run **Set Gamma** or click the gamma status bar entry. The common cases: linear
float data wants gamma out 2.2 and gamma in 1.0; already-encoded 8-bit imagery
wants both at 1.0 unless you are adjusting brightness, in which case set gamma
in 2.2 so the adjustment happens in linear space.

## Brightness

An exposure multiplier applied in linear space, in stops. `+1` doubles,
`-1` halves. Because it is applied between the two gamma steps, brightening a
correctly-configured image behaves like changing camera exposure rather than
like dragging a levels slider — highlights roll rather than clipping abruptly.

Run **Set Brightness** or click the brightness status bar entry.

## NaN and infinity

Float scientific data routinely contains `NaN` (no measurement here) and
infinities (division by zero, saturated sensor). These are never silently
treated as zero.

**Cycle No-Value Color** walks how pixels with no value are drawn — black,
fuchsia, transparent — and applies to both non-finite samples (`NaN`, infinity)
and a declared `GDAL_NODATA` sentinel, since neither is a measurement.

- **black** stays out of the way while you read the data around the holes.
- **fuchsia** makes them unmistakable: nothing in real data is this colour.
- **transparent** treats them as absent. The pixels get alpha 0, so a layer
  underneath shows through and an exported PNG carries a real hole instead of a
  coloured patch — the same convention GDAL and QGIS use for nodata. This mode
  renders on the CPU rather than the GPU, so it is slower on very large images.
Fuchsia is the diagnostic setting: it makes holes in your data unmistakable, and
it is worth toggling once on any new dataset before you trust its statistics.
Measurement excludes non-finite samples and reports how many it excluded.

## Colormaps

Nine colormaps are available: **viridis**, **plasma**, **inferno**, **magma**,
**turbo**, **jet**, **hot**, **cool** and **gray**.

**Apply Colormap (Pseudocolor)** colours a single-channel image at render time.
It is non-destructive, does not touch the data, and works inside the layers
view. Prefer viridis, plasma, inferno or magma for anything quantitative — they
are perceptually uniform, so equal steps in value look like equal steps in
colour. Jet is available because reviewers ask for it, but it invents contrast
that is not in your data.

**Decode Colormap Image to Float** runs the inverse: given an RGB image that
someone already colormapped, it recovers approximate scalar values by matching
each pixel back through the colormap. Useful for recovering data from a figure
in a paper. It is an approximation — colours that the colormap maps ambiguously,
and anything drawn on top of the image, will produce nonsense values.

**Revert to Original Image** undoes a decode or debayer and returns to the file
as stored.

## GPU acceleration

Rendering prefers WebGPU, falls back to WebGL2, then to CPU. This is automatic
and applies to ordinary images, HDR/scientific images and collections; the
layers view exposes its backend explicitly because compositing performance is
more visible there.

The setting `tiffVisualizer.gpuAcceleration` (default `true`) turns this off. Do
that if a driver produces incorrect output or is slower than the CPU path — see
[troubleshooting](./troubleshooting.md).

## Per-format defaults and session scope

Each format starts from defaults that suit it: float TIFF and EXR open in gamma
mode with a 0–1 range, integer formats open mapped to their type range. After
that, your changes stick for every image in the window until you run **Reset All
Settings to Defaults**.

That session-wide scope is deliberate. Stepping through a collection with a
fixed manual range is the only way brightness comparisons between frames mean
anything.
