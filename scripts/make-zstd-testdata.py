#!/usr/bin/env -S uv run --quiet --with numpy --with tifffile --with imagecodecs --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "tifffile", "imagecodecs"]
# ///
"""Regenerate the Zstd-compressed TIFF fixtures in test-samples/.

The interesting shapes are the ones GDAL writes for GeoTIFFs — tiled Zstd with
a horizontal or floating-point predictor, and blocks a sparse dataset never
wrote — none of which any encoder produces by accident. Each compressed file is
written next to an uncompressed twin holding the identical pixels, so
test/wasm-tiff-decode-test.js can assert an exact sample-for-sample match
instead of eyeballing a picture.

The sparse file cannot be written by tifffile: nothing in its API leaves a tile
out. It is produced by writing a normal tiled file and then patching one entry
of TileOffsets/TileByteCounts to zero, which is exactly what GDAL's
SPARSE_OK=TRUE leaves behind and what libtiff reads back as zeros.

Usage:
    scripts/make-zstd-testdata.py [OUTPUT_DIR]

Defaults to ../test-samples relative to this script.
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

import numpy as np
import tifffile

WIDTH, HEIGHT = 160, 120
SPARSE_TILE = 7  # index of the tile blanked in the sparse fixture
TILE = 32

# TIFF datatype -> struct format, for patching an offsets/counts array in place.
TAG_FORMAT = {1: "B", 3: "H", 4: "I", 16: "Q"}


def sample_image() -> np.ndarray:
    """A smooth 0..1 pattern: compressible, but with no run of equal rows."""
    xs = np.arange(WIDTH, dtype=np.float64)[None, :]
    ys = np.arange(HEIGHT, dtype=np.float64)[:, None]
    return (np.sin(xs / 9.0) * np.cos(ys / 7.0) + 1.0) / 2.0


def make_sparse(path: Path, tile_index: int) -> np.ndarray:
    """Blank one tile of a tiled file the way GDAL's SPARSE_OK does."""
    raw = bytearray(path.read_bytes())
    with tifffile.TiffFile(path) as handle:
        page = handle.pages[0]
        byteorder = handle.byteorder
        for tag_name in ("TileOffsets", "TileByteCounts"):
            tag = page.tags[tag_name]
            fmt = TAG_FORMAT[int(tag.dtype)]
            struct.pack_into(
                byteorder + fmt, raw, tag.valueoffset + tile_index * struct.calcsize(fmt), 0
            )
        tiles_across = -(-page.imagewidth // page.tilewidth)
        tile_row, tile_col = divmod(tile_index, tiles_across)
    path.write_bytes(bytes(raw))
    return np.array([tile_row * TILE, tile_col * TILE])


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent.parent / "test-samples"
    out.mkdir(parents=True, exist_ok=True)

    base = sample_image()
    u16 = (base * 65535).astype(np.uint16)
    rgb8 = np.stack(
        [base * 255, (1 - base) * 255, (base * 0.5 + 0.25) * 255], -1
    ).astype(np.uint8)
    f32 = (base * 1000.0 - 250.0).astype(np.float32)

    def write(name: str, data: np.ndarray, **kwargs) -> Path:
        path = out / name
        tifffile.imwrite(path, data, **kwargs)
        print(f"{name:34} {path.stat().st_size:>7} bytes")
        return path

    # Tiled Zstd: what a cloud-optimized GeoTIFF looks like. The 48x16 tiling
    # deliberately does not divide the image, so edge tiles are padded.
    write("zstd_tiled_u16.tif", u16, compression="zstd", tile=(TILE, TILE), predictor=2)
    write(
        "zstd_tiled_rgb8.tif", rgb8, compression="zstd", tile=(TILE, TILE),
        predictor=2, photometric="rgb",
    )
    write("zstd_tiled_f32.tif", f32, compression="zstd", tile=(TILE, TILE), predictor=3)
    write("zstd_tiled_nopred_u16.tif", u16, compression="zstd", tile=(48, 16))
    # PlanarConfiguration 2: one strip series per channel.
    write(
        "zstd_planar_rgb8.tif", rgb8.transpose(2, 0, 1), compression="zstd",
        planarconfig="separate", photometric="rgb", rowsperstrip=17,
    )

    # Uncompressed twins holding the identical pixels.
    write("zstd_ref_u16.tif", u16)
    write("zstd_ref_rgb8.tif", rgb8, photometric="rgb")
    write("zstd_ref_f32.tif", f32)

    sparse = write(
        "zstd_tiled_sparse_u16.tif", u16, compression="zstd", tile=(TILE, TILE), predictor=2
    )
    row, col = make_sparse(sparse, SPARSE_TILE)
    reference = u16.copy()
    reference[row:row + TILE, col:col + TILE] = 0
    write("zstd_tiled_sparse_ref_u16.tif", reference)
    print(f"blanked tile {SPARSE_TILE} at row {row}, column {col}")


if __name__ == "__main__":
    main()
