#!/usr/bin/env -S uv run --quiet --with numpy --with tifffile --with imagecodecs --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "tifffile", "imagecodecs"]
# ///
"""Regenerate the LZMA, PNG-in-TIFF, LERC, JPEG 2000 and JPEG XR fixtures.

These are the TIFF codecs the Rust decoder gained after ZSTD; none of them can
be produced by an ordinary image editor, and LERC in particular has variants
(an extra Deflate/ZSTD wrapper, a validity mask, lossy quantization) that only
show up when something writes them deliberately.

Two kinds of reference accompany the compressed files:

* an UNCOMPRESSED TWIN holding the identical pixels, for the lossless cases;
* a GROUND-TRUTH decode, written by imagecodecs (Esri's own LERC library), for
  the two cases where the pixels are not the input array — a lossy blob, whose
  reconstruction is defined by the codec, and a masked blob, whose invalid
  pixels the codec reads back as zero.

The second kind is what makes the LERC tests worth anything: matching the
input array only proves a lossless round trip, while matching Esri's decode
proves the quantization and mask handling agree with the reference decoder.

Usage:
    scripts/make-codec-testdata.py [OUTPUT_DIR]

Defaults to ../test-samples relative to this script.
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

import numpy as np
import tifffile

WIDTH, HEIGHT = 64, 48


def sample_image() -> np.ndarray:
    """A smooth 0..1 pattern, compressible but never constant along a row."""
    xs = np.arange(WIDTH, dtype=np.float64)[None, :]
    ys = np.arange(HEIGHT, dtype=np.float64)[:, None]
    return (np.sin(xs / 5.0) * np.cos(ys / 4.0) + 1.0) / 2.0


def patch_photometric(path: Path, value: int) -> None:
    """Rewrite tag 262 in place; tifffile will not write this combination."""
    raw = bytearray(path.read_bytes())
    with tifffile.TiffFile(path) as handle:
        tag = handle.pages[0].tags["PhotometricInterpretation"]
        struct.pack_into(handle.byteorder + "H", raw, tag.valueoffset, value)
    path.write_bytes(bytes(raw))


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent.parent / "test-samples"
    out.mkdir(parents=True, exist_ok=True)

    base = sample_image()
    u8 = (base * 255).astype(np.uint8)
    u16 = (base * 65535).astype(np.uint16)
    f32 = base.astype(np.float32)
    rgb8 = np.stack([u8, 255 - u8, u8 // 2], -1)
    rgb16 = np.stack([u16, 65535 - u16, u16 // 3], -1)

    def write(name: str, data: np.ndarray, **kwargs) -> Path:
        path = out / name
        tifffile.imwrite(path, data, **kwargs)
        print(f"{name:32} {path.stat().st_size:>7} bytes")
        return path

    # A fresh dict per call: tifffile hands compressionargs to the codec, and
    # the JPEG 2000 encoder adds its own key to it, which then leaks into every
    # later write that shares the object.
    def lossless() -> dict:
        return {"level": 0}

    # LZMA (34925). Each block is a standalone .xz stream.
    write("lzma_u16.tif", u16, compression="LZMA")
    write("lzma_tiled_pred2_u16.tif", u16, compression="LZMA", tile=(32, 32), predictor=2)
    write("lzma_pred3_f32.tif", f32, compression="LZMA", predictor=3)

    # PNG-in-TIFF (34933). Each block is a complete PNG stream; PNG stores
    # 16-bit samples big-endian, so rgb16 exercises the byte-order swap.
    write("png_in_tiff_u16.tif", u16, compression="PNG")
    write("png_in_tiff_rgb16.tif", rgb16, compression="PNG", photometric="rgb")

    # LERC (34887), lossless, in the shapes GDAL writes.
    write("lerc_u16.tif", u16, compression="LERC", compressionargs=lossless())
    write("lerc_f32.tif", f32, compression="LERC", compressionargs=lossless())
    write("lerc_rgb8.tif", rgb8, compression="LERC", compressionargs=lossless(), photometric="rgb")
    write("lerc_tiled_f32.tif", f32, compression="LERC", compressionargs=lossless(), tile=(32, 32))
    # LERC_DEFLATE and LERC_ZSTD: the same blob inside a second codec, named
    # by the second value of tag 50674 (LercParameters).
    write(
        "lerc_deflate_u16.tif", u16, compression="LERC",
        compressionargs={**lossless(), "compression": "deflate"},
    )
    write(
        "lerc_zstd_u16.tif", u16, compression="LERC",
        compressionargs={**lossless(), "compression": "zstd"},
    )

    # Uncompressed twins for everything above.
    write("codec_ref_u16.tif", u16)
    write("codec_ref_f32.tif", f32)
    write("codec_ref_rgb8.tif", rgb8, photometric="rgb")
    write("codec_ref_rgb16.tif", rgb16, photometric="rgb")

    # Lossy LERC: the pixels are the codec's reconstruction, not the input, so
    # the reference is imagecodecs' decode of this very file.
    lossy = write(
        "lerc_lossy_f32.tif", f32, compression="LERC", compressionargs={"level": 0.01}
    )
    write("lerc_lossy_ref_f32.tif", tifffile.imread(lossy))

    # JPEG 2000 (34712) and the codes Aperio slide scanners write (33005 RGB,
    # 33003 YCbCr). tifffile encodes all of them as the same JP2 codestream, so
    # the YCbCr case has to be built by hand below.
    write("jp2_u16.tif", u16, compression="JPEG2000", compressionargs=lossless())
    write("jp2_rgb8.tif", rgb8, compression="JPEG2000", compressionargs=lossless(), photometric="rgb")
    write("jp2_aperio_rgb8.tif", rgb8, compression=33005, compressionargs=lossless(), photometric="rgb")

    # JPEG XR (34934). The float32 encoder is lossy even at its default
    # setting, so that file's reference is imagecodecs' own decode (jxrlib)
    # rather than the input array.
    write("jxr_u16.tif", u16, compression="JPEGXR")
    write("jxr_rgb8.tif", rgb8, compression="JPEGXR", photometric="rgb")
    jxr_float = write("jxr_f32.tif", f32, compression="JPEGXR")
    write("jxr_f32_ref.tif", tifffile.imread(jxr_float))

    # An Aperio 33003 block holds YCbCr and says so through
    # PhotometricInterpretation 6. Nothing here writes that combination, so:
    # convert to YCbCr, store the planes as if they were RGB, then patch tag
    # 262 to 6 — which is the file layout a slide scanner produces. The
    # reference is the ORIGINAL RGB, so the test proves the decoder applies the
    # conversion (a round trip through 8-bit YCbCr is worth about +/-2).
    r, g, b = (rgb8[..., i].astype(np.float64) for i in range(3))
    ycbcr = np.stack([
        0.299 * r + 0.587 * g + 0.114 * b,
        128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
        128 + 0.5 * r - 0.418688 * g - 0.081312 * b,
    ], -1).round().clip(0, 255).astype(np.uint8)
    aperio = write(
        "jp2_aperio_ycbcr.tif", ycbcr, compression=33003,
        compressionargs=lossless(), photometric="rgb",
    )
    patch_photometric(aperio, 6)
    write("jp2_aperio_ycbcr_ref.tif", rgb8, photometric="rgb")

    # A PALETTE image under a codec the tiff crate does not implement: the
    # indices have to come from the block decoder before the ColorMap can
    # expand them. ZSTD stands in for the whole group here.
    indices = (np.arange(HEIGHT * WIDTH).reshape(HEIGHT, WIDTH) % 256).astype(np.uint8)
    colormap = np.zeros((3, 256), dtype=np.uint16)
    colormap[0] = np.arange(256) * 257
    colormap[1] = (255 - np.arange(256)) * 257
    colormap[2] = (np.arange(256) // 2) * 257
    palette = dict(photometric="palette", colormap=colormap)
    write("palette_zstd.tif", indices, compression="ZSTD", **palette)
    write("palette_codec_ref.tif", indices, **palette)

    # Masked LERC: pixels the blob marks invalid. Esri's decoder reads them
    # back as zero, and the reference records that.
    mask = np.ones((HEIGHT, WIDTH), dtype=bool)
    mask[10:20, 10:30] = False
    masked = write(
        "lerc_masked_f32.tif", f32, compression="LERC",
        compressionargs={**lossless(), "masks": mask},
    )
    write("lerc_masked_ref_f32.tif", tifffile.imread(masked))


if __name__ == "__main__":
    main()
