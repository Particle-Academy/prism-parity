"""Native Python observations for the credential-scope corpus, without network I/O.

Every request enters through ``Prism.text().using(...)`` and is captured at the
default transport's ``send``, which answers 500. A row records WHETHER a
credential was sent, never which value.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any
from unittest.mock import patch

if os.environ.get("PRISM_PY_SRC"):
    sys.path.insert(0, str(Path(os.environ["PRISM_PY_SRC"]).resolve()))

import prism.registry as registry
from prism import Prism, register_provider, resolve_provider
from prism.http import HttpRequest, HttpResponse, UrllibTransport
from prism.providers.anthropic.provider import Anthropic
from prism.providers.base import Provider
from prism.providers.mistral.provider import Mistral
from prism.providers.openai.provider import OpenAI

HERE = Path(__file__).parent
ENVIRONMENT_NAMES = json.loads((HERE / "environment-names.json").read_text(encoding="utf-8"))
FIXTURE = json.loads((HERE / "fixture-values.json").read_text(encoding="utf-8"))
BUILT_INS = {"openai": OpenAI, "anthropic": Anthropic, "mistral": Mistral}


class Stub(Provider):
    pass


def stub(**_: Any) -> Provider:
    return Stub()


def classify(wires: list[str]) -> dict[str, Any]:
    text = "\n".join(wires)
    inherited = FIXTURE["inherited_key"] in text
    explicit = FIXTURE["explicit_key"] in text
    return {
        "dispatched": len(wires) > 0,
        "credential": "both" if inherited and explicit else "inherited" if inherited else "explicit" if explicit else "none",
        "account": "inherited" if FIXTURE["organization"] in text or FIXTURE["project"] in text else "none",
    }


def observe(document: dict[str, Any]) -> list[dict[str, Any]]:
    if sorted(document["environment_names"]) != sorted(ENVIRONMENT_NAMES):
        raise ValueError("Unapproved environment isolation names.")
    wires: list[str] = []

    def send(self: UrllibTransport, request: HttpRequest) -> HttpResponse:
        headers = "\n".join(f"{key}: {value}" for key, value in request.headers.items())
        body = request.body.decode("utf-8", "replace") if isinstance(request.body, bytes) else ""
        wires.append(f"{request.url}\n{headers}\n{body}")
        return HttpResponse(status=500, body=b'{"error":{"message":"fixture"}}', headers={})

    rows = []
    with (
        patch.dict(os.environ),
        patch.object(UrllibTransport, "send", send),
        patch("socket.getaddrinfo", side_effect=AssertionError("Unowned DNS in credential fixture.")),
        patch("socket.socket.connect", side_effect=AssertionError("Unowned socket in credential fixture.")),
    ):
        for entry in document["cases"]:
            row = entry["given"]
            for name in ENVIRONMENT_NAMES:
                os.environ.pop(name, None)
            for name, value in row.get("env", {}).items():
                if name not in ENVIRONMENT_NAMES:
                    raise ValueError("Unapproved synthetic environment name.")
                os.environ[name] = value
            if row["kind"] == "endpoint":
                wires.clear()
                try:
                    Prism.text().using(row["provider"], "fixture-model", dict(row["config"])).with_prompt("hi").as_text()
                except Exception:  # the fixture answers 500; only the outgoing request matters
                    pass
                result = classify(wires)
            elif row["kind"] == "register":
                saved = dict(registry._FACTORIES)
                try:
                    if "preregistered" in row:
                        register_provider(row["preregistered"], stub)
                    refused = False
                    try:
                        if row.get("replace"):
                            register_provider(row["name"], stub, replace=True)  # type: ignore[call-arg]
                        else:
                            register_provider(row["name"], stub)
                    except ValueError as error:
                        if "already registered" not in str(error):
                            raise
                        refused = True
                    except TypeError as error:
                        # A port without explicit replacement: nothing was
                        # registered, which the row then records as stale.
                        if "replace" not in str(error):
                            raise
                    intact = all(isinstance(resolve_provider(key, {"api_key": "x"}), kind) for key, kind in BUILT_INS.items())
                    result = {"refused": refused, "builtins_intact": intact}
                finally:
                    registry._FACTORIES.clear()
                    registry._FACTORIES.update(saved)
            else:
                raise ValueError("Unknown credential-scope fixture kind.")
            rows.append({"id": entry["id"], "observed": result})
    return rows


if __name__ == "__main__":
    # Bytes in and out: a platform default encoding would rewrite the
    # non-ASCII names this corpus exists to carry.
    document = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    sys.stdout.buffer.write(json.dumps(observe(document), ensure_ascii=False).encode("utf-8") + b"\n")
