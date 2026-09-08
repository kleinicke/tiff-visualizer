import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
import tempfile
import threading
import time
import unittest
import urllib.request
import urllib.error
import json
from scientific_image_visualizer.bridge import BrowserBridge, RendererError
from scientific_image_visualizer.validation import display_options
from scientific_image_visualizer.session import show
from scientific_image_visualizer.mcp_server import SessionManager


class BridgeTests(unittest.TestCase):
    def test_reply_ownership_timeout_and_close(self):
        bridge = BrowserBridge()
        result = []
        thread = threading.Thread(
            target=lambda: result.append(bridge.request("inspect", timeout=2))
        )
        thread.start()
        deadline = time.monotonic() + 1
        while bridge.command is None and time.monotonic() < deadline:
            time.sleep(0.005)
        command = bridge.poll("first")["command"]
        self.assertTrue(bridge.poll("second")["busy"])
        self.assertFalse(
            bridge.receive(
                {"id": command["id"], "renderer_id": "second", "result": 123}
            )
        )
        self.assertTrue(
            bridge.receive({"id": command["id"], "renderer_id": "first", "result": 123})
        )
        thread.join()
        self.assertEqual(result, [123])
        self.assertFalse(
            bridge.receive({"id": command["id"], "renderer_id": "first", "result": 123})
        )
        with self.assertRaises(TimeoutError):
            bridge.request("inspect", timeout=0.01)
        self.assertIsNone(bridge.command)
        bridge.close()
        with self.assertRaises(RendererError):
            bridge.request("inspect")

    def test_display_validation_before_mutation(self):
        self.assertEqual(
            display_options(exposure=2, gamma=[1, 2.2], zoom="fit")["exposure"], 2
        )
        for args in (
            {"exposure": float("nan")},
            {"value_range": [2, 1]},
            {"gamma": [0, 1]},
            {"zoom": True},
            {"auto": "yes"},
            {"auto": True, "exposure": 1},
            {},
        ):
            with self.assertRaises(ValueError):
                display_options(**args)


class HostTests(unittest.TestCase):
    def test_private_files_and_shutdown(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "data.npy"
            path.write_bytes(b"example")
            with show(path, open_browser=False) as session:
                base = session.url.split("?")[0]
                manifest = json.load(urllib.request.urlopen(base + "session.json"))
                self.assertEqual(
                    urllib.request.urlopen(base + manifest["files"][0]["url"]).read(),
                    b"example",
                )
                for url, headers in [
                    (base + "../session.json", {}),
                    (base + "session.json", {"Origin": "https://evil.example"}),
                    (base + "session.json", {"Host": "evil.example"}),
                ]:
                    with self.assertRaises(urllib.error.HTTPError):
                        urllib.request.urlopen(
                            urllib.request.Request(url, headers=headers)
                        )
                self.assertEqual(session.status()["connection"], "awaiting_renderer")
                self.assertNotIn(
                    "analytics.", urllib.request.urlopen(base).read().decode()
                )
            self.assertEqual(session.status()["connection"], "closed")
            session.close()

    def test_assets_work_through_a_symlinked_install_path(self):
        from unittest.mock import patch
        from scientific_image_visualizer.session import assets_path

        with tempfile.TemporaryDirectory() as root:
            alias = Path(root) / "assets-link"
            alias.symlink_to(assets_path(), target_is_directory=True)
            source = Path(root) / "data.npy"
            source.write_bytes(b"example")
            with patch("scientific_image_visualizer.session.ASSETS", alias):
                with show(source, open_browser=False) as session:
                    self.assertEqual(urllib.request.urlopen(session.url).status, 200)

    def test_roots_block_traversal_and_symlinks(self):
        with (
            tempfile.TemporaryDirectory() as root,
            tempfile.TemporaryDirectory() as outside,
        ):
            secret = Path(outside) / "image.npy"
            secret.write_bytes(b"data")
            (Path(root) / "escape.npy").symlink_to(secret)
            manager = SessionManager([root])
            for name in [str(secret), "escape.npy"]:
                with self.assertRaises(PermissionError):
                    manager.path(name)


try:
    from mcp import Client, StdioServerParameters
    from starlette.testclient import TestClient
    from scientific_image_visualizer.http_api import create_http_app
except ImportError:
    TestClient = None


@unittest.skipIf(TestClient is None, "Install [http] extras for REST/MCP tests")
class ApiTests(unittest.TestCase):
    def test_rest_and_mcp_share_tools_and_state(self):
        token = "a" * 40
        with tempfile.TemporaryDirectory() as state:
            app = create_http_app(["test-samples"], token=token, state_dir=state)
            with TestClient(app, base_url="http://127.0.0.1") as client:
                self.assertEqual(client.get("/api/v1/tools").status_code, 401)
                client.headers["Authorization"] = "Bearer " + token
                self.assertEqual(
                    client.get(
                        "/api/v1/tools", headers={"Origin": "http://127.0.0.1"}
                    ).status_code,
                    403,
                )
                self.assertEqual(
                    client.get(
                        "/api/v1/tools", headers={"Host": "evil.example"}
                    ).status_code,
                    403,
                )
                tools = client.get("/api/v1/tools").json()["tools"]
                schema = client.get("/api/v1/openapi.json").json()
                self.assertEqual(len(schema["paths"]), len(tools))
                opened = client.post(
                    "/api/v1/tools/open_image_files",
                    json={"paths": ["pred_ref_rgb8.tif"]},
                )
                self.assertEqual(opened.status_code, 200, opened.text)
                key = opened.json()["structuredContent"]["session_id"]
                listed = client.post(
                    "/api/v1/tools/list_image_sessions", json={}
                ).json()
                self.assertEqual(
                    listed["structuredContent"]["sessions"][0]["session_id"], key
                )
                bad = client.post(
                    "/api/v1/tools/set_image_display",
                    json={"session_id": key, "value_range": [3, 2]},
                )
                self.assertEqual(bad.status_code, 422, bad.text)
                self.assertEqual(
                    client.post("/api/v1/tools/no_such_tool", json={}).status_code, 404
                )
                self.assertEqual(
                    client.post(
                        "/api/v1/tools/list_image_sessions",
                        content=b"x" * (2 * 1024 * 1024 + 1),
                    ).status_code,
                    413,
                )
                uploaded = client.post(
                    "/api/v1/uploads/test.npy", content=b"example"
                ).json()["path"]
                self.assertEqual(
                    client.get("/api/v1/files", params={"path": uploaded}).content,
                    b"example",
                )
                self.assertEqual(
                    client.delete(
                        "/api/v1/files", params={"path": uploaded}
                    ).status_code,
                    200,
                )
                response = client.post(
                    "/mcp",
                    headers={"Accept": "application/json, text/event-stream"},
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "protocolVersion": "2025-11-25",
                            "capabilities": {},
                            "clientInfo": {"name": "test", "version": "1"},
                        },
                    },
                )
                self.assertEqual(response.status_code, 200, response.text)
                self.assertIn("serverInfo", response.json()["result"])
                client.post(
                    "/api/v1/tools/close_image_session", json={"session_id": key}
                ).raise_for_status()


@unittest.skipIf(TestClient is None, "Install MCP extras for stdio checks")
class StdioTests(unittest.IsolatedAsyncioTestCase):
    async def test_stdio_discovery_and_validation(self):
        import os

        params = StdioServerParameters(
            command=sys.executable,
            args=[
                "-m",
                "scientific_image_visualizer.mcp_server",
                "--root",
                "test-samples",
            ],
            env={**os.environ, "PYTHONPATH": str(Path(__file__).parents[1])},
        )
        async with Client(params) as client:
            tools = await client.list_tools()
            self.assertIn("capture_image", [tool.name for tool in tools.tools])
            result = await client.call_tool("list_image_sessions", {})
            self.assertFalse(result.is_error)
            self.assertEqual(result.structured_content, {"sessions": []})
            failed = await client.call_tool(
                "inspect_image_pixel", {"session_id": "missing", "x": 0, "y": 0}
            )
            self.assertTrue(failed.is_error)


if __name__ == "__main__":
    unittest.main()
