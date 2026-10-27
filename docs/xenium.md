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
- Only `morphology_focus` bundles are supported. Cell boundaries and transcripts are not drawn yet.

## Layout

| Piece | Location |
| --- | --- |
| Custom editor (host) | `src/xenium/xeniumEditor.ts` |
| Webview entry | `media/xenium-viewer.ts` |
| Tile worker | `media/xenium-tile-worker.ts` |
| Manifest and OME hints | `media/modules/scene/xenium-manifest.ts` |
| Pyramid geometry | `media/modules/scene/pyramid.ts` |
| Scene viewer | `media/modules/scene/scene-viewer.ts` |

`SceneViewer.addOverlay` is the extension point for the planned cell-boundary and transcript overlays.
