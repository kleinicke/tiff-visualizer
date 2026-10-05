# Decoder paths and fallbacks

A fallback needs an identifiable supported case. A different implementation is
not automatically redundant, and a failed decode is not automatically evidence
that retrying another decoder will help.

## Retained paths

| Path | Reason to retain | Verification |
| --- | --- | --- |
| Core → heavy-codec WASM | Optional JPEG 2000/JPEG XR/LERC/LZMA/WebP and DICOM codecs; same container parsers | Codec and scientific format fixtures; only an external-codec marker triggers loading |
| Core → JXL WASM | Standalone and embedded JPEG XL without increasing the common module | JXL/TIFF/DICOM fixtures |
| Worker → local decoder | Hosts can reject worker startup or lack worker capability | Main-thread WASM wiring and worker tests |
| TIFF → geotiff.js | HTTP-range COG source plus remaining unsupported layouts | Remote COG/range tests and TIFF layout matrix |
| EXR → parse-exr | Compatibility path for files rejected by the Rust implementation | Format/EXR fixtures; preserve the original failure diagnostic |
| PNG → browser/UPNG | Native display/readback and remaining specialized PNG variants | PNG bit-depth/channel fixtures and browser tests |
| GPU → CPU/WASM compositor | Unsupported devices/features and an export correctness reference | Compositor conformance and browser GPU tests |
| Narrow raw TS accelerators → Rust | Zero-copy compatible inputs; Rust handles the other encodings | Fast-raw tests and sample equality |

This table is an audit of responsibilities, not proof that every compatibility
branch remains necessary. Before removing a decoder fallback, enumerate the
fixtures that exercise it, verify equivalent source samples through the retained
path, and check remote/worker-disabled hosts. Keep range fetching separate from
codec coverage: having the same compression algorithms does not replace a remote
byte source.

Forced compositor selection is available under **Layers → Rendering diagnostics**.
Normal viewing uses automatic selection. Explicitly forced backends continue to
report unsupported features instead of silently changing implementations.

## Cache and image ownership

Processors expose `ActiveImage`: a numeric raster when resident, the pixel-read
operation, and its display convention. Layer creation and pointer inspection do
not infer the source type from a filename or search all processors for old data.
A source can expose inspection without a resident raster, as with lazy browser
readback and streamed TIFFs.

A `DecodedSnapshot` retains source buffers and restores the processor's own state.
The viewer owns cache identity, host messages, placeholders, and navigation UI.
Snapshots do not duplicate sample arrays. Dataset plane navigation bypasses the
file-switch cache so a cached plane cannot shadow the requested one.
