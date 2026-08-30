#!/usr/bin/env -S uv run --quiet --with numpy --with imagecodecs --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "imagecodecs"]
# ///
"""Regenerate the standalone JPEG XL fixtures in test-samples/.

Every file is LOSSLESS, and all of them hold the same pattern at a different
sample type. That is the point: the JavaScript decoder these replace handed
back 8-bit RGBA no matter what went in, so a fixture set that was 8-bit only
could not have caught the precision loss. `gray16` and `f32` are the two that
fail against an 8-bit decoder and pass against this one.

The reference is the generator's own formula (see `pattern` in
test/format-decode-test.js), not another decode — losslessness is what makes
that possible, and it is a stronger check than a snapshot.

Usage:
    scripts/make-jxl-testdata.py [OUTPUT_DIR]

Defaults to ../test-samples relative to this script.
"""

from __future__ import annotations

import sys
from pathlib import Path

import imagecodecs
import numpy as np

WIDTH, HEIGHT = 64, 48


def sample_image() -> np.ndarray:
    xs = np.arange(WIDTH, dtype=np.float64)[None, :]
    ys = np.arange(HEIGHT, dtype=np.float64)[:, None]
    return (np.sin(xs / 5.0) * np.cos(ys / 4.0) + 1.0) / 2.0


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent.parent / "test-samples"
    out.mkdir(parents=True, exist_ok=True)

    base = sample_image()
    u8 = (base * 255).astype(np.uint8)
    u16 = (base * 65535).astype(np.uint16)
    f32 = base.astype(np.float32)
    rgb8 = np.stack([u8, 255 - u8, u8 // 2], -1)
    # A constant alpha below 255 is deliberate: an alpha channel that is fully
    # opaque is indistinguishable from one the decoder invented.
    rgba8 = np.stack([u8, 255 - u8, u8 // 2, np.full_like(u8, 200)], -1)

    for name, data in [
        ("standalone_gray8.jxl", u8),
        ("standalone_rgb8.jxl", rgb8),
        ("standalone_rgba8.jxl", rgba8),
        ("standalone_gray16.jxl", u16),
        ("standalone_f32.jxl", f32),
    ]:
        encoded = imagecodecs.jpegxl_encode(data, lossless=True)
        (out / name).write_bytes(encoded)
        decoded = imagecodecs.jpegxl_decode(encoded).squeeze()
        assert np.array_equal(decoded, data), f"{name} does not round-trip losslessly"
        print(f"{name:32} {len(encoded):>7} bytes  {data.dtype}")

    print("all fixtures round-trip losslessly through libjxl")


if __name__ == "__main__":
    main()
