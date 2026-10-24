"""Native published urllib transport + SSE parser, without provider network I/O."""
from __future__ import annotations

import base64
from typing import Any
from unittest.mock import patch

from prism import Prism
from prism.providers.anthropic import Anthropic


class ChunkResponse:
    status = 200

    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = list(chunks)
        self.headers = {"Content-Type": "text/event-stream"}

    def read(self, size: int) -> bytes:
        if not self.chunks:
            return b""
        chunk = self.chunks.pop(0)
        if len(chunk) > size:
            self.chunks.insert(0, chunk[size:])
            return chunk[:size]
        return chunk

    def close(self) -> None:
        pass


def parse_stream(case: dict[str, Any]) -> dict[str, Any]:
    stream = case["stream"]
    if stream.get("encoding") != "base64" or not stream.get("chunks"):
        raise ValueError("A stream fixture needs nonempty base64 chunks.")
    chunks = [base64.b64decode(encoded, validate=True) for encoded in stream["chunks"]]
    if any(not chunk for chunk in chunks):
        raise ValueError("Empty stream chunk.")
    requests = 0

    def open_owned(request: Any, **_options: Any) -> ChunkResponse:
        nonlocal requests
        requests += 1
        if request.full_url != "https://api.anthropic.com/v1/messages":
            raise RuntimeError("Unexpected request in owned stream fixture.")
        return ChunkResponse(chunks)

    pending = Prism.text()
    names = {"using": "using", "withPrompt": "with_prompt", "withMaxSteps": "with_max_steps"}
    for step in case["builder"]:
        pending = getattr(pending, names[step["call"]])(*step.get("args", []))
    events = []
    event_ids: dict[str, str] = {}
    opaque_ids: dict[str, str] = {}
    terminal = {"status": "returned"}
    with patch("urllib.request.urlopen", side_effect=open_owned):
        try:
            for event in Anthropic(api_key="owned-g115", url="https://api.anthropic.com/v1").stream(pending.to_request()):
                payload = event.to_dict()
                if "id" in payload:
                    event_ids.setdefault(payload["id"], f"event-{len(event_ids) + 1}")
                    payload["id"] = event_ids[payload["id"]]
                if "timestamp" in payload:
                    payload["timestamp"] = 0
                events.append({"type": event.type().value, "payload": alias_opaque(payload, opaque_ids)})
        except Exception as error:
            terminal = {"status": "raised", "exception": type(error).__name__}
    return {"events": events, "terminal": terminal, "requests": requests}


def alias_opaque(value: Any, aliases: dict[str, str]) -> Any:
    if isinstance(value, list):
        return [alias_opaque(child, aliases) for child in value]
    if not isinstance(value, dict):
        return value
    result = {}
    for key, child in value.items():
        if key in {"message_id", "reasoning_id"} and isinstance(child, str) and child:
            aliases.setdefault(child, f"opaque-{len(aliases) + 1}")
            result[key] = aliases[child]
        else:
            result[key] = alias_opaque(child, aliases)
    return result
