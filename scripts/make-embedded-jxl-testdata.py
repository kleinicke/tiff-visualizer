#!/usr/bin/env -S uv run --quiet --with numpy --with tifffile --with imagecodecs --with pydicom --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "tifffile", "imagecodecs", "pydicom"]
# ///
"""Regenerate lossless JPEG XL embedded in TIFF and DICOM fixtures."""

from __future__ import annotations

from pathlib import Path

import imagecodecs
import numpy as np
import pydicom
import tifffile
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.encaps import encapsulate
from pydicom.uid import UID

WIDTH, HEIGHT = 64, 48


def pattern() -> np.ndarray:
    xs = np.arange(WIDTH, dtype=np.float64)[None, :]
    ys = np.arange(HEIGHT, dtype=np.float64)[:, None]
    return (np.sin(xs / 5.0) * np.cos(ys / 4.0) + 1.0) / 2.0


def main() -> None:
    root = Path(__file__).parent.parent / "test-samples"
    root.mkdir(parents=True, exist_ok=True)
    scientific = root / "scientific"
    scientific.mkdir(parents=True, exist_ok=True)

    u16 = (pattern() * 65535).astype(np.uint16)
    tifffile.imwrite(root / "jxl_u16.tif", u16, compression="JPEGXL")

    # Same 12-bit values as synthetic-ct-codec-ref.dcm. The JPEG XL stream is
    # a 16-bit lossless carrier; DICOM BitsStored masks it back to 12 bits.
    u12 = (pattern() * 4095).astype(np.uint16)
    syntax = UID("1.2.840.10008.1.2.4.110")
    ds = Dataset()
    ds.preamble = b"\0" * 128
    ds.file_meta = FileMetaDataset()
    ds.file_meta.MediaStorageSOPClassUID = UID("1.2.840.10008.5.1.4.1.1.7")
    ds.file_meta.MediaStorageSOPInstanceUID = UID("1.2.826.0.1.3680043.10.543.110")
    ds.file_meta.TransferSyntaxUID = syntax
    ds.SOPClassUID = ds.file_meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = ds.file_meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID = UID("1.2.826.0.1.3680043.10.543.1")
    ds.SeriesInstanceUID = UID("1.2.826.0.1.3680043.10.543.2")
    ds.Modality = "OT"
    ds.PatientName = "SYNTHETIC^TEST"
    ds.PatientID = "SYNTHETIC"
    ds.Rows, ds.Columns = HEIGHT, WIDTH
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = 16
    ds.BitsStored = 12
    ds.HighBit = 11
    ds.PixelRepresentation = 0
    encoded = imagecodecs.jpegxl_encode(u12, lossless=True)
    assert np.array_equal(imagecodecs.jpegxl_decode(encoded).squeeze(), u12)
    ds.PixelData = encapsulate([encoded])
    ds["PixelData"].is_undefined_length = True
    pydicom.dcmwrite(
        scientific / "synthetic-ct-jpegxl.dcm",
        ds,
        implicit_vr=False,
        little_endian=True,
        force_encoding=True,
    )

    print("jxl_u16.tif and synthetic-ct-jpegxl.dcm written losslessly")


if __name__ == "__main__":
    main()
