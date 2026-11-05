"""Native MCP observations. The event loop starts before the network fence."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import socket
import sys
import warnings
from unittest.mock import patch

if os.environ.get("PRISM_MCP_PY_SRC"):
    sys.path.insert(0, str(Path(os.environ["PRISM_MCP_PY_SRC"]).resolve()))

from prism_mcp import Client, McpError, ResultGuard, ToolDefinition, TrustPolicy


async def observe(document):
    tool = ToolDefinition.from_payload({"name": "owned", "description": "Owned fixture", "inputSchema": {"type": "object", "properties": {}}})
    rows = []
    with patch.object(socket, "getaddrinfo", side_effect=AssertionError("Unexpected MCP DNS")), patch.object(socket.socket, "connect", side_effect=AssertionError("Unexpected MCP network")):
        for entry in document["cases"]:
            value = entry["given"]
            kind = value["kind"]
            if kind == "flag":
                reply = {"content": []}
                if value["present"]:
                    reply["isError"] = value["value"]

                async def transport(_request):
                    return reply

                result = await Client("configured", transport, TrustPolicy.allowing_every_tool()).call_tool(tool)
                rows.append({"id": entry["id"], "observed": {"isError": result.is_error}})
                continue
            if kind in ("content", "cap"):
                content = value["content"] if kind == "content" else [{"type": "text", "text": value["unit"] * value["repeat"]}]

                async def transport(_request):
                    return {"content": content, "isError": value.get("isError", False)}

                options = {"frame_provenance": False}
                if "maxBytes" in value:
                    options["max_bytes"] = value["maxBytes"]
                client = Client("configured", transport, TrustPolicy.allowing_every_tool(), ResultGuard(**options))
                try:
                    result = await client.call_tool(tool)
                    observed = {"text": result.text} if kind == "content" else {"status": "returned", "bytes": len(result.text.encode("utf-8"))}
                except McpError as error:
                    observed = {"status": error.code}
                rows.append({"id": entry["id"], "observed": observed})
                continue
            assert kind in ("trust", "mirror", "diagnostic")
            dispatches = 0

            async def transport(_request):
                nonlocal dispatches
                dispatches += 1
                return {"tools": value["tools"]}

            policy = TrustPolicy.undeclared() if value["trust"] == "missing" else TrustPolicy.allowing_every_tool() if value["trust"] == "*" else TrustPolicy.allowing(value["trust"])
            client = Client("configured", transport, policy)
            with warnings.catch_warnings(record=True) as captured:
                warnings.simplefilter("always")
                try:
                    offered = [definition.name for definition in await client.list_tools()]
                    observed = {"dispatches": dispatches, "offered": offered} if kind == "trust" else {"offered": offered, "excluded": sorted(client.excluded())} if kind == "mirror" else {"offered": offered, "warned": bool(captured), "private": all("REMOTE_" not in str(item.message) for item in captured)}
                except McpError as error:
                    observed = {"dispatches": dispatches, "error": error.code, "empty": "empty tool allowlist" in str(error)} if kind == "trust" else {"error": error.code}
            rows.append({"id": entry["id"], "observed": observed})
    return rows


# Bytes are UTF-8 JSON. Windows text stdin can otherwise reinterpret é as Ã©
# before the SDK receives it and turn a byte-cap control into a different input.
print(json.dumps(asyncio.run(observe(json.loads(sys.stdin.buffer.read())))))
