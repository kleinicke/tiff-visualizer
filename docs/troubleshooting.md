[← Documentation index](./index.md)

# Limitations and troubleshooting

## Common problems

### The image is entirely black, white, or grey

Almost always a normalization issue rather than a decoding one. Press
`Ctrl`/`Cmd` + `H` to see where the values actually are, then set a
[normalization range](./rendering.md) that covers them, or switch to
auto-normalization.

Linear float data also looks far too dark until you set gamma out to 2.2.

### A multi-band GeoTIFF is mostly invisible

Fixed. A TIFF's `ExtraSamples` tag says whether a sample past the colour samples
is alpha; GDAL writes 0 ("unspecified") for an ordinary multi-band raster, and
treating that as alpha turned a 2-band Int16 COG almost entirely transparent.
The tag is now read, so a data band is drawn as data. A file that genuinely
declares alpha still gets alpha.

### The image is full of fuchsia (or black) patches

Those are non-finite samples — `NaN` or infinity. **Cycle No-Value Color**
switches how they are drawn (black, fuchsia, transparent). This is information, not a bug: something in the pipeline
that produced the file wrote a non-value there. Measurement excludes these
samples and reports how many.

### Nodata areas look like real, very dark measurements

They are drawn in the NaN colour now, because that is what they are: the
`GDAL_NODATA` sentinel marks pixels the file says hold nothing. Hovering one
reports `nodata` rather than the sentinel value, and the sentinel is excluded
from auto-normalization.

### The values disagree with GDAL, QGIS or rasterio by a constant factor

GDAL stores a per-band `SCALE` and `OFFSET` in its own metadata tag; a band with
`SCALE=0.001` stores 1234 and means 1.234. The pixel readout applies them, so it
agrees with those tools. Rendering, normalization and export stay in the file's
stored units — what is drawn is always what the file holds.

### A depth map looks like colourful noise

It is probably packed as a 24-bit integer across the RGB channels. **Toggle RGB
as 24-bit Grayscale**.

### Colours are wrong on a raw sensor image

It is a colour filter array that has not been demosaiced. Open the
[debayer panel](./viewing.md#debayer-demosaic) and pick the pattern. If you plan
to measure the result, use the **Nearest** algorithm — the interpolating
algorithms invent colour data.

### Rendering is wrong, or slower than expected

Set `tiffVisualizer.gpuAcceleration` to `false`. That forces the CPU path, which
is the correctness reference. If the output changes, you have found a GPU/driver
problem worth reporting — include your GPU and driver version.

In the [layers view](./layers.md) the backend is shown explicitly, so check
there first.

### The file opens in VS Code's built-in image viewer instead

For PNG, JPEG, BMP, ICO, WebP and AVIF that is the default. **Right-click →
Open With… → Scientific Image Visualizer**, and use **Configure default editor**
if you want it permanently.

### A TIFF fails to open

The Rust/WASM decoder covers most of the format, with a JavaScript fallback for
what it does not. If both fail, the file is either using an unusual compression
or is malformed — please open an issue with the file if you can share it.

### Measurements are in pixels instead of physical units

The file carries no usable calibration. This is deliberate in three cases: a
`ResolutionUnit` of "no absolute unit", a 1×1 resolution (what writers emit when
they have nothing to say), and unit strings that would need guessing to convert.
Set the scale by hand in the measure panel's **Scale** tab.

### Add Images to Collection says to add a layer instead

[Collections and layers are exclusive](./layers.md#layers-and-collections-are-exclusive)
within one window. That message means a layers window is active.

## Known limitations

**Formats**

- NetCDF-4 / HDF5 is not supported; classic NetCDF only
- DICOM compression other than JPEG Baseline is not supported
- No format is written back — this is a viewer. Export targets are listed in
  [export](./export.md)

**Layered documents**

- Compatible PSD adjustment layers, Krita filter masks and layers, and GIMP 3
  XCF layer effects are **approximated**, and say so via a badge
- Layer reconstruction is not complete for every feature of every editor;
  progress is tracked in the
  [backlog](https://github.com/kleinicke/tiff-visualizer/blob/main/BACKLOG.md)

**Layers view**

- Pixel inspection reports the rendered composite; there is no original/modified
  switch
- Collections cannot be used in the same window

**Comparison**

- VS Code's built-in image diff cannot be extended to TIFF/HDR rendering. Use
  **Compare Side by Side with Selected** instead

**Settings**

- Display settings do not persist across VS Code window restarts. This is by
  design, not an oversight

**Colormap decoding**

- Recovering floats from a colormapped RGB image is an approximation. Ambiguous
  colours and anything drawn on top of the image produce meaningless values

## Reporting a bug

Include:

1. The output of `Ctrl`/`Cmd` + `Shift` + `I` (**Copy Image Information**) —
   dimensions, format, bit depth, channels, statistics
2. What you expected and what you saw, ideally with a screenshot
3. Whether it changes with `tiffVisualizer.gpuAcceleration` set to `false`
4. A sample file if the file can be shared

The **TIFF Visualizer** output channel (View → Output) logs every command with
its result, which is often enough to locate the failure.

Issues: <https://github.com/kleinicke/tiff-visualizer/issues>
