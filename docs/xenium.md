# Xenium bundles

Opening an `experiment.xenium` file from a 10x Genomics Xenium output bundle opens the Xenium Viewer. It shows the `morphology_focus` scans as named, additively composited channels in the same Channels panel used for OME-TIFF.

## What it does

- Reads `experiment.xenium` for the pixel size and the `morphology_focus` folder.
- Lists the folder and treats each `chNNNN_name.ome.tif` as one channel.
- Takes channel names, suggested display ranges and default tints (nuclear, boundary, interior RNA/protein) from the OME-XML embedded in the files.
- Composites a low-resolution overview immediately, then composites full-resolution tiles for the visible region as you pan and zoom.
- Only channels that are visible (or soloed) are fetched and decoded.

Controls: wheel to zoom, drag to pan, double-click or `0` to fit, `+`/`-` and arrow keys, `c` to toggle the Channels panel.

## Current limits

- Each channel file is read whole before tiles are decoded. Ranged reads are the next step for whole-slide bundles.
- Compositing runs on the CPU.
- Xenium pyramids are stored as TIFF SubIFDs, which the Rust page classifier lists but cannot select. `media/modules/scene/tiff-subifd.ts` chains them in an in-memory copy so the existing region decoder can reach every level. The durable fix is to select SubIFD levels in the Rust parser.
- Only `morphology_focus` bundles are supported. Transcripts are not drawn yet.

## Layout

| Piece | Location |
| --- | --- |
| Custom editor (host) | `src/xenium/xeniumEditor.ts` |
| Webview entry | `media/xenium-viewer.ts` |
| Tile worker | `media/xenium-tile-worker.ts` |
| Manifest and OME hints | `media/modules/scene/xenium-manifest.ts` |
| Pyramid geometry | `media/modules/scene/pyramid.ts` |
| Scene viewer | `media/modules/scene/scene-viewer.ts` |
| Cell table, outlines, drawing, controller | `media/modules/cells/` |
| Cells section components | `ui/components/cells/` |
| Xenium cell loader and worker | `media/modules/scene/xenium-cells.ts`, `media/xenium-cells-worker.ts` |

`SceneViewer.addOverlay` is the extension point for overlays; cells use it today and transcripts are planned.

## Cells

When the bundle has `cells.parquet` and `cell_boundaries.parquet` (and optionally `nucleus_boundaries.parquet`), the outlines load automatically after the image appears and a Cells section is added to the Channels window, under the same kind of header.

- **Show:** Cells (default), Nucleus, Both (cells filled by the metric, nuclei as outlines) or None.
- **Colour by:** any table column. Categories (text columns, and integer columns with eight or fewer values) get a checkbox and tint per category. Numbers get a low/high range slider over a histogram and a colormap. Outline area, perimeter, circularity and nucleus-to-cell area ratio are added from the outlines.
- **Select:** click a cell to see its columns, shift- or ctrl-click to add more (a summary is shown for several), Esc or a click on empty space clears.

Parquet is read in a worker with `hyparquet` and `fzstd`. `esbuild-hyparquet-patch.js` fixes a one-byte over-read in hyparquet's bit-packed decoder that breaks `cells.parquet`; the build fails loudly if hyparquet changes under it.

### Whole-slide performance

Everything is CPU-only (Canvas2D, no WebGL), so it works on a node without a GPU.

- **Tile pyramid.** Zoomed out, cells are drawn into cached 256 px tiles (power-of-two levels, 640-tile LRU). Detail follows the cell size on screen: centroid dots, then simplified polygons, then full outlines. Dots are thinned when cells are denser than pixels. Tiles are painted within an 8 ms budget per frame; missing tiles fall back to a stale, parent or child tile while they fill.
- **Live vector drawing** is used only when cells are at least 40 px across and at most 600 are visible.
- **Fast Parquet path.** `parquet-fast.ts` decodes plain/ZSTD pages straight into typed arrays, and boundaries are grouped by `label_id` (validated against `cell_id`). Anything unexpected falls back to the general hyparquet reader.

Synthetic benchmark in headless software Chromium, 1M cells: warm frames under 0.2 ms, tile-filling and pan frames 8-16 ms. Loading 500k cells (12M vertices) took about 2.5-8 s depending on the machine. These are not real whole-slide or HPC measurements.

### Reusing it for other overlays

`media/modules/cells/` and `ui/components/cells/` know nothing about Xenium. A viewer needs a `PolygonSet` (with a table row per polygon) and a `CellTable`, then:

1. create a `CellsLayer` and add it as an overlay on the pan/zoom canvas;
2. create a `CellsController` for the layer and table;
3. return `controller.snapshot()` from `ChannelsPanelHost.getCells` so the Cells section appears in the Channels window.

Planned: per-channel intensity inside each outline, and loaders for GeoJSON, ImageJ ROI and label masks.
