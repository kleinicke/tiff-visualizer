#!/usr/bin/env -S uv run --quiet --with numpy --with tifffile --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "tifffile"]
# ///
"""Generate multi-channel test images for the Channels panel.

There is no multi-channel OME-TIFF in the test corpus, and the interesting
cases for compositing are ones a real acquisition produces by accident: a dim
channel next to a bright one, a hot pixel, non-finite samples. Those are
awkward to find and trivial to synthesise, so they are synthesised here rather
than committed as binaries nobody can regenerate.

Usage:
    scripts/make-channel-testdata.py [OUTPUT_DIR]

Defaults to ../test_data/channels relative to the repository.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import tifffile

SIZE = 512


def blobs(rng: np.random.Generator, count: int, radius: float, amplitude: float) -> np.ndarray:
    """Gaussian blobs on a dark background — stand-ins for stained objects."""
    y, x = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32)
    image = np.zeros((SIZE, SIZE), dtype=np.float32)
    for _ in range(count):
        cx, cy = rng.uniform(radius, SIZE - radius, size=2)
        r = radius * rng.uniform(0.7, 1.3)
        image += amplitude * np.exp(-(((x - cx) ** 2 + (y - cy) ** 2) / (2 * r * r)))
    return image


def build_channels(rng: np.random.Generator) -> list[np.ndarray]:
    """Three channels chosen so the per-channel controls visibly matter."""
    # Nuclei: bright, plentiful, the reference channel.
    dapi = blobs(rng, 40, 16, 45000) + rng.normal(300, 60, (SIZE, SIZE))

    # Reporter: two orders of magnitude dimmer. On a shared range this channel
    # is invisible; on its own range it is perfectly clear. That contrast is the
    # single best demonstration of why ranges are per channel.
    gfp = blobs(rng, 18, 22, 600) + rng.normal(40, 12, (SIZE, SIZE))

    # Sparse punctae plus one saturated hot pixel, so "Auto" (percentile) and
    # "Full range" give visibly different results.
    rfp = blobs(rng, 60, 5, 12000) + rng.normal(120, 40, (SIZE, SIZE))
    rfp[SIZE // 3, SIZE // 3] = 65535

    return [np.clip(c, 0, 65535).astype(np.uint16) for c in (dapi, gfp, rfp)]


def ome_metadata(names: list[str], colors: list[int]) -> dict:
    """Channel names, colours and a physical pixel size for the Measure panel."""
    return {
        "axes": "CYX",
        "PhysicalSizeX": 0.325,
        "PhysicalSizeY": 0.325,
        "PhysicalSizeXUnit": "µm",
        "PhysicalSizeYUnit": "µm",
        "Channel": {"Name": names, "Color": colors},
    }


def signed_rgba(r: int, g: int, b: int) -> int:
    """OME stores Channel/@Color as a signed 32-bit RGBA integer."""
    value = (r << 24) | (g << 16) | (b << 8) | 0xFF
    return value - (1 << 32) if value >= (1 << 31) else value


def main() -> int:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else (
        Path(__file__).resolve().parent.parent.parent / "test_data" / "channels"
    )
    target.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(20260806)

    names = ["DAPI", "GFP", "RFP"]
    colors = [signed_rgba(0, 80, 255), signed_rgba(0, 255, 0), signed_rgba(255, 40, 40)]

    # 1. Channels as separate IFDs — the microscopy layout, and the path that
    #    has to decode sibling pages in the background.
    channels = build_channels(rng)
    stack = np.stack(channels)
    path = target / "three-channel.ome.tif"
    tifffile.imwrite(path, stack, photometric="minisblack",
                     metadata=ome_metadata(names, colors))
    print(f"wrote {path}  ({stack.shape}, uint16, C as pages)")

    # 2. A Z stack, to check the composite follows the current Z rather than
    #    compositing whatever was decoded first.
    z_stack = np.stack([
        np.stack([np.roll(c, shift * 12, axis=0) for c in channels])
        for shift in range(4)
    ])  # Z, C, Y, X
    path = target / "three-channel-zstack.ome.tif"
    tifffile.imwrite(path, z_stack, photometric="minisblack",
                     metadata={**ome_metadata(names, colors), "axes": "ZCYX"})
    print(f"wrote {path}  ({z_stack.shape}, uint16, Z x C)")

    # 3. Float with non-finite samples, so the NaN rules can be checked: a
    #    channel that is NaN somewhere must let the others show through, and a
    #    pixel that is NaN everywhere must take the NaN colour.
    floats = [c.astype(np.float32) / 65535.0 for c in channels]
    floats[0][40:80, 40:80] = np.nan          # NaN in one channel only
    floats[1][40:80, 40:80] = 0.5             # ...with a neighbour still valid
    for channel in floats:
        channel[200:240, 200:240] = np.nan    # NaN in every channel
    floats[2][300:310, 300:310] = np.inf
    path = target / "three-channel-float-nan.ome.tif"
    tifffile.imwrite(path, np.stack(floats), photometric="minisblack",
                     metadata=ome_metadata(names, colors))
    print(f"wrote {path}  (float32 with NaN/Inf regions)")

    # 4. Interleaved multi-sample, the other storage layout the panel handles.
    rgb = np.stack(channels, axis=-1)
    path = target / "three-channel-interleaved.tif"
    tifffile.imwrite(path, rgb, photometric="rgb")
    print(f"wrote {path}  ({rgb.shape}, uint16, interleaved)")

    # 5. Eight channels, one past the GPU limit, so the CPU fallback is
    #    reachable without special hardware.
    many = np.stack([blobs(rng, 12, 10, 20000).astype(np.uint16) for _ in range(9)])
    path = target / "nine-channel.ome.tif"
    tifffile.imwrite(path, many, photometric="minisblack",
                     metadata={"axes": "CYX"})
    print(f"wrote {path}  ({many.shape}, uint16, exceeds the 8-channel GPU limit)")

    print(f"\nOpen these from {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
