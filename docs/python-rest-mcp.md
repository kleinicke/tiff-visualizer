# Scientific Image Visualizer — Python, REST and MCP

Inspect images with the same Svelte 5/TypeScript and Rust/WASM engine used by
TIFF Visualizer's VS Code, JetBrains and website viewers. The client follows the
PLY client's session model. It starts a private local browser viewer; it does
not remotely control an existing VS Code editor or upload data to the website.

## Install from this checkout

```sh
npm ci
npm run build:python-viewer
python -m pip install './packages/python[arrays,http,notebook]'
```

The wheel includes the viewer and WASM assets. Installed clients do not need
Node, a sibling PLY checkout, or an internet connection to render images. The
package is not yet published to PyPI. Python 3.10+ is required. Plain file
viewing has no Python runtime dependencies. NumPy, notebook, MCP and HTTP
support are optional extras.

## Python

```python
from scientific_image_visualizer import show

with show('experiment.tif', 'reference.exr') as viewer:
    print(viewer.url)
    image = viewer.inspect()           # waits for decoding in the browser
    print(image['width'], image['height'])
    print(viewer.pixel(10, 20)['values'])  # original samples, before display edits
    viewer.set_display(value_range=[0, 500])
    region = viewer.measure_region(0, 0, 20, 20, name='Background')
    print(region['rows'])
    viewer.capture('preview.png')      # PNG pixels, without panel chrome
    viewer.select(1)                   # zero-based file index
```

For notebooks or an iterative analysis loop:

```python
import numpy as np
from scientific_image_visualizer import show

viewer = show(np.arange(1200, dtype=np.float32).reshape(30, 40), inline=True)
viewer.set_display(exposure=1, gamma=[1, 2.2])
viewer.update(np.zeros((30, 40, 3), dtype=np.uint16))
print(viewer.inspect())
# Keep the session alive while using the iframe, then:
viewer.close()
```

Arrays may be H×W or H×W×C (1–4 channels), with floating-point or integer
samples. Serialization uses NPY, preserving dtype and nonfinite values, never
JSON pixel arrays or pickle. `update()` also accepts replacement file paths.
An update is submitted immediately; inspection waits for the active renderer.
At most four file revisions are retained for in-flight browser requests.

`status()` reports `awaiting_renderer`, `connected`, `disconnected`, or `closed`
without blocking. Use `open_browser=False` to get a URL without launching a
browser, then open `viewer.url` explicitly. `inline=True` needs a notebook that
allows loopback iframes. A browser running elsewhere cannot reach a kernel's
loopback URL without an appropriate local forwarding setup.

Display modes are explicit: gamma/exposure, a fixed range, or automatic range.
These modes cannot be mixed in one call. Zoom accepts `'fit'` or a scale factor.
Pixel and rectangle coordinates are zero-based **decoded-image** coordinates;
large-file previews can have different dimensions from the full source. Values
NaN, Infinity and -Infinity cross JSON as strings with those exact names.

`capture()` returns PNG bytes when no path is given. It never overwrites an
existing destination. Captures are limited to 16 megapixels and 24 MiB of base64
content. Original samples remain unchanged by display edits. Rectangle ROIs are
visible in the Measure panel and undoable through its ordinary history.

Renderer methods default to a 20-second timeout, configurable via `timeout=`
(up to 120 seconds; the browser command deadline is 15 seconds). A timeout is
not cancellation: a mutation already delivered to the viewer may still finish.
Inspect before retrying. Sessions are process-local and do not survive restart.

## REST and HTTP MCP

```sh
image-viewer-api --root /path/to/images --state-dir /path/to/private/image-api
```

The service binds only to `127.0.0.1:8766`. Repeat `--root` to grant additional
image directories. A random owner-only token file is created in the state
directory; reuse it for subsequent connections. Do not put bearer tokens in URLs.

```python
import httpx
from pathlib import Path

token = Path('/path/to/private/image-api/token').read_text().strip()
api = httpx.Client(base_url='http://127.0.0.1:8766',
                   headers={'Authorization': f'Bearer {token}'}, timeout=30)
opened = api.post('/api/v1/tools/open_image_files',
                  json={'paths': ['experiment.tif'], 'open_browser': True})
opened.raise_for_status()
session_id = opened.json()['structuredContent']['session_id']
result = api.post('/api/v1/tools/inspect_image_pixel',
                  json={'session_id': session_id, 'x': 10, 'y': 20})
result.raise_for_status()
print(result.json()['structuredContent'])
```

- `GET /api/v1/tools`: tool descriptions and argument schemas.
- `POST /api/v1/tools/{name}`: same arguments and result envelope as MCP.
- `GET /api/v1/openapi.json`: OpenAPI 3.1 generated from those tool schemas.
- `POST /api/v1/uploads/{filename}`: raw file bytes; returns an allowed `path`.
- `GET /api/v1/files?path=...`: download a file under allowed roots.
- `DELETE /api/v1/files?path=...`: delete an unused server-managed upload.
- `/mcp`: standard Streamable HTTP MCP, with the same bearer authentication.

Tool failures return HTTP 422 with `isError: true` and a structured error code;
unknown operations return 404. Successful results include `structuredContent`.
Capture results contain PNG MCP image content (`content[].data` is base64).
Uploads are bounded to 256 MiB each, 1 GiB in total, and 512 retained files.
JSON bodies are limited to 2 MiB. Close sessions before deleting their uploads.
The service permits at most eight sessions. Sources are never deleted by closing
a session. Paths are resolved against configured roots, including symlinks.
Browser-origin API requests are rejected; there is no broad CORS policy.

All clients using the token share sessions and uploads. Use a single process per
state directory. This is a local service, not a multi-tenant remote deployment.
The browser session's returned URL is a separate private loopback capability;
anyone possessing it on that machine can view and control that session.

## MCP in an agent client

Install the `mcp` extra (or `http`, which includes it), then configure:

```json
{
  "mcpServers": {
    "scientific-images": {
      "command": "image-viewer-mcp",
      "args": ["--root", "/absolute/path/to/images"]
    }
  }
}
```

Use an absolute executable path if your agent's PATH differs from your terminal.
The stdio transport reserves stdout for protocol messages.

Tools: `open_image_files`, `list_image_sessions`, `inspect_image`,
`set_image_display`, `select_image`, `inspect_image_pixel`,
`measure_image_region`, `get_image_measurements`, `capture_image`, and
`close_image_session`.

A typical agent workflow is open → open the returned local URL → inspect →
choose a range → measure a region → capture → close. Opening does not silently
launch a browser unless `open_browser=true`. Inspection needs an active browser;
this package does not launch a headless renderer or supply an inline MCP Apps
resource. MCP image results still let clients show captured previews.

REST and MCP use the same official Python SDK tool handlers, validation,
root policy and session manager. They do not duplicate image algorithms.
See the [official SDK documentation](https://py.sdk.modelcontextprotocol.io/).

## Development checks

```sh
npm run build:python-viewer
python -m unittest discover -s packages/python/tests -v
IMAGE_VIEWER_PYTHON="$(command -v python)" npx playwright test test/playwright/python-client.spec.ts
python -m build packages/python
```

Install `[arrays,http]` and Playwright Chromium before running all integration
checks. Python tests cover renderer ownership, lifecycle, root escapes,
authentication, REST schemas and the HTTP MCP handshake. The browser test checks
known NumPy samples, display/capture changes, rectangle statistics and RGB updates.
