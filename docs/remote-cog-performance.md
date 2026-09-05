# Remote COG loading

The remote reader was implemented independently; no code from the Source
Cooperative viewer was incorporated.

TIFF headers and index entries are interpreted by the Rust core. The HTTP
adapter reads the directory without eagerly downloading all tile-offset and
byte-count arrays, then fetches index entries as tiles become visible. A
metadata-only view lets the existing geotiff.js dependency continue to interpret
other tags. Original TIFF bytes and pixel decoding are unchanged.

Range requests bypass the browser HTTP cache and use a bounded 16 MiB memory
cache for directory/index chunks. Tile downloads run with up to 16 concurrent
requests, reduced for larger blocks; decompression still uses up to four workers.
Retained original sample planes support both redraws and the color picker.
Supported scalar tiles use the existing GPU renderer and are copied into the
persistent overview or retained 2D detail canvases. Colormaps use the CPU path.
Local TIFF loading and its 130 MP preview threshold are unchanged.

## Measurement, September 2026

Sample: `data.source.coop/luddaludwig/potential-agc-combustion-ssp585-v0/AGC_final.tif`
(21.4 GB, 463832 × 111320 pixels). Its smallest stored overview still contains
50.4 million pixels, spread over 203 tiles.

The directory now opens with one 16 KiB range request instead of fetching about
3.2 MB of index metadata. This is directory traffic, not total image traffic.

Real VS Code measurements opened the URL and waited for all 203 overview tiles
to commit. Each session had three opens; the first was discarded from warm
results. Wall time includes the URL-opening command and completion polling.

| Build | First session open | Two warm opens |
| --- | --- | --- |
| Before | 63.8 s | 55.8–59.2 s |
| After | 13.9 s | 7.3–10.3 s |

These are diagnostic observations, not a controlled speedup ratio: load average
was about 13 before and 9 after, above the performance-method threshold. Network
and cache state also vary. The unrelated browser viewer was not timed in this
same experiment. `[Perf]` for remote files reports initial setup; `[Refine]`
reports tile completion, so setup alone must not be presented as image load time.

## Correctness checks

- 195 region comparisons against ordinary geotiff.js reads, including planar,
  tiled, striped, BigTIFF, multiple bands, and 1/2/4/8 concurrent reads.
- Synthetic million-entry indices verify that opening does not fetch whole
  arrays; cancellation and HTTP range requirements have regression coverage.
- 80 core-supported TIFF fixtures produced identical samples with the previous
  and updated WASM builds. External-codec fixtures were excluded from that
  core-only comparison.
- Browser comparison checks every RGBA byte for a scalar GPU tile against CPU
  output, plus original picker values and CPU fallback.
- An opt-in browser test exercises the actual large remote file:
  set `TIFF_REMOTE_SAMPLE` and run the remote TIFF web spec.

Servers must support HTTP byte ranges and browser CORS access. This change
cannot make a TIFF with no useful overviews cheap to decode at a distant zoom;
the compressed source blocks still determine how much data must be fetched.

## Navigation and redraw

Range requests use a shared queue rather than fixed request lanes. A free slot
takes useful work immediately, queued cancelled requests are removed, and
index/header reads have priority. Viewport changes can start their replacement
stream before obsolete decoding finishes. Tile selection remains center-first.

The complete loaded overview stays in its own canvas, under the bounded detail
cache. Panning moves these canvases together, so already-loaded coarse pixels
remain available while new detail is fetched. The experimental viewport-sized
GPU scene was removed after a navigation regression: it stopped painting the
persistent overview, making coarse coverage depend on the new renderer. Faster
normalization changes did not justify that regression or the added texture cache.

A browser regression uses a synthetic COG with a 50 MP lowest overview, waits
for that overview, then blocks every new image request. It zooms and pans across
several positions, checks actual screenshot pixels for visible image content,
and verifies that the underlying overview remains populated throughout.

Scientific multiband TIFFs retain Single band and RGB bands views. Red, green,
and blue can each select any declared data band; original samples remain
available for picking. Band and display changes redraw from cached samples;
cache misses can still require reads. Invalid vendor ExtraSamples values keep
the legacy interpretation instead of falsely declaring a scientific band stack.

Local TIFF loading, generated intermediate resolutions, and the 130 MP preview
threshold are unchanged. Local detail uses the previous region-rendering path.
