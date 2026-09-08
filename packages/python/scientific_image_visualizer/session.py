"""Private loopback file host for the same Svelte/WASM viewer shipped to IDEs."""

from __future__ import annotations
import atexit
import base64
from functools import partial
import html
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import secrets
import shutil
import tempfile
import threading
from urllib.parse import unquote, urlsplit, parse_qs
import webbrowser
from .bridge import BrowserBridge

ASSETS = Path(__file__).parent / "_assets"
MAX_REPLY = 32 * 1024 * 1024


def assets_path():
    override = os.environ.get("IMAGE_VIEWER_ASSETS")
    assets = (Path(override) if override else ASSETS).resolve()
    if not (assets / "index.html").is_file():
        raise FileNotFoundError(
            "Viewer assets missing. In a checkout run npm run build:python-viewer, then install packages/python."
        )
    return assets


class _Handler(BaseHTTPRequestHandler):
    def __init__(self, *args, session, **kwargs):
        self.session = session
        super().__init__(*args, **kwargs)

    def log_message(self, *_args):
        pass

    def route(self):
        if self.headers.get("Host") != self.session.authority:
            self.send_error(403)
            return None
        if self.headers.get("Origin") not in (None, f"http://{self.session.authority}"):
            self.send_error(403)
            return None
        path = unquote(urlsplit(self.path).path)
        prefix = f"/{self.session._token}/"
        if not path.startswith(prefix):
            self.send_error(404)
            return None
        return path[len(prefix) :] or "index.html"

    def send(self, data, content_type="application/json", status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        resource = self.route()
        if resource is None:
            return
        if resource == "agent/command":
            renderer = parse_qs(urlsplit(self.path).query).get("renderer_id", [""])[0]
            if not renderer or len(renderer) > 100:
                self.send_error(400)
                return
            self.send(json.dumps(self.session._bridge.poll(renderer)).encode())
            return
        if resource == "session.json":
            self.send(json.dumps(self.session._manifest()).encode())
            return
        if resource.startswith("files/"):
            try:
                _, revision, index = resource.split("/")
                with self.session._lock:
                    file = self.session._history[int(revision)][int(index)]
                    if int(index) < 0:
                        raise KeyError(index)
                self._file(file, "application/octet-stream")
            except (ValueError, KeyError, IndexError, FileNotFoundError):
                self.send_error(404)
            return
        file = (self.session._assets / resource).resolve()
        if not file.is_relative_to(self.session._assets) or not file.is_file():
            self.send_error(404)
            return
        self._file(file, mimetypes.guess_type(file)[0] or "application/octet-stream")

    def _file(self, file, content_type):
        with file.open("rb") as source:
            self.send_response(200)
            self.send_header(
                "Content-Type",
                "application/wasm" if file.suffix == ".wasm" else content_type,
            )
            self.send_header("Content-Length", str(os.fstat(source.fileno()).st_size))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            shutil.copyfileobj(source, self.wfile)

    def do_POST(self):
        resource = self.route()
        if resource is None:
            return
        if resource != "agent/result":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_REPLY:
                self.send_error(413)
                return
            value = json.loads(self.rfile.read(length))
            accepted = self.session._bridge.receive(value)
            self.send(json.dumps({"accepted": accepted}).encode())
        except (ValueError, UnicodeError):
            self.send_error(400)


class ViewerSession:
    """A browser-rendered image collection. Close it or use a context manager."""

    def __init__(self, files, *, temporary=None):
        self._assets = assets_path()
        self._temporaries = {1: temporary} if temporary else {}
        self._lock = threading.RLock()
        self._bridge = BrowserBridge()
        self._token = secrets.token_urlsafe(32)
        self._revision = 1
        self._history = {1: _files(files)}
        self._closed = False
        self._server = ThreadingHTTPServer(
            ("127.0.0.1", 0), partial(_Handler, session=self)
        )
        self._server.daemon_threads = True
        self.authority = f"127.0.0.1:{self._server.server_port}"
        self.url = f"http://{self.authority}/{self._token}/?host=python"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        atexit.register(self.close)

    def _manifest(self):
        with self._lock:
            return {
                "revision": self._revision,
                "files": [
                    {"name": p.name, "url": f"files/{self._revision}/{i}"}
                    for i, p in enumerate(self._history[self._revision])
                ],
            }

    def status(self):
        """Connection state without waiting for a browser."""
        return {
            "url": self.url,
            "connection": self._bridge.connection(),
            "revision": self._revision,
            "files": [p.name for p in self._history[self._revision]],
        }

    def inspect(self, *, timeout=20):
        """Decoded image metadata, display settings and statistics."""
        return self._bridge.request("inspect", timeout=timeout)

    def set_display(
        self,
        *,
        exposure=None,
        gamma=None,
        value_range=None,
        auto=None,
        zoom=None,
        timeout=20,
    ):
        """Set exposure in EV, (input, output) gamma, range, auto-range or zoom."""
        from .validation import display_options

        options = display_options(
            exposure=exposure,
            gamma=gamma,
            value_range=value_range,
            auto=auto,
            zoom=zoom,
        )
        return self._bridge.request("display", options, timeout)

    def pixel(self, x, y, *, timeout=20):
        from .validation import pixel_coordinates

        return self._bridge.request("pixel", pixel_coordinates(x, y), timeout)

    def measurements(self, *, timeout=20):
        """Current ROI definitions and measurements, including calibration."""
        return self._bridge.request("measurements", timeout=timeout)

    def measure_region(self, x, y, width, height, *, name="API region", timeout=20):
        """Add an undoable rectangular ROI and return its calibrated measurements."""
        from .validation import pixel_coordinates

        args = pixel_coordinates(x, y)
        if any(
            isinstance(v, bool) or not isinstance(v, int) or v < 1
            for v in (width, height)
        ):
            raise ValueError("width and height must be positive integers")
        if not isinstance(name, str) or not 1 <= len(name) <= 200:
            raise ValueError("name must contain 1–200 characters")
        return self._bridge.request(
            "region", {**args, "width": width, "height": height, "name": name}, timeout
        )

    def capture(self, path=None, *, timeout=20):
        """Return PNG bytes of rendered image pixels (not UI chrome). Never overwrite."""
        result = self._bridge.request("capture", timeout=timeout)
        png = base64.b64decode(result["png"], validate=True)
        if not png.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("Renderer returned an invalid PNG")
        if path is not None:
            with Path(path).open("xb") as output:
                output.write(png)
        return png

    def select(self, index, *, timeout=20):
        if (
            isinstance(index, bool)
            or not isinstance(index, int)
            or not 0 <= index < len(self._history[self._revision])
        ):
            raise ValueError("index must be a zero-based index within this session")
        return self._bridge.request("select", {"index": index}, timeout)

    def update(self, *sources):
        """Replace the collection; submitted immediately, inspect waits for rendering."""
        files, temporary = _prepare_sources(sources)
        with self._lock:
            if self._closed:
                if temporary:
                    temporary.cleanup()
                raise RuntimeError("Session is closed")
            self._revision += 1
            self._history[self._revision] = files
            if temporary:
                self._temporaries[self._revision] = temporary
            # Retain a few revisions for requests already in flight.
            for revision in list(self._history)[:-4]:
                del self._history[revision]
                old = self._temporaries.pop(revision, None)
                if old:
                    old.cleanup()
        return self.status()

    def open_browser(self):
        if self._closed:
            raise RuntimeError("Session is closed")
        webbrowser.open(self.url)
        return self

    def _repr_html_(self):
        return f'<iframe src="{html.escape(self.url, quote=True)}" width="100%" height="520" style="border:0" title="Scientific Image Visualizer"></iframe>'

    def display(self):
        from IPython.display import HTML, display

        display(HTML(self._repr_html_()))
        return self

    def close(self):
        with self._lock:
            if self._closed:
                return
            self._closed = True
        self._bridge.close()
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=2)
        for temporary in self._temporaries.values():
            temporary.cleanup()
        self._temporaries.clear()
        atexit.unregister(self.close)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


def _files(sources):
    if not sources:
        raise ValueError("Provide at least one image path")
    files = tuple(Path(p).expanduser().resolve(strict=True) for p in sources)
    if len(files) > 128 or any(not p.is_file() or p.stat().st_size == 0 for p in files):
        raise ValueError("Provide 1–128 nonempty image files")
    return files


def _prepare_sources(sources):
    if len(sources) == 1 and hasattr(sources[0], "shape"):
        import numpy as np

        array = np.asarray(sources[0])
        if (
            array.ndim not in (2, 3)
            or not array.size
            or array.dtype.kind not in "uif"
            or array.dtype.itemsize not in (1, 2, 4, 8)
            or (array.ndim == 3 and array.shape[2] not in (1, 2, 3, 4))
        ):
            raise ValueError(
                "Expected a nonempty numeric H×W or H×W×C array, with 1–4 channels"
            )
        temporary = tempfile.TemporaryDirectory(prefix="image-viewer-")
        try:
            path = Path(temporary.name) / "array.npy"
            np.save(path, array, allow_pickle=False)
            return (path,), temporary
        except BaseException:
            temporary.cleanup()
            raise
    return _files(sources), None


def show(*sources, open_browser=True, inline=False):
    """Open paths, or one NumPy H×W / H×W×C numeric array, locally."""
    files, temporary = _prepare_sources(sources)
    try:
        session = ViewerSession(files, temporary=temporary)
        if inline:
            session.display()
        elif open_browser:
            session.open_browser()
        return session
    except BaseException:
        if "session" in locals():
            session.close()
        elif temporary:
            temporary.cleanup()
        raise
