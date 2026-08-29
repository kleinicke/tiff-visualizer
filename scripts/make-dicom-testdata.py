#!/usr/bin/env -S uv run --quiet --with numpy --with pydicom --with imagecodecs --with pylibjpeg --with pylibjpeg-openjpeg --with pyjpegls --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "pydicom", "imagecodecs", "pylibjpeg", "pylibjpeg-openjpeg", "pyjpegls"]
# ///
"""Regenerate the compressed-DICOM fixtures in test-samples/scientific/.

The uncompressed fixtures next to these are written by
`scripts/generate-scientific-test-images.js`, which hand-assembles DICOM
elements in Node. That approach stops at the first compressed transfer syntax,
because writing one means running an actual encoder — hence this script.

Every file holds the SAME pixels as `synthetic-ct-codec-ref.dcm`, so the tests
can assert that each transfer syntax decodes to identical samples rather than
merely decoding to something. All of them are lossless.

The files contain no patient, study, institution or device identifiers beyond
the placeholder strings written here, and no clinical data: the image is a
generated sine pattern.

Usage:
    scripts/make-dicom-testdata.py [OUTPUT_DIR]

Defaults to ../test-samples/scientific relative to this script.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import imagecodecs
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.encaps import encapsulate
from pydicom.uid import (
    UID,
    DeflatedExplicitVRLittleEndian,
    ExplicitVRLittleEndian,
    JPEG2000Lossless,
    JPEGLosslessSV1,
    JPEGLSLossless,
    RLELossless,
    generate_uid,
)

WIDTH, HEIGHT = 64, 48
BITS_STORED = 12


def sample_image() -> np.ndarray:
    xs = np.arange(WIDTH, dtype=np.float64)[None, :]
    ys = np.arange(HEIGHT, dtype=np.float64)[:, None]
    pattern = (np.sin(xs / 5.0) * np.cos(ys / 4.0) + 1.0) / 2.0
    return (pattern * (2**BITS_STORED - 1)).astype(np.uint16)


def base_dataset(transfer_syntax: UID) -> Dataset:
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.MediaStorageSOPClassUID = UID("1.2.840.10008.5.1.4.1.1.7")
    ds.file_meta.MediaStorageSOPInstanceUID = generate_uid()
    ds.file_meta.TransferSyntaxUID = transfer_syntax
    ds.SOPClassUID = ds.file_meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = ds.file_meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID = generate_uid()
    ds.SeriesInstanceUID = generate_uid()
    ds.Modality = "OT"
    ds.PatientName = "SYNTHETIC^TEST"
    ds.PatientID = "SYNTHETIC"
    ds.Rows, ds.Columns = HEIGHT, WIDTH
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = 16
    ds.BitsStored = BITS_STORED
    ds.HighBit = BITS_STORED - 1
    ds.PixelRepresentation = 0
    return ds


def main() -> None:
    out = (
        Path(sys.argv[1])
        if len(sys.argv) > 1
        else Path(__file__).parent.parent / "test-samples" / "scientific"
    )
    out.mkdir(parents=True, exist_ok=True)
    image = sample_image()

    def save(ds: Dataset, name: str) -> None:
        path = out / name
        ds.save_as(path, enforce_file_format=True)
        print(f"{name:34} {path.stat().st_size:>7} bytes")

    # The reference every compressed file is compared against.
    ds = base_dataset(ExplicitVRLittleEndian)
    ds.PixelData = image.tobytes()
    save(ds, "synthetic-ct-codec-ref.dcm")

    # Deflated Explicit VR: the dataset after the file meta group is one raw
    # deflate stream. pydicom writes this one itself.
    ds = base_dataset(DeflatedExplicitVRLittleEndian)
    ds.PixelData = image.tobytes()
    save(ds, "synthetic-ct-deflated.dcm")

    # Encapsulated syntaxes pydicom can encode through its plugins.
    for uid, name in [
        (JPEG2000Lossless, "synthetic-ct-jpeg2000.dcm"),
        (JPEGLSLossless, "synthetic-ct-jpegls.dcm"),
        (RLELossless, "synthetic-ct-rle.dcm"),
    ]:
        ds = base_dataset(uid)
        ds.compress(uid, image)
        save(ds, name)

    # Lossless JPEG (process 14) has no pydicom encoder, so the codestream
    # comes from libjpeg-turbo through imagecodecs and is encapsulated by hand
    # — which is all pydicom's own `compress` would do with it.
    #
    # SELECTION VALUE 1 is not incidental: transfer syntax .70 mandates it, and
    # it is one of the predictors the Rust decoder reproduces exactly. The
    # second file deliberately uses predictor 6, which that decoder gets wrong,
    # to prove the reader refuses it instead of returning a corrupt image.
    ds = base_dataset(JPEGLosslessSV1)
    ds.PixelData = encapsulate(
        [imagecodecs.jpeg8_encode(image, lossless=True, predictor=1, bitspersample=BITS_STORED)]
    )
    ds["PixelData"].is_undefined_length = True
    save(ds, "synthetic-ct-jpeglossless.dcm")

    ds = base_dataset(UID("1.2.840.10008.1.2.4.57"))
    ds.PixelData = encapsulate(
        [imagecodecs.jpeg8_encode(image, lossless=True, predictor=6, bitspersample=BITS_STORED)]
    )
    ds["PixelData"].is_undefined_length = True
    save(ds, "synthetic-ct-jpeglossless-predictor6.dcm")

    # A last check that the fixtures really do agree, so a broken generator
    # cannot quietly produce a set of files that only match each other.
    reference = pydicom.dcmread(out / "synthetic-ct-codec-ref.dcm").pixel_array
    assert np.array_equal(reference, image), "reference fixture does not hold the source image"
    for name in ("synthetic-ct-jpeg2000.dcm", "synthetic-ct-jpegls.dcm", "synthetic-ct-rle.dcm"):
        decoded = pydicom.dcmread(out / name).pixel_array
        assert np.array_equal(decoded, image), f"{name} does not round-trip losslessly"
    print("all fixtures hold identical pixels")


if __name__ == "__main__":
    main()
