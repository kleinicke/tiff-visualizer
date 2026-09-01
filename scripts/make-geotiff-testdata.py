#!/usr/bin/env -S uv run --quiet --with numpy --with tifffile --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "tifffile"]
# ///
"""Write the GeoTIFF fixtures.

GeoTIFF is not a separate format — it is ordinary TIFF plus a handful of tags
that say where on the Earth the raster sits. Three of them carry everything:

    34735  GeoKeyDirectory     the keys themselves, as a packed SHORT array
    34736  GeoDoubleParams     values too wide for a SHORT
    34737  GeoAsciiParams      one concatenated string the keys index into

The directory is a header of four SHORTs (version, revision, minor, key count)
followed by four SHORTs per key: the key id, WHERE its value lives (0 for
"the value is right here", else 34736 or 34737), how many values, and either
the value itself or an index into the params array. That indirection is the
whole reason a raw tag dump of a GeoTIFF is unreadable — the interesting part
is a pile of integers pointing at two other tags.

Georeferencing comes from either
    33550  ModelPixelScale + 33922  ModelTiepoint   (an axis-aligned raster)
or  34264  ModelTransformation                     (a full 4x4, for rotation)
and both spellings are written here because a decoder that handles only the
first silently mislocates every rotated raster.

The UTM fixture deliberately mimics a Sentinel-2 tile: EPSG:32631, a 10 m
pixel, and a tiepoint on the 100 km grid.

Usage:
    scripts/make-geotiff-testdata.py [OUTPUT_DIR]

Defaults to ../test-samples relative to this script.
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

import numpy as np
import tifffile

# Tag ids, spelled out so the writer calls below read as the spec does.
GEO_KEY_DIRECTORY = 34735
GEO_DOUBLE_PARAMS = 34736
GEO_ASCII_PARAMS = 34737
MODEL_PIXEL_SCALE = 33550
MODEL_TIEPOINT = 33922
MODEL_TRANSFORMATION = 34264

# Key ids used below (GeoTIFF 1.1, appendix A).
GT_MODEL_TYPE = 1024
GT_RASTER_TYPE = 1025
GT_CITATION = 1026
GEOGRAPHIC_TYPE = 2048
GEOG_CITATION = 2049
GEOG_ANGULAR_UNITS = 2054
PROJECTED_CS_TYPE = 3072
PCS_CITATION = 3073
PROJ_LINEAR_UNITS = 3076


def geo_key_directory(keys, ascii_params="", double_params=()):
    """Pack `keys` into the 34735/34736/34737 triple.

    `keys` is a list of (key_id, location, count, value_offset) exactly as the
    directory stores them, so the caller stays in the spec's own vocabulary.
    """
    entries = []
    for key_id, location, count, value in keys:
        entries.extend([key_id, location, count, value])
    directory = [1, 1, 1, len(keys)] + entries
    return (
        np.array(directory, dtype=np.uint16),
        np.array(double_params, dtype=np.float64),
        ascii_params,
    )


def write(out: Path, name: str, data, extratags):
    path = out / name
    tifffile.imwrite(path, data, extratags=extratags)
    print(f"{name:32} {path.stat().st_size:>7} bytes")
    return path


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent.parent / "test-samples"
    out.mkdir(parents=True, exist_ok=True)

    width, height = 64, 48
    y, x = np.mgrid[0:height, 0:width]
    base = (np.sin(x / 5) * np.cos(y / 4) + 1) / 2
    u16 = (base * 65535).astype(np.uint16)

    # --- Projected: EPSG:32631 (WGS 84 / UTM zone 31N), a Sentinel-2 shape ---
    #
    # Tiepoint maps raster (0,0) to easting 300000, northing 5700000 — a point
    # on the 100 km grid inside zone 31N — at 10 m per pixel.
    ascii_utm = "WGS 84 / UTM zone 31N|WGS 84|"
    directory, doubles, ascii_params = geo_key_directory(
        [
            (GT_MODEL_TYPE, 0, 1, 1),        # 1 = projected 2D
            (GT_RASTER_TYPE, 0, 1, 1),       # 1 = PixelIsArea
            (GT_CITATION, GEO_ASCII_PARAMS, 21, 0),
            (PROJECTED_CS_TYPE, 0, 1, 32631),
            (PCS_CITATION, GEO_ASCII_PARAMS, 21, 0),
            (GEOGRAPHIC_TYPE, 0, 1, 4326),
            (GEOG_CITATION, GEO_ASCII_PARAMS, 6, 22),
            (PROJ_LINEAR_UNITS, 0, 1, 9001),  # 9001 = metre
        ],
        ascii_params=ascii_utm,
    )
    write(
        out, "geotiff_utm31n.tif", u16,
        extratags=[
            (GEO_KEY_DIRECTORY, "H", len(directory), directory.tolist(), True),
            (GEO_ASCII_PARAMS, "s", 0, ascii_params, True),
            (MODEL_PIXEL_SCALE, "d", 3, [10.0, 10.0, 0.0], True),
            (MODEL_TIEPOINT, "d", 6, [0.0, 0.0, 0.0, 300000.0, 5700000.0, 0.0], True),
        ],
    )

    # --- Geographic: EPSG:4326, degrees ---
    #
    # A degree-per-pixel grid anchored at 10E 50N, which is a plain lon/lat
    # raster of the kind climate and reanalysis products ship.
    ascii_wgs = "WGS 84|"
    directory, doubles, ascii_params = geo_key_directory(
        [
            (GT_MODEL_TYPE, 0, 1, 2),        # 2 = geographic 2D
            (GT_RASTER_TYPE, 0, 1, 1),
            (GEOGRAPHIC_TYPE, 0, 1, 4326),
            (GEOG_CITATION, GEO_ASCII_PARAMS, 6, 0),
            (GEOG_ANGULAR_UNITS, 0, 1, 9102),  # 9102 = degree
        ],
        ascii_params=ascii_wgs,
    )
    write(
        out, "geotiff_wgs84.tif", u16,
        extratags=[
            (GEO_KEY_DIRECTORY, "H", len(directory), directory.tolist(), True),
            (GEO_ASCII_PARAMS, "s", 0, ascii_params, True),
            (MODEL_PIXEL_SCALE, "d", 3, [0.01, 0.01, 0.0], True),
            (MODEL_TIEPOINT, "d", 6, [0.0, 0.0, 0.0, 10.0, 50.0, 0.0], True),
        ],
    )

    # --- ModelTransformation instead of scale+tiepoint ---
    #
    # The same UTM raster rotated 30 degrees. A decoder that reads only
    # 33550/33922 finds neither and reports "no georeferencing" — or worse,
    # ignores the rotation and mislocates every pixel but the origin.
    import math
    angle = math.radians(30.0)
    sx = sy = 10.0
    transform = [
        sx * math.cos(angle), -sy * math.sin(angle), 0.0, 300000.0,
        sx * math.sin(angle), sy * math.cos(angle), 0.0, 5700000.0,
        0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ]
    directory, doubles, ascii_params = geo_key_directory(
        [
            (GT_MODEL_TYPE, 0, 1, 1),
            (GT_RASTER_TYPE, 0, 1, 1),
            (PROJECTED_CS_TYPE, 0, 1, 32631),
            (PROJ_LINEAR_UNITS, 0, 1, 9001),
        ],
    )
    write(
        out, "geotiff_rotated.tif", u16,
        extratags=[
            (GEO_KEY_DIRECTORY, "H", len(directory), directory.tolist(), True),
            (MODEL_TRANSFORMATION, "d", 16, transform, True),
        ],
    )

    # --- PixelIsPoint, and a key whose value lives in GeoDoubleParams ---
    #
    # PixelIsPoint shifts the sample location by half a pixel relative to
    # PixelIsArea, which is exactly the kind of half-pixel error that survives
    # code review; DEMs are usually PixelIsPoint and imagery is PixelIsArea.
    directory, doubles, ascii_params = geo_key_directory(
        [
            (GT_MODEL_TYPE, 0, 1, 2),
            (GT_RASTER_TYPE, 0, 1, 2),        # 2 = PixelIsPoint
            (GEOGRAPHIC_TYPE, 0, 1, 4326),
            # 2057 GeogSemiMajorAxisGeoKey, a DOUBLE living in 34736.
            (2057, GEO_DOUBLE_PARAMS, 1, 0),
        ],
        double_params=[6378137.0],
    )
    write(
        out, "geotiff_pixelispoint.tif", u16,
        extratags=[
            (GEO_KEY_DIRECTORY, "H", len(directory), directory.tolist(), True),
            (GEO_DOUBLE_PARAMS, "d", len(doubles), doubles.tolist(), True),
            (MODEL_PIXEL_SCALE, "d", 3, [0.5, 0.25, 0.0], True),
            (MODEL_TIEPOINT, "d", 6, [0.0, 0.0, 0.0, -20.0, 65.0, 0.0], True),
        ],
    )


if __name__ == "__main__":
    main()
