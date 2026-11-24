"""Native Python observations for the per-call-url-guard corpus, without network I/O.

Every request enters through ``Prism.text().using(...)`` and is captured at the
default transport's ``send``, which answers 500; DNS and sockets are refused. A
row records WHETHER a request was sent and WHICH refusal code stopped it.
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

from prism import Prism, PrismError, configure_providers
from prism.http import HttpRequest, HttpResponse, UrllibTransport

HERE = Path(__file__).parent
ENVIRONMENT_NAMES = json.loads((HERE / "environment-names.json").read_text(encoding="utf-8"))
REFUSALS = ("private_address_refused", "scheme_not_allowed", "non_ascii_host_use_punycode")


def observe(document: dict[str, Any]) -> list[dict[str, Any]]:
    if sorted(document["environment_names"]) != sorted(ENVIRONMENT_NAMES):
        raise ValueError("Unapproved environment isolation names.")
    sent: list[str] = []

    def send(self: UrllibTransport, request: HttpRequest) -> HttpResponse:
        sent.append(request.url)
        return HttpResponse(status=500, body=b'{"error":{"message":"fixture"}}', headers={})

    rows = []
    with (
        patch.dict(os.environ),
        patch.object(UrllibTransport, "send", send),
        patch("socket.getaddrinfo", side_effect=AssertionError("Unowned DNS in per-call fixture.")),
        patch("socket.socket.connect", side_effect=AssertionError("Unowned socket in per-call fixture.")),
    ):
        for entry in document["cases"]:
            row = entry["given"]
            for name in ENVIRONMENT_NAMES:
                os.environ.pop(name, None)
            for name, value in row.get("env", {}).items():
                if name not in ENVIRONMENT_NAMES:
                    raise ValueError("Unapproved synthetic environment name.")
                os.environ[name] = value
            if row["kind"] not in ("per-call", "compatible"):
                raise ValueError("Unknown per-call-url-guard fixture kind.")
            sent.clear()
            refusal = None
            try:
                # Inside the observation: a port that refuses the entry itself
                # (an unknown opt-out key) sends nothing and is recorded so.
                if row["kind"] == "compatible":
                    configure_providers({row["provider"]: {"driver": "openai-compatible", **row["entry"]}}, replace=True)
                Prism.text().using(row["provider"], "fixture-model", dict(row["config"])).with_prompt("hi").as_text()
            except Exception as error:  # the fixture answers 500, which is not a refusal
                code = str(getattr(error, "code", ""))
                if not sent and isinstance(error, PrismError) and code in REFUSALS:
                    refusal = code
            rows.append({"id": entry["id"], "observed": {"dispatched": len(sent) > 0, "refusal": refusal}})
    return rows


if __name__ == "__main__":
    document = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    sys.stdout.buffer.write(json.dumps(observe(document), ensure_ascii=False).encode("utf-8") + b"\n")
