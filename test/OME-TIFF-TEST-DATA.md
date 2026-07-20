# OME-TIFF and multi-page TIFF test data

## Already available locally

- `/Users/florian/Projects/cursor/test_data/testfiles/exampletiffs/4D-series.ome.tif`
  is the official artificial OME C1 × Z5 × T7 dataset used by
  `test/ome-tiff-test.js` when the shared test-data checkout is present.
- `test-samples/multipage_rgb_depth_mask.tif` and
  `test-samples/multipage_description_only.tif` are small three-page regression
  fixtures with mixed page metadata/sample types.
- `/Users/florian/Projects/cursor/test_data/testfiles/exampletiffs/mri.tif` is a
  useful real-world-style plain multi-page TIFF.

## Upstream OME fixtures

Use the Open Microscopy Environment's artificial developer datasets:

- Index: <https://downloads.openmicroscopy.org/images/OME-TIFF/2016-06/bioformats-artificial/>
- Documentation and expected C/Z/T sizes:
  <https://docs.openmicroscopy.org/ome-model/5.5.0/ome-tiff/data.html>

The most useful coverage set is:

- `multi-channel.ome.tif` — C axis
- `z-series.ome.tif` — Z axis
- `time-series.ome.tif` — T axis
- `4D-series.ome.tif` — Z + T
- `multi-channel-4D-series.ome.tif` — C + Z + T

These samples were artificially generated for reader testing and label every
plane with its dimensional position. Keep downloaded data out of the extension
package unless a fixture is both small enough and its redistribution terms have
been confirmed; CI can generate tiny synthetic files instead.

## Generating deterministic fixtures

For parser and navigation tests, generated files are preferable to biological
images because their exact dimensions, values, and metadata are controlled. A
plain multi-page TIFF can be generated with Python `tifffile`:

```python
import numpy as np
import tifffile

pages = np.arange(4 * 16 * 24, dtype=np.uint16).reshape(4, 16, 24)
tifffile.imwrite('multipage-u16.tif', pages, photometric='minisblack')
```

Generate OME-TIFF with `ome=True` and explicit axes metadata:

```python
data = np.arange(2 * 3 * 4 * 16 * 24, dtype=np.uint16).reshape(2, 3, 4, 16, 24)
tifffile.imwrite(
    'synthetic-czt.ome.tif',
    data,
    ome=True,
    metadata={
        'axes': 'TCZYX',
        'Channel': {'Name': ['DAPI', 'GFP', 'RFP']},
        'PhysicalSizeX': 0.108,
        'PhysicalSizeXUnit': 'µm',
        'PhysicalSizeY': 0.108,
        'PhysicalSizeYUnit': 'µm',
        'PhysicalSizeZ': 0.5,
        'PhysicalSizeZUnit': 'µm',
    },
)
```

Also retain deliberately heterogeneous plain TIFFs (different dimensions,
sample formats, compression, PageName/ImageDescription) because OME's regular
C/Z/T stacks do not cover those page-navigation edge cases.

