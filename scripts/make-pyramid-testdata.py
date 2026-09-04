#!/usr/bin/env -S uv run --quiet --with numpy --with tifffile --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "tifffile"]
# ///
"""Write a gigapixel pyramid whose every level looks different.

An ordinary pyramid's overviews are downsampled copies of the full image, which
is exactly what makes them useless for watching a viewer work: every level looks
the same, so "which level am I actually seeing?" can only be answered by
believing the status bar. Here each level carries its OWN pattern — stripes,
checks, diagonals, dots — at its own scale and brightness, so the answer is
visible at a glance, and a level switch is unmistakable while it happens.

That makes this a deliberately DISHONEST image: the levels are not reductions of
each other, which no real file does. It is a diagnostic instrument, not a sample
of anything, and nothing that checks decoding correctness should use it.

The geometry mirrors `big_40000px_cog.tif` so the two are interchangeable in
timing comparisons: 40000x40000, eight levels, 512-pixel tiles, Deflate, uint8.
Levels are written tile by tile, because the full level alone is 1.6 gigapixels
and holding it would need more memory than the machine writing it should have to
spare.

Usage:
    scripts/make-pyramid-testdata.py [OUTPUT_DIR]

Defaults to ../../test_data/cog — this is far too large for the repository.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import tifffile

SIZE = 40000
LEVELS = 8
TILE = 512


def pattern(level: int, y: np.ndarray, x: np.ndarray) -> np.ndarray:
    """The pattern for `level`, evaluated at absolute pixel coordinates.

    Each is chosen to be unmistakable at a glance and to survive the viewer's
    own scaling: a period of a few pixels at the level's own resolution, and a
    distinct background brightness so even a thumbnail identifies the level.
    """
    base = 20 + level * 12

    if level == 0:
        # Full resolution: two light columns, one dark, as fine as the file goes.
        return np.where((x % 3) < 2, 245, base)
    if level == 1:
        # Horizontal, two and two.
        return np.where((y % 4) < 2, 235, base)
    if level == 2:
        # Checkerboard, eight pixels.
        return np.where(((x // 8) % 2) ^ ((y // 8) % 2) == 1, 225, base)
    if level == 3:
        # Diagonals.
        return np.where(((x + y) % 12) < 6, 215, base)
    if level == 4:
        # A grid of dots.
        return np.where(((x % 16) < 5) & ((y % 16) < 5), 205, base)
    if level == 5:
        # Anti-diagonals, wider.
        return np.where(((x - y) % 24) < 12, 195, base)
    if level == 6:
        # Coarse checkerboard.
        return np.where(((x // 32) % 2) ^ ((y // 32) % 2) == 1, 185, base)
    # Concentric squares around the centre, which also shows where the edges are.
    return np.where(((np.maximum(np.abs(x), np.abs(y)) // 20) % 2) == 1, 175, base)


def tiles(level: int, width: int, height: int):
    """Yield each tile of a level, so no level is ever materialised whole."""
    for top in range(0, height, TILE):
        rows = min(TILE, height - top)
        for left in range(0, width, TILE):
            columns = min(TILE, width - left)
            y, x = np.mgrid[top:top + rows, left:left + columns]
            if level == LEVELS - 1:
                # The concentric pattern is measured from the centre.
                y = y - height // 2
                x = x - width // 2
            tile = np.zeros((TILE, TILE), dtype=np.uint8)
            tile[:rows, :columns] = pattern(level, y, x).astype(np.uint8)
            yield tile


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else \
        Path(__file__).resolve().parent.parent.parent / "test_data" / "cog"
    out.mkdir(parents=True, exist_ok=True)
    path = out / "pyramid_levels_40000px.tif"

    with tifffile.TiffWriter(path, bigtiff=False) as writer:
        for level in range(LEVELS):
            width = SIZE >> level
            height = SIZE >> level
            writer.write(
                tiles(level, width, height),
                shape=(height, width),
                dtype=np.uint8,
                tile=(TILE, TILE),
                photometric="minisblack",
                compression="deflate",
                subfiletype=1 if level else 0,
            )
            print(f"  level {level}: {width}x{height}")

    print(f"{path.name:32} {path.stat().st_size / 1e6:>8.1f} MB  {LEVELS} levels")


if __name__ == "__main__":
    main()
