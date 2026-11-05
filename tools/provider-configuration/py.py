"""Execute SDK constructors, request mapping and FIM dispatch without network I/O."""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

if os.environ.get("PRISM_PY_SRC"):
    sys.path.insert(0, str(Path(os.environ["PRISM_PY_SRC"]).resolve()))

from prism.fim.request import FimRequest
from prism.http import HttpResponse
from prism.providers.anthropic.provider import Anthropic
from prism.providers.mistral.provider import Mistral
from prism.providers.openai.provider import OpenAI
from prism.text.request import Request

PROVIDERS = {"anthropic": Anthropic, "openai": OpenAI, "mistral": Mistral}
NAMES = {"version": "api_version", "anthropic_beta": "beta_features"}
PROPERTIES = {"apiKey": "api_key", "apiVersion": "api_version", "betaFeatures": "beta_features", "apiFormat": "api_format"}
ENVIRONMENT_NAMES = json.loads((Path(__file__).parent / "environment-names.json").read_text(encoding="utf-8"))


def observe(document: dict[str, Any]) -> list[dict[str, Any]]:
    if sorted(document["environment_names"]) != sorted(ENVIRONMENT_NAMES):
        raise ValueError("Unapproved environment isolation names.")
    rows = []
    with (
        patch.dict(os.environ),
        patch("socket.getaddrinfo", side_effect=AssertionError("Unowned DNS in configuration fixture.")),
        patch("socket.socket.connect", side_effect=AssertionError("Unowned socket in configuration fixture.")),
    ):
        for entry in document["cases"]:
            row = entry["given"]
            for name in document["environment_names"]:
                os.environ.pop(name, None)
            for name, value in row.get("env", {}).items():
                if name not in ENVIRONMENT_NAMES:
                    raise ValueError("Unapproved synthetic environment name.")
                os.environ[name] = value
            if row["kind"] == "config":
                config = {NAMES.get(name, name): value for name, value in row["config"].items()}
                try:
                    provider = PROVIDERS[row["provider"]](**config)
                    result = {"value": getattr(provider, PROPERTIES.get(row["property"], row["property"]))}
                except TypeError:
                    result = {"error": "TypeError"}
            else:
                calls = []

                class Capture:
                    def send(self, request: Any) -> HttpResponse:
                        calls.append(request)
                        route = "fim/completions" if row["kind"] == "fim" else "messages"
                        if request.url != "https://offline.invalid/v1/" + route:
                            raise ValueError("Unexpected fixture destination.")
                        body = (
                            {"id": "fixture", "model": "fixture", "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 1, "completion_tokens": 1}}
                            if row["kind"] == "fim" else
                            {"id": "fixture", "model": "fixture", "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn", "usage": {}}
                        )
                        return HttpResponse(status=200, body=json.dumps(body).encode(), headers=row.get("headers", {}))

                config = {"api_key": "synthetic", "url": "https://offline.invalid/v1", "transport": Capture()}
                if row["kind"] == "thinking":
                    if "defaultConfig" in row:
                        config["default_thinking_budget"] = row["defaultConfig"]
                    Anthropic(**config).text(Request(model="fixture", provider_options={"thinking": row["thinking"]}, reasoning_enabled=row.get("reasoning")))
                    if len(calls) != 1:
                        raise ValueError("Fixture must dispatch exactly once.")
                    result = {"thinking": json.loads(calls[0].body).get("thinking")}
                elif row["kind"] == "fim":
                    class FrozenDateTime(datetime):
                        @classmethod
                        def now(cls, tz: Any = None) -> datetime:
                            return datetime.fromtimestamp(row["now"], tz=timezone.utc).astimezone(tz)

                    with patch("prism.providers.mistral.rate_limits.datetime", FrozenDateTime):
                        response = Mistral(**config).fim(FimRequest(model="fixture", prompt="prefix"))
                    result = {"count": len(calls), "text": response.text, "rates": [rate.to_dict() for rate in response.meta.rate_limits]}
                else:
                    raise ValueError("Unknown configuration fixture kind.")
            rows.append({"id": entry["id"], "observed": result})
    return rows


if __name__ == "__main__":
    print(json.dumps(observe(json.load(sys.stdin)), ensure_ascii=False))
