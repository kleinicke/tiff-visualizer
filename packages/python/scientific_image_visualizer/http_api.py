"""Authenticated loopback REST and Streamable HTTP MCP over identical tools."""

import argparse
import asyncio
from contextlib import asynccontextmanager
import hmac
import os
from pathlib import Path
import secrets
import uuid
from .mcp_server import create_server

MAX_JSON = 2 * 1024 * 1024
MAX_UPLOAD = 256 * 1024 * 1024


def wire(value):
    return (
        value.model_dump(mode="json", by_alias=True, exclude_none=True)
        if hasattr(value, "model_dump")
        else value
    )


def create_http_app(roots, *, token, state_dir):
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse, FileResponse
    from starlette.routing import Route, Mount
    from mcp.server.transport_security import TransportSecuritySettings

    if not isinstance(token, str) or len(token) < 32:
        raise ValueError("Bearer token must have at least 32 characters")
    state = Path(state_dir).resolve()
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    uploads = state / "uploads"
    uploads.mkdir(exist_ok=True, mode=0o700)
    server, manager = create_server([*roots, uploads])
    mcp_app = server.streamable_http_app(
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(
            allowed_hosts=["127.0.0.1:*", "localhost:*", "127.0.0.1", "localhost"]
        ),
    )
    upload_lock = asyncio.Lock()

    async def tools(request):
        return JSONResponse(
            {"tools": [wire(tool) for tool in await server.list_tools()]}
        )

    async def execute(request):
        name = request.path_params["name"]
        if name not in {tool.name for tool in await server.list_tools()}:
            return JSONResponse(
                {"error": {"code": "not_found", "message": "Unknown operation"}},
                status_code=404,
            )
        try:
            arguments = await request.json()
            if not isinstance(arguments, dict):
                raise ValueError("Expected a JSON arguments object")
            result = wire(await server.call_tool(name, arguments))
            return JSONResponse(
                result, status_code=422 if result.get("isError") else 200
            )
        except (ValueError, TypeError) as error:
            return JSONResponse(
                {"error": {"code": "invalid_request", "message": str(error)}},
                status_code=400,
            )

    async def openapi(request):
        paths = {}
        for tool in await server.list_tools():
            spec = wire(tool)
            paths["/api/v1/tools/" + tool.name] = {
                "post": {
                    "operationId": tool.name,
                    "description": spec.get("description", ""),
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {"schema": spec["inputSchema"]}
                        },
                    },
                    "responses": {
                        "200": {
                            "description": "MCP tool result (structuredContent and content)"
                        },
                        "422": {"description": "Tool validation or renderer failure"},
                    },
                }
            }
        return JSONResponse(
            {
                "openapi": "3.1.0",
                "info": {"title": "Scientific Image Visualizer", "version": "0.1.0"},
                "security": [{"bearer": []}],
                "components": {
                    "securitySchemes": {"bearer": {"type": "http", "scheme": "bearer"}}
                },
                "paths": paths,
            }
        )

    async def upload(request):
        name = request.path_params["name"]
        if (
            not name
            or len(name) > 160
            or Path(name).name != name
            or "\\" in name
            or name.startswith(".")
            or any(ord(char) < 32 or char in '<>:"/\\|?*' for char in name)
        ):
            return JSONResponse(
                {
                    "error": {
                        "code": "invalid_filename",
                        "message": "Use a plain filename",
                    }
                },
                status_code=400,
            )
        async with upload_lock:
            existing = list(uploads.iterdir())
            used = sum(p.stat().st_size for p in existing if p.is_file())
            if len(existing) >= 512 or used >= 1024 * 1024 * 1024:
                return JSONResponse(
                    {
                        "error": {
                            "code": "quota_exceeded",
                            "message": "Delete unused uploads first",
                        }
                    },
                    status_code=413,
                )
            target = uploads / (uuid.uuid4().hex + "-" + name)
            total = 0
            try:
                with target.open("xb") as output:
                    async for chunk in request.stream():
                        total += len(chunk)
                        if total > MAX_UPLOAD or used + total > 1024 * 1024 * 1024:
                            raise ValueError("Upload exceeds file or total quota")
                        output.write(chunk)
                if not total:
                    raise ValueError("Upload is empty")
            except ValueError as error:
                target.unlink(missing_ok=True)
                return JSONResponse(
                    {"error": {"code": "invalid_upload", "message": str(error)}},
                    status_code=413 if total else 400,
                )
            except BaseException:
                target.unlink(missing_ok=True)
                raise
        return JSONResponse({"path": str(target), "bytes": total}, status_code=201)

    async def file(request):
        try:
            target = manager.path(request.query_params.get("path", ""))
            if request.method == "DELETE":
                if target.parent != uploads:
                    raise PermissionError("Only server-managed uploads can be deleted")
                with manager.lock:
                    for session in manager.sessions.values():
                        with session._lock:
                            if any(
                                target in files for files in session._history.values()
                            ):
                                raise ValueError(
                                    "Upload is still used by an active session; close it first"
                                )
                target.unlink()
                return JSONResponse({"deleted": True})
            return FileResponse(target, filename=target.name)
        except (OSError, ValueError) as error:
            return JSONResponse(
                {"error": {"code": "file_error", "message": str(error)}},
                status_code=422,
            )

    @asynccontextmanager
    async def lifespan(app):
        try:
            async with mcp_app.router.lifespan_context(mcp_app):
                yield
        finally:
            manager.close()

    app = Starlette(
        routes=[
            Route("/api/v1/tools", tools),
            Route("/api/v1/tools/{name}", execute, methods=["POST"]),
            Route("/api/v1/openapi.json", openapi),
            Route("/api/v1/uploads/{name}", upload, methods=["POST"]),
            Route("/api/v1/files", file, methods=["GET", "DELETE"]),
            Mount("/", app=mcp_app),
        ],
        lifespan=lifespan,
    )

    class Guard:
        """Authenticate before parsing; reject browser origins and DNS rebinding."""

        async def __call__(self, scope, receive, send):
            if scope["type"] != "http":
                return await app(scope, receive, send)
            headers = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
            host = headers.get("host", "").split(":")[0]
            if host not in ("127.0.0.1", "localhost") or "origin" in headers:
                return await JSONResponse(
                    {
                        "error": {
                            "code": "forbidden",
                            "message": "Loopback non-browser clients only",
                        }
                    },
                    status_code=403,
                )(scope, receive, send)
            if not hmac.compare_digest(
                headers.get("authorization", ""), f"Bearer {token}"
            ):
                return await JSONResponse(
                    {
                        "error": {
                            "code": "unauthorized",
                            "message": "Provide Authorization: Bearer <token>",
                        }
                    },
                    status_code=401,
                    headers={"WWW-Authenticate": "Bearer"},
                )(scope, receive, send)
            if scope["path"].startswith("/api/v1/uploads/"):
                return await app(scope, receive, send)
            limit = MAX_JSON
            # Bound chunked bodies too, before the protocol parser sees them.
            body = bytearray()
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                body.extend(message.get("body", b""))
                if len(body) > limit:
                    return await JSONResponse(
                        {
                            "error": {
                                "code": "too_large",
                                "message": "Request body exceeds the limit",
                            }
                        },
                        status_code=413,
                    )(scope, receive, send)
                if not message.get("more_body", False):
                    break
            delivered = False

            async def replay():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {
                        "type": "http.request",
                        "body": bytes(body),
                        "more_body": False,
                    }
                return await receive()

            await app(scope, replay, send)

    return Guard()


def main():
    import uvicorn

    parser = argparse.ArgumentParser(description="Local image REST and HTTP MCP server")
    parser.add_argument("--root", action="append", required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    token_file = args.state_dir / "token"
    try:
        fd = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        if (
            not token_file.is_file()
            or token_file.is_symlink()
            or token_file.stat().st_mode & 0o077
        ):
            parser.error("Token file must be a regular owner-only file")
        token = token_file.read_text().strip()
    else:
        token = secrets.token_urlsafe(32)
        with os.fdopen(fd, "w") as file:
            file.write(token + "\n")
    app = create_http_app(args.root, token=token, state_dir=args.state_dir)
    print(
        f"REST: http://127.0.0.1:{args.port}/api/v1/tools | MCP: /mcp | Token file: {token_file}",
        flush=True,
    )
    uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False)


if __name__ == "__main__":
    main()
