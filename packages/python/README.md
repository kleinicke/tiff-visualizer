# Scientific Image Visualizer

A local Python client, REST service and MCP server for the shared Svelte/WASM
image viewer. Supports scientific image files, NumPy arrays, display controls,
original pixel inspection, ROI measurements and PNG captures.

From a repository checkout:

```sh
npm run build:python-viewer
python -m pip install './packages/python[arrays,http]'
```

```python
from scientific_image_visualizer import show

with show("experiment.tif") as viewer:
    print(viewer.pixel(10, 20)["values"])
    viewer.set_display(value_range=[0, 500])
    viewer.capture("preview.png")
```

The browser must stay open while inspection commands run. Files and arrays
remain local. This opens a separate viewer, not an existing IDE editor.

See the [complete Python, REST and MCP guide](https://github.com/kleinicke/tiff-visualizer/blob/main/docs/python-rest-mcp.md)
for installation extras, notebook examples, API authentication, MCP setup,
limits and tests. In a checkout the guide is `docs/python-rest-mcp.md`.

This package is not yet published to PyPI.
