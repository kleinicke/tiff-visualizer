"""Image tools shared by stdio MCP and the REST/HTTP MCP service."""

import argparse
import base64
from contextlib import asynccontextmanager
from functools import wraps
import json
from pathlib import Path
import threading
import uuid
from .session import show
from .bridge import RendererError
from . import __version__


class SessionManager:
    def __init__(self, roots, max_sessions=8):
        self.roots = [Path(root).expanduser().resolve(strict=True) for root in roots]
        if not self.roots or any(not root.is_dir() for root in self.roots):
            raise ValueError("Provide at least one existing --root directory")
        self.sessions = {}
        self.lock = threading.RLock()
        self.max_sessions = max_sessions

    def path(self, path):
        candidate = Path(path).expanduser()
        resolved = (
            candidate if candidate.is_absolute() else self.roots[0] / candidate
        ).resolve(strict=True)
        if not any(resolved.is_relative_to(root) for root in self.roots):
            raise PermissionError("File is outside the configured roots")
        if not resolved.is_file():
            raise ValueError("Expected a file")
        return resolved

    def get(self, session_id):
        with self.lock:
            if session_id not in self.sessions:
                raise ValueError(
                    "Unknown or closed session_id; call list_image_sessions"
                )
            return self.sessions[session_id]

    def close(self):
        with self.lock:
            sessions = list(self.sessions.values())
            self.sessions.clear()
        for session in sessions:
            session.close()


def create_server(roots):
    from mcp.server import MCPServer
    from mcp_types import CallToolResult, TextContent, ImageContent, ToolAnnotations

    manager = SessionManager(roots)

    @asynccontextmanager
    async def lifespan(_server):
        try:
            yield {}
        finally:
            manager.close()

    server = MCPServer(
        "scientific-image-visualizer",
        version=__version__,
        lifespan=lifespan,
        instructions="Open image files under configured roots, then open the returned local viewer URL in a browser. Inspection and capture require that browser to stay active. Files never upload to the public website. Pixel coordinates are zero-based decoded-image coordinates; nonfinite values are strings NaN/Infinity/-Infinity. Do not retry timed-out mutations blindly.",
    )

    def tool(*, read_only=False, destructive=False):
        def decorate(fn):
            @wraps(fn)
            def run(*args, **kwargs):
                try:
                    result = fn(*args, **kwargs)
                    if isinstance(result, bytes):
                        return CallToolResult(
                            content=[
                                ImageContent(
                                    type="image",
                                    mime_type="image/png",
                                    data=base64.b64encode(result).decode(),
                                )
                            ],
                            structured_content={
                                "mimeType": "image/png",
                                "bytes": len(result),
                            },
                        )
                    return CallToolResult(
                        structured_content=result,
                        content=[TextContent(type="text", text=json.dumps(result))],
                    )
                except (ValueError, TypeError, OSError, RendererError) as error:
                    code = (
                        "renderer_timeout"
                        if isinstance(error, TimeoutError)
                        else "renderer_error"
                        if isinstance(error, RendererError)
                        else "permission_denied"
                        if isinstance(error, PermissionError)
                        else "not_found"
                        if isinstance(error, FileNotFoundError)
                        else "invalid_argument"
                    )
                    payload = {"error": {"code": code, "message": str(error)}}
                    return CallToolResult(
                        is_error=True,
                        structured_content=payload,
                        content=[TextContent(type="text", text=json.dumps(payload))],
                    )

            server.tool(
                annotations=ToolAnnotations(
                    read_only_hint=read_only,
                    destructive_hint=destructive,
                    open_world_hint=False,
                )
            )(run)
            return run

        return decorate

    @tool()
    def open_image_files(paths: list[str], open_browser: bool = False) -> dict:
        """Open 1–128 image paths under configured roots. Returns session_id and local URL; submitted does not mean decoded. Set open_browser only when explicitly desired."""
        with manager.lock:
            if len(manager.sessions) >= manager.max_sessions:
                raise ValueError("Session limit reached (8); close an unused session")
            session = show(*(manager.path(p) for p in paths), open_browser=open_browser)
            key = uuid.uuid4().hex
            manager.sessions[key] = session
        return {"session_id": key, **session.status()}

    @tool(read_only=True)
    def list_image_sessions() -> dict:
        """List active sessions and renderer connection states without waiting for rendering."""
        with manager.lock:
            return {
                "sessions": [
                    {"session_id": key, **value.status()}
                    for key, value in manager.sessions.items()
                ]
            }

    @tool(read_only=True)
    def inspect_image(session_id: str) -> dict:
        """Wait for the active renderer and return image dimensions, dtype metadata, statistics, file index and display settings."""
        return manager.get(session_id).inspect()

    @tool()
    def set_image_display(
        session_id: str,
        exposure: float | None = None,
        gamma: list[float] | None = None,
        value_range: list[float] | None = None,
        auto: bool | None = None,
        zoom: float | str | None = None,
    ) -> dict:
        """Set EV exposure (-16..16), [input, output] gamma, [min,max] range, auto-range, or zoom ('fit' or scale). Gamma/exposure, range and auto are mutually exclusive modes. Returns settings after applying."""
        return manager.get(session_id).set_display(
            exposure=exposure,
            gamma=gamma,
            value_range=value_range,
            auto=auto,
            zoom=zoom,
        )

    @tool()
    def select_image(session_id: str, index: int) -> dict:
        """Select a zero-based file index in an existing collection; wait for decoding."""
        return manager.get(session_id).select(index)

    @tool(read_only=True)
    def inspect_image_pixel(session_id: str, x: int, y: int) -> dict:
        """Read all original channel values at zero-based decoded-image (x,y), before display gamma/exposure. Nonfinite values are represented as strings."""
        return manager.get(session_id).pixel(x, y)

    @tool(read_only=True)
    def get_image_measurements(session_id: str) -> dict:
        """Get current ROI geometry, measurement rows and calibration from the viewer."""
        return manager.get(session_id).measurements()

    @tool()
    def measure_image_region(
        session_id: str,
        x: int,
        y: int,
        width: int,
        height: int,
        name: str = "API region",
    ) -> dict:
        """Add an undoable rectangle ROI in decoded-image pixels and return calibrated measurements. Rectangle must fit entirely inside the image."""
        return manager.get(session_id).measure_region(x, y, width, height, name=name)

    @tool(read_only=True)
    def capture_image(session_id: str):
        """Capture rendered image pixels as PNG image content, without UI chrome. Requires active renderer; limited to 16 megapixels and 24 MiB base64."""
        return manager.get(session_id).capture()

    @tool(destructive=True)
    def close_image_session(session_id: str) -> dict:
        """Close a session and release its local server. Unsaved viewer state is discarded; source files are untouched."""
        with manager.lock:
            session = manager.get(session_id)
            del manager.sessions[session_id]
        session.close()
        return {"closed": session_id}

    return server, manager


def main():
    parser = argparse.ArgumentParser(
        description="Scientific image tools over stdio MCP"
    )
    parser.add_argument(
        "--root",
        action="append",
        required=True,
        help="Allowed data directory; repeat for multiple roots",
    )
    args = parser.parse_args()
    server, manager = create_server(args.root)
    try:
        server.run()
    finally:
        manager.close()


if __name__ == "__main__":
    main()
