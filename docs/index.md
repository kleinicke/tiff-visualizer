# Scientific Image Visualizer — Documentation

Inspect high-bit-depth, floating-point, scientific, and standard image files
directly inside Visual Studio Code.

This is the complete documentation. It ships with the extension, so you can read
it offline: run **Scientific Image Visualizer: Show Documentation** from the
Command Palette, or right-click inside an open image and choose
**Show Documentation**.

---

## Start here

| Page | What it covers |
| --- | --- |
| [Getting started](./getting-started.md) | Opening your first image, the editor layout, the status bar, keyboard shortcuts |
| [Supported formats](./formats.md) | Every format, which sample types it carries, and format-specific behaviour |

## Working with images

| Page | What it covers |
| --- | --- |
| [Viewing and inspecting](./viewing.md) | Zoom, pan, pixel inspection, histogram, metadata, colormaps, debayering |
| [Normalization, gamma and brightness](./rendering.md) | How pixel values become screen values, and how to control that |
| [Multi-dimensional datasets](./datasets.md) | OME-TIFF C/Z/T, DICOM series, multi-page TIFF, NetCDF variables |
| [Collections and comparison](./collections.md) | Grouping related files, side-by-side comparison |

## Analysis and output

| Page | What it covers |
| --- | --- |
| [Measurement](./measure.md) | ROIs, statistics, thresholding, particle analysis, profiles, CSV/Excel export |
| [Channels](./channels.md) | Multi-channel compositing — tint, range and opacity per channel |
| [Layers view](./layers.md) | Compositing, blend modes, filters, layered documents |
| [Export and interchange](./export.md) | PNG, OpenRaster, XCF, Krita, PSD, clipboard, point clouds |

## Reference

| Page | What it covers |
| --- | --- |
| [Command reference](./commands.md) | Every command, keybinding and setting |
| [Limitations and troubleshooting](./troubleshooting.md) | Known gaps, common problems, how to report a bug |

---

## What this extension is for

Ordinary image viewers assume 8 bits per channel and a display-referred colour
pipeline. Scientific images usually break both assumptions: a depth map holds
metres, a thermal frame holds kelvin, a microscopy stack holds photon counts,
and none of those fit in 0–255. This extension keeps the *measured* values
intact end to end — inspection, statistics and measurement always read the raw
samples, never the pixels drawn on screen — while giving you enough display
controls to actually see the data.

Two consequences worth knowing up front:

- **What you see is a rendering, not the data.** The normalization range, gamma
  and brightness controls change the picture only. Hovering a pixel reports the
  stored value regardless (unless you deliberately switch the colour picker to
  show modified values).
- **Settings are session-wide by design.** Adjusting the range for one image
  keeps it for the next one you open in that window, so a folder of comparable
  images stays comparable. [Reset All Settings to Defaults](./commands.md)
  returns to per-format defaults.

## Medical-use notice

DICOM support is provided for developer, research, and scientific visualization
workflows. This extension is not a certified or cleared medical device and is
not intended for diagnosis, treatment planning, clinical decision-making, or
other clinical use. Do not rely on it as the sole means of viewing or
interpreting medical images.

## Feedback

Bug reports and feature requests belong on
[GitHub](https://github.com/kleinicke/tiff-visualizer/issues). Additional file
formats are welcome requests — several supported formats started as issues.
