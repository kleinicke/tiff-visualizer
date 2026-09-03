#!/usr/bin/env -S uv run --quiet --with numpy --with tifffile --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "tifffile"]
# ///
"""Write the Cloud-Optimized GeoTIFF fixtures.

A COG is ordinary TIFF with two properties that matter to a viewer, neither of
which shows up in a page count:

    * the same scene appears several times at halving resolutions, as extra
      IFDs marked NewSubfileType bit 0 ("reduced-resolution version of another
      image in this file"), and
    * a band count of 2 or 4 does NOT imply an alpha channel. GDAL writes
      ExtraSamples = 0 ("unspecified") for an ordinary multi-band raster;
      only 1 or 2 mean alpha.

Both were real bugs. Overviews counted as pages, so a 4-level COG opened as a
"4-page" image whose later pages were blurry duplicates; and the second band of
a 2-band raster was fed into the alpha channel, which rendered 82% of a real
file completely transparent with no error anywhere (issue #12).

The fixture mirrors the shape of the file in that report: two Int16 bands with
a nodata sentinel and a per-band scale, tiled, with an overview pyramid. It is
deliberately tiny — the classification and the band handling are what is under
test, not the codec, so it uses Deflate with a horizontal predictor rather than
pulling in an imagecodecs build for ZSTD (which `zstd_*.tif` already covers).

Usage:
    scripts/make-cog-testdata.py [OUTPUT_DIR]

Defaults to ../test-samples relative to this script.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import tifffile

GDAL_METADATA = 42112
GDAL_NODATA = 42113

NODATA = -32768
SIZE = 256
TILE = 128

# Per-band scale/offset/description, exactly as GDAL serializes them. A reader
# that ignores this shows 1234 where GDAL shows 1.234.
GDAL_METADATA_XML = (
    "<GDALMetadata>\n"
    '  <Item name="OFFSET" sample="0" role="offset">0</Item>\n'
    '  <Item name="SCALE" sample="0" role="scale">0.001</Item>\n'
    '  <Item name="DESCRIPTION" sample="0" role="description">yearly rate of change</Item>\n'
    '  <Item name="OFFSET" sample="1" role="offset">0</Item>\n'
    '  <Item name="SCALE" sample="1" role="scale">0.001</Item>\n'
    '  <Item name="DESCRIPTION" sample="1" role="description">level @ period end date</Item>\n'
    "</GDALMetadata>\n"
)


def scene(size: int) -> np.ndarray:
    """Two bands that are obviously different from each other.

    Band 1 is deliberately non-positive over most of its area: read as alpha it
    would erase the image, which is precisely the regression being pinned.
    """
    y, x = np.mgrid[0:size, 0:size]
    band0 = (2000 * np.sin(x / size * 6.0) * np.cos(y / size * 6.0)).astype(np.int16)
    band1 = (x - size // 2).astype(np.int16)

    # A block of nodata in both bands, as a real scene's edge would have.
    band0[8 : size // 4, 8 : size // 4] = NODATA
    band1[8 : size // 4, 8 : size // 4] = NODATA
    return np.stack([band0, band1], axis=-1)


def pyramid(full: np.ndarray, levels: int) -> list[np.ndarray]:
    """Decimate by 2 per level. Nearest-neighbour, so nodata stays nodata."""
    out = [full]
    for _ in range(levels):
        out.append(out[-1][::2, ::2])
    return out


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "test-samples"
    out.mkdir(parents=True, exist_ok=True)

    levels = pyramid(scene(SIZE), 2)
    name = "cog_2band_pyramid.tif"
    path = out / name
    common = dict(
        photometric="minisblack",
        planarconfig="contig",
        # "unspecified" is ExtraSamples 0: a data band, not alpha.
        extrasamples=["unspecified"],
        tile=(TILE, TILE),
        compression="deflate",
        predictor=2,
    )
    with tifffile.TiffWriter(path) as writer:
        for index, level in enumerate(levels):
            writer.write(
                level,
                subfiletype=1 if index else 0,
                extratags=[
                    (GDAL_NODATA, "s", 0, str(NODATA), True),
                ] + ([(GDAL_METADATA, "s", 0, GDAL_METADATA_XML, True)] if index == 0 else []),
                **common,
            )
    print(f"{name:32} {path.stat().st_size:>7} bytes  "
          f"{len(levels)} levels {'x'.join(str(d) for d in levels[0].shape)}")

    # A transparency mask (NewSubfileType bit 2) is a third thing again: not a
    # page, not an overview. GDAL writes one for a raster with a per-pixel
    # validity mask, and offering it as "page 2" hands the reader a 1-bit
    # image where they asked for data.
    rgb = np.zeros((SIZE, SIZE, 3), dtype=np.uint8)
    rgb[..., 0] = np.arange(SIZE, dtype=np.uint8)
    rgb[..., 1] = np.arange(SIZE, dtype=np.uint8)[:, None]
    # TIFF requires a transparency mask to be bilevel with PhotometricInterpretation
    # 4 (MASK), which is what a bool array plus photometric="mask" writes.
    mask = np.zeros((SIZE, SIZE), dtype=bool)
    mask[SIZE // 4 : 3 * SIZE // 4, SIZE // 4 : 3 * SIZE // 4] = True

    name = "cog_rgb_mask.tif"
    path = out / name
    with tifffile.TiffWriter(path) as writer:
        writer.write(rgb, photometric="rgb", compression="deflate")
        writer.write(mask, photometric="mask", compression="deflate", subfiletype=4)
    print(f"{name:32} {path.stat().st_size:>7} bytes  RGB + transparency mask")


if __name__ == "__main__":
    main()
