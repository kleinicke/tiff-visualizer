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

## Range sliders

Channel black/white points and the continuous Cells colour range use one two-handle slider (`ui/components/RangeSlider.svelte`). A histogram sits directly above the track and shares its width, so a bin lines up with the slider position for that value; bins outside the selected range are dimmed. The Log button switches the histogram's count axis between linear and log. Channel histograms are computed from a sample of up to about 200k pixels of the overview plane. Handles also respond to the arrow keys (Shift for larger steps).

## Cells

When the bundle has `cells.parquet` and `cell_boundaries.parquet` (and optionally `nucleus_boundaries.parquet`), the outlines load automatically after the image appears and a Cells section is added to the Channels window, under the same kind of header.

- **Show:** Cells (default), Nucleus, Both (cells filled by the metric, nuclei as outlines) or None.
- **Colour by:** any table column. Categories (text columns, and integer columns with eight or fewer values) get a checkbox and tint per category. Numbers get a low/high range slider over a histogram and a colormap. Outline area, perimeter, circularity and nucleus-to-cell area ratio are added from the outlines.
- **Select:** click a cell to see its columns, shift- or ctrl-click to add more (a summary is shown for several), Esc or a click on empty space clears.

Parquet is read in a worker with `hyparquet` and `fzstd`. `esbuild-hyparquet-patch.js` fixes a one-byte over-read in hyparquet's bit-packed decoder that breaks `cells.parquet`; the build fails loudly if hyparquet changes under it.

### More than one cell set

Each cell set (a segmentation with its own table) is a foldable panel in the Cells section, like a channel. A panel has a visibility checkbox, an outline-colour swatch, its name and cell count, and under it:

- **Tables and nuclei:** the files that belong to this set, each with a summary, a remove button, and an Add field with Browse… for another one. The bundle's `cells.parquet` and `nucleus_boundaries.parquet` are listed first, already loaded. A table is a `.parquet` with a `cell_id` column plus metrics (such as `segtraq_cells.parquet`); its columns appear in this set's Colour by as `name · column`. A nucleus file is a Xenium-style `nucleus_boundaries.parquet` whose cell ids match the set; a set shows one nucleus file at a time, so loading another replaces the current one (it can be loaded again from its row). The Add field reads the file's columns to tell the two apart.
- **Display:** Cells / Nucleus / Both / None, Colour by, the legend or range slider with histogram, fill opacity, and the selection's measurements. Colour by always refers to the panel it is in, and clicking a cell selects in that set only.

Below the panels, a field with Browse… adds another set from a Xenium-style `cell_boundaries.parquet` (`cell_id`, `vertex_x`, `vertex_y` in microns). Its table holds the outline area, perimeter and circularity. Typed paths may use `{sample_name}`, and relative paths start at the workspace folder.

To list files for every sample without typing, name them in `settings.json`. `{sample_name}` is the name of the folder that holds `experiment.xenium`, and relative paths start at the workspace folder containing the bundle:

```json
"tiffVisualizer.cells.cellBoundariesParquet": {
  "sam2": "sam2/{sample_name}/cell_boundaries.parquet"
},
"tiffVisualizer.cells.cellsParquet": {
  "xenium_segtraq": {
    "path": "segtraq/{sample_name}/{sample_name}.segtraq_cells.parquet",
    "parent": "Xenium cells"
  },
  "sam2_default": {
    "path": "sam2/{sample_name}/cells.parquet",
    "parent": "sam2"
  }
},
"tiffVisualizer.cells.nucleusBoundariesParquet": {
  "sam2_nuclei": {
    "path": "sam2/{sample_name}/nucleus_boundaries.parquet",
    "parent": "sam2"
  }
}
```

Each table or nucleus file names its one `parent`: `Xenium cells` (the bundle's own cells) or a name from `cellBoundariesParquet`. It is listed under that cell set only, and an entry whose parent does not exist is not shown. The bundle's own `cells.parquet` is always listed as the first table of Xenium cells.

Boundaries files are listed below the cell sets and load when you click **Load**. Table files are listed in their parent's Tables list and load into that set when you click **Load** there. A file that does not exist is shown as not found. Settings are read when the bundle opens. Files outside the workspace folders are read by the extension host and sent to the page, which is slower for large files.

### Whole-slide performance

Everything is CPU-only (Canvas2D, no WebGL), so it works on a node without a GPU.

- **Tile pyramid.** Zoomed out, cells are drawn into cached 256 px tiles (two levels per doubling of zoom, 640-tile LRU). Detail follows the cell size on screen: cells narrower than 4 px are centroid dots, everything wider is a full outline (no simplified polygons). Brightness is matched across levels: outlines thin below about 14 px so they never pile up into solid colour, and each dot carries the ink of the cell it stands for. Where cells outnumber pixels, a fixed hash of the cell id picks which survive and each survivor takes the ink of the cells it replaces, so thinning changes the speckle, not the brightness. The dot or outline choice depends only on the zoom level, so every tile in view uses the same one. Tiles are painted within an 8 ms budget per frame; missing tiles fall back to a stale, coarser or finer tile while they fill.
- **Live vector drawing** is used only when cells are at least 40 px across and at most 600 are visible.
- **Fast Parquet path.** `parquet-fast.ts` decodes plain/ZSTD pages straight into typed arrays, and boundaries are grouped by `label_id` (validated against `cell_id`). Anything unexpected falls back to the general hyparquet reader.

Synthetic benchmark in headless software Chromium, 1M cells: warm frames under 0.2 ms, tile-filling and pan frames 8-16 ms. Loading 500k cells (12M vertices) took about 2.5-8 s depending on the machine. These are not real whole-slide or HPC measurements.

### Reusing it for other overlays

`media/modules/cells/` and `ui/components/cells/` know nothing about Xenium. A viewer needs a `PolygonSet` (with a table row per polygon) and a `CellTable`, then:

1. create a `CellsLayer` and add it as an overlay on the pan/zoom canvas;
2. create a `CellsController` for the layer and table;
3. return `controller.snapshot()` from `ChannelsPanelHost.getCells` so the Cells section appears in the Channels window.

Planned: per-channel intensity inside each outline, and loaders for GeoJSON, ImageJ ROI and label masks.
