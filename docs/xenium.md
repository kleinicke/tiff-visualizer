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
- Only `morphology_focus` bundles are supported.
- Transcript positions are read per gene, one row group at a time, so memory use follows the genes you show, not the file size. Adding genes still has to decode the position columns of every row group that holds them (about 0.35 s per 500k-row group in software Chromium), so the first genes on a very large file take a while; the panel shows progress.

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
| Xenium cell and transcript loader and worker | `media/modules/scene/xenium-cells.ts`, `media/xenium-cells-worker.ts` |
| Transcripts: points by gene, colours, workspace, layer | `media/modules/transcripts/` |
| Transcripts section components | `ui/components/transcripts/` |

`SceneViewer.addOverlay` is the extension point for overlays; cells and transcripts use it.

## Range sliders

Channel black/white points and the continuous Cells colour range use one two-handle slider (`ui/components/RangeSlider.svelte`). A histogram sits directly above the track and shares its width, so a bin lines up with the slider position for that value; bins outside the selected range are dimmed. The Log button switches the histogram's count axis between linear and log. Channel histograms are computed from a sample of up to about 200k pixels of the overview plane. Handles also respond to the arrow keys (Shift for larger steps).

## Cells

When the bundle has `cells.parquet` and `cell_boundaries.parquet` (and optionally `nucleus_boundaries.parquet`), the outlines load automatically after the image appears and a Cells section is added to the Channels window, under the same kind of header.

- **Show:** Cells (default), Nucleus, Both (cells filled by the metric, nuclei as outlines) or None.
- **Colour by:** any table column. Categories (text columns, and integer columns with eight or fewer values) get a checkbox and tint per category. Numbers get a low/high range slider over a histogram and a colormap. Outline area, perimeter, circularity and nucleus-to-cell area ratio are added from the outlines.
- **Select:** click a cell to see its columns, shift- or ctrl-click to add more (a summary is shown for several), Esc or a click on empty space clears.

Parquet is read in a worker with `hyparquet` and `fzstd`. `esbuild-hyparquet-patch.js` fixes a one-byte over-read in hyparquet's bit-packed decoder that breaks `cells.parquet`; the build fails loudly if hyparquet changes under it. The cell table and boundary files are read first with the Rust/WebAssembly decoder described under Transcripts (`media/modules/cells/parquet-native.ts`): numeric and string columns come out as typed arrays, and any column it declines (nulls, other codecs, booleans) is read with hyparquet. On a synthetic 1M-cell file (13M boundary vertices) reading all boundary columns took 5.0 s with hyparquet and 0.8 s with the decoder, the vertex columns the loader needs 2.4 s and 0.17 s, and the cell table 1.3 s and 0.5 s.

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

- **Tile pyramid.** Zoomed out, cells are drawn into cached 256 px tiles (two levels per doubling of zoom, 640-tile LRU). Detail follows the cell size on screen: cells narrower than 2 px are centroid dots, 2 to 4 px are rough polygons of about six vertices, and wider ones are full outlines. Brightness is matched across levels: outlines thin below about 14 px so they never pile up into solid colour, and each dot carries the ink of the cell it stands for. Where cells outnumber pixels, a fixed hash of the cell id picks which survive and each survivor takes the ink of the cells it replaces, so thinning changes the speckle, not the brightness. The dot or outline choice depends only on the zoom level, so every tile in view uses the same one. Tiles are painted within an 8 ms budget per frame; missing tiles fall back to a stale, coarser or finer tile while they fill.
- **Live vector drawing** is used only when cells are at least 40 px across and at most 600 are visible.
- **Fast Parquet path.** `parquet-fast.ts` decodes plain/ZSTD pages straight into typed arrays, and boundaries are grouped by `label_id` (validated against `cell_id`). Anything unexpected falls back to the general hyparquet reader.

Synthetic benchmark in headless software Chromium, 1M cells: warm frames under 0.2 ms, tile-filling and pan frames 8-16 ms. Loading 500k cells (12M vertices) took about 2.5-8 s depending on the machine. These are not real whole-slide or HPC measurements.

## Transcripts

The Transcripts section sits below Cells when the bundle has a `transcripts.parquet` (columns `feature_name`, `x_location`, `y_location`, `qv`; rows with `is_gene` false, such as control probes, are dropped). Nothing is shown by default: the file can hold thousands of genes, so you add the ones you want.

- **Genes.** The transcripts file is read as soon as the viewer opens. The panel reads like Channels: **Added genes** (titled **Filtered genes** while a filter is on) with Select all, Deselect all and Remove all, then Groups, a **Filter genes** box, the gene list, and last an **Add a gene…** search (matches starting with your text come first, with the transcript count beside each name; genes in the panel (`gene_panel.json`) that have no transcripts in the file are listed too, with a 0). Each listed gene has a checkbox, a colour, a count and a remove button. The list scrolls. The bulk buttons act on the genes the filter leaves showing, by text or group.
- **Groups.** A group is a named list of genes. Its tri-state checkbox adds the group's genes to the gene list and shows them; clicking it again hides them (they stay listed). It is partly ticked when only some of its genes are shown. Each group also has:
  - a **Tint / Palette** toggle (default Tint): Tint gives the whole group one colour, for comparing groups; Palette gives each gene its own colour built around the group colour, for comparing genes within a group;
  - a **filter** button that limits the gene list to the group (several groups combine as a union, and the text filter narrows them further);
  - **Remove genes**, which takes the group's genes out of the gene list so a long group is easy to undo, and a × that takes the group out of the viewer (its genes stay listed).
- **Defining groups.** Add them in `tiffVisualizer.transcripts.groups` (`{"Epithelial": ["EPCAM", "KRT8"]}`, or `{"genes": [...], "color": "#4dabf7"}`), or in the panel with **From selected genes**, which makes a group (Group 1, Group 2, …) of the genes that are ticked (only the filtered ones while a filter is on). Double-click a group's name to rename it. A group's options (the arrow beside it) include **Copy as JSON**, which copies the `settings.json` lines that define it, and **Copy all as JSON** under the groups copies every group in the viewer. Groups from the settings are offered in the Add a group list, and edits to the settings show up in an open viewer (new groups appear in the list, changed ones update, removed ones disappear); panel-made and renamed groups are saved with the session. A gene in several groups takes the colour of the first group in the viewer.
- **Display.** Min quality (QV) hides low-quality transcripts (20 by default); Dot size (50% to 600%, 300% by default) scales the dots and Dot opacity sets how solid they are (90% by default; saved with the session; above 90% dots also get up to three times the ink, which lifts them when zoomed out). Dots are drawn at a width that follows the zoom, never under 2 px or over 7 px on screen before the Dot size multiplier.

How it is read (`media/modules/transcripts/transcript-reader.ts`, run in the cells worker): opening makes one pass over the `feature_name` (and `is_gene`) column, one row group at a time, keeping only the transcript count per gene and which row groups hold each gene; this fills the Add a gene list. Showing a gene reads `x_location`, `y_location` and `qv` of just the row groups that hold it and keeps that gene's rows, sorted by x. Several genes added together (a group) share one pass. Decoding is CPU-bound (zstd, then Parquet), so the cells worker starts up to eight copies of itself (cores minus two) and hands them row groups, both for the opening pass and for reading genes; they get their bytes through the coordinator, which relays the page's range requests. Results are used in file order. If the workers cannot start or one fails, the coordinator decodes in its own thread, a few row groups at a time. A gene's points are sorted by x with a radix sort on the float bits. Each decoded row group is kept in memory as compact typed arrays (about 11 bytes per gene row, up to 256 MB) so genes added later need no decoding at all; past that budget, row groups are decoded again on demand. The page serves the worker's byte-range requests, so the file is never read whole; a host that answers no Range requests falls back to reading the file whole, which only suits small files. A gene's points are dropped when it leaves the gene list.

A view visits only the points of the listed genes inside the visible x range; at most about 250,000 points are drawn per frame (denser views are thinned evenly).

Tested on a synthetic 12M-transcript, 24-row-group file (203 MB): opening read 13 MB in about 2.5 s, and adding the six most common genes (3.6M points) read 129 MB in about 12 s, in headless software Chromium. In Node on a similar synthetic file (221 MB, zstd, 4 cores), decoding is CPU-bound: opening took 1.3 s and the first read of the six most common genes about 5 s in one thread, against 0.6 s and 2 s with four decoder workers; each gene added afterwards took under 0.1 s instead of about 4.7 s. On a real 672 MB, 46M-transcript, 35-row-group file (Apple M4, one thread) opening took 4.2 s and the first read of six genes 15 s, almost all of it zstd and Parquet decoding. Not measured on a real whole slide.

The decoding itself is done by a small Rust/WebAssembly module (`wasm/transcripts-decoder`, shipped as `media/wasm/transcripts-wasm.wasm`, driven by `media/modules/transcripts/transcript-native.ts`). The reader gives it each column chunk's bytes; it decompresses the zstd pages with the reference C zstd, decodes the dictionary indices and plain floats straight into typed arrays and keeps only the rows of known genes, without building a JavaScript value per cell. It handles what Xenium files contain (flat columns without nulls; plain, dictionary and byte-stream-split pages; data page v1 and v2; uncompressed or zstd). For any other layout (nulls, snappy, other encodings) or if the module cannot load, that row group is read with `hyparquet` as before. It runs in the coordinator and in every pool worker. To compare, set `__tiffVisualizerNativeDecoder = false` in the webview's developer console before loading the transcripts. Measured in Node on the synthetic 12M-row, 24-row-group file (4 cores): opening 1.4 s to 0.12 s and the first gene 5.5 s to 0.46 s in one thread; with four workers 0.8 s / 2.3 s to 0.08 s / 0.2 s.

Rebuilding the module: `npm run build:wasm:transcripts` (needs a C compiler that targets wasm32 for zstd: set `CC_wasm32_unknown_unknown` to a clang, or install `zig` and the default `scripts/zig-cc-wasm32.sh` is used). `npm run build:wasm:transcripts:portable` builds without a C compiler using the pure-Rust `ruzstd`, which is about three times slower in zstd. `cargo test -p transcripts-wasm` runs the Rust tests; `test/xenium-transcripts-test.js` checks that the module returns the same points as the JavaScript reader.

### Reusing it for other overlays

`media/modules/cells/` and `ui/components/cells/` know nothing about Xenium. A viewer needs a `PolygonSet` (with a table row per polygon) and a `CellTable`, then:

1. create a `CellsLayer` and add it as an overlay on the pan/zoom canvas;
2. create a `CellsController` for the layer and table;
3. return `controller.snapshot()` from `ChannelsPanelHost.getCells` so the Cells section appears in the Channels window.

Planned: per-channel intensity inside each outline, and loaders for GeoJSON, ImageJ ROI and label masks.

## Cells on other images

The Cells section is not limited to Xenium bundles. In the image viewer, right-click
and choose **Cells…**, or run **Scientific Image Visualizer: Cells** from the command
palette, to open the Channels panel, whose last section is Cells (fold it away with
the arrow, as in the Xenium viewer). Add a Xenium-style `cell_boundaries.parquet`
(`cell_id`, `vertex_x`, `vertex_y` in microns) by path or with Browse, then Load it.
Outlines, colouring by a table column and click selection work as in the Xenium viewer.

Showing the section changes nothing: the overlay is created when the first file is added,
and each image starts without cells. Coordinates are divided by the image's pixel size,
so the image needs a micron scale (OME-TIFF, TIFF resolution tags or Measure > Set
scale); without one they are read as pixels and the panel says so.

| Setting | Effect |
| --- | --- |
| `tiffVisualizer.cells.autoOpenPanel` | `auto` (default) opens the Channels panel once per file for multichannel OME-TIFF images that have a micron scale. `always` opens it for every image, `never` leaves it to the menu and command. |
