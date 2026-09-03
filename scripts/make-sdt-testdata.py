#!/usr/bin/env -S uv run --quiet --with numpy --with sdtfile --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "sdtfile"]
# ///
"""Regenerate small deterministic FLIM/TCSPC SDT conformance fixtures."""

from pathlib import Path

import numpy as np
import sdtfile


def main() -> None:
    out = Path(__file__).parent.parent / "test-samples" / "scientific"
    out.mkdir(parents=True, exist_ok=True)
    y, x, t = np.indices((4, 5, 8), dtype=np.uint16)
    histograms = 10 * y + 3 * x + t
    for name, compress in [("synthetic-flim.sdt", False), ("synthetic-flim-zip.sdt", True)]:
        sdtfile.sdtwrite(
            out / name,
            histograms,
            12.8e-9,
            tac_g=2,
            title="Synthetic FLIM conformance fixture",
            contents="4x5 pixels, 8 TCSPC bins",
            compress=compress,
        )
        with sdtfile.SdtFile(out / name) as decoded:
            assert np.array_equal(decoded.data[0], histograms)
    print("synthetic-flim.sdt and synthetic-flim-zip.sdt written")


if __name__ == "__main__":
    main()
