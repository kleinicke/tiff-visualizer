#!/usr/bin/env -S uv run --quiet --with numpy --with pylibCZIrw --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "pylibCZIrw"]
# ///
"""Regenerate the compressed-CZI fixtures in test-samples/scientific/.

`scripts/generate-scientific-test-images.js` writes the uncompressed
`synthetic-stack.czi` by hand in Node, which cannot produce a compressed
subblock — that needs libCZI itself, which is what pylibCZIrw wraps.

Three compressed forms, all holding the SAME pixels as
`synthetic-czi-none.czi`:

* Zstd-0, a bare zstd frame of the tile's bytes;
* Zstd-1, which prefixes a small header;
* Zstd-1 with HiLoByteUnpack, where the encoder writes every sample's low
  byte for the whole tile and then every high byte, and the decoder has to
  interleave them back. Only that last one proves the unpacking is
  implemented — the other two decode correctly even if it is ignored.

Usage:
    scripts/make-czi-testdata.py [OUTPUT_DIR]

Defaults to ../test-samples/scientific relative to this script.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from pylibCZIrw import czi as pyczi

WIDTH, HEIGHT = 64, 48
BITS_STORED = 12


def sample_image() -> np.ndarray:
    xs = np.arange(WIDTH, dtype=np.float64)[None, :]
    ys = np.arange(HEIGHT, dtype=np.float64)[:, None]
    pattern = (np.sin(xs / 5.0) * np.cos(ys / 4.0) + 1.0) / 2.0
    return (pattern * (2**BITS_STORED - 1)).astype(np.uint16)


def main() -> None:
    out = (
        Path(sys.argv[1])
        if len(sys.argv) > 1
        else Path(__file__).parent.parent / "test-samples" / "scientific"
    )
    out.mkdir(parents=True, exist_ok=True)
    image = sample_image()

    for options, name in [
        ("uncompressed:", "synthetic-czi-none.czi"),
        ("zstd0:ExplicitLevel=1", "synthetic-czi-zstd0.czi"),
        ("zstd1:ExplicitLevel=1", "synthetic-czi-zstd1.czi"),
        ("zstd1:ExplicitLevel=1;PreProcess=HiLoByteUnpack", "synthetic-czi-zstd1-hilo.czi"),
    ]:
        path = out / name
        with pyczi.create_czi(str(path), exist_ok=True) as writer:
            writer.write(
                data=image[..., np.newaxis],
                plane={"C": 0, "Z": 0, "T": 0},
                compression_options=options,
            )
        print(f"{name:34} {path.stat().st_size:>7} bytes  ({options})")

    # libCZI ignores HiLoByteUnpack for 8-bit data, so check the 16-bit file
    # really did come out packed — otherwise the fixture proves nothing.
    packed = (out / "synthetic-czi-zstd1-hilo.czi").read_bytes()
    start = packed.find(b"ZISRAWSUBBLOCK")
    frame = packed.find(b"\x28\xb5\x2f\xfd", start)
    flags = packed[frame - 1]
    assert packed[frame - 3] == 3 and flags & 0x01, (
        "the hi-lo fixture is not actually byte-packed; libCZI may have ignored the option"
    )
    for name in ("synthetic-czi-zstd0.czi", "synthetic-czi-zstd1.czi", "synthetic-czi-zstd1-hilo.czi"):
        with pyczi.open_czi(str(out / name)) as handle:
            decoded = handle.read(plane={"C": 0, "Z": 0, "T": 0}).squeeze()
        assert np.array_equal(decoded, image), f"{name} does not round-trip losslessly"
    print("all fixtures hold identical pixels, and the hi-lo file is packed")


if __name__ == "__main__":
    main()
