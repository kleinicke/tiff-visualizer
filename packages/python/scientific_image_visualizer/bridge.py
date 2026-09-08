"""One renderer, bounded serialized requests, explicit timeout and shutdown."""

import math
import threading
import time
import uuid


class RendererError(RuntimeError):
    pass


class BrowserBridge:
    def __init__(self):
        self.serial = threading.Lock()
        self.condition = threading.Condition()
        self.command = self.result = self.renderer = None
        self.last_seen = 0.0
        self.closed = False

    def request(self, operation, arguments=None, timeout=20):
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout)
            or not 0 < timeout <= 120
        ):
            raise ValueError("timeout must be finite and in (0, 120] seconds")
        deadline = time.monotonic() + timeout
        if not self.serial.acquire(timeout=timeout):
            raise TimeoutError(
                "Viewer is busy; retry after the active operation completes"
            )
        try:
            with self.condition:
                if self.closed:
                    raise RendererError("Session is closed")
                self.command = {
                    "id": uuid.uuid4().hex,
                    "operation": operation,
                    "arguments": arguments or {},
                }
                self.result = None
                try:
                    if not self.condition.wait_for(
                        lambda: self.result is not None or self.closed,
                        max(0, deadline - time.monotonic()),
                    ):
                        raise TimeoutError(
                            "No renderer response. Open session.url in a browser or display the notebook iframe and keep it active. A timed-out mutation may still finish; inspect before retrying."
                        )
                    if self.closed:
                        raise RendererError(
                            "Session closed while waiting for the renderer"
                        )
                    if "error" in self.result:
                        raise RendererError(self.result["error"])
                    return self.result["result"]
                finally:
                    self.command = self.result = None
        finally:
            self.serial.release()

    def poll(self, renderer):
        with self.condition:
            now = time.monotonic()
            if (
                self.renderer
                and renderer != self.renderer
                and now - self.last_seen < 45
            ):
                return {"busy": True, "command": None}
            self.renderer, self.last_seen = renderer, now
            return {"busy": False, "command": self.command}

    def receive(self, value):
        with self.condition:
            if (
                not isinstance(value, dict)
                or not self.command
                or self.result is not None
            ):
                return False
            if (
                value.get("id") != self.command["id"]
                or value.get("renderer_id") != self.renderer
            ):
                return False
            if "result" not in value and not isinstance(value.get("error"), str):
                return False
            self.result = value
            self.condition.notify_all()
            return True

    def connection(self):
        with self.condition:
            return (
                "closed"
                if self.closed
                else "connected"
                if time.monotonic() - self.last_seen < 45
                else "disconnected"
                if self.last_seen
                else "awaiting_renderer"
            )

    def close(self):
        with self.condition:
            self.closed = True
            self.condition.notify_all()
