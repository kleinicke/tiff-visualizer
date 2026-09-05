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
Scalar tiles can use the existing GPU renderer. Colormaps and unsupported GPU
settings keep the existing CPU rendering path to preserve display behavior.
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
