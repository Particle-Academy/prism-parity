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
from urllib.parse import urlsplit

if os.environ.get("PRISM_PY_SRC"):
    sys.path.insert(0, str(Path(os.environ["PRISM_PY_SRC"]).resolve()))

import prism.registry as registry
from prism import Prism, register_provider, resolve_provider
from prism.http import HttpRequest, HttpResponse, HttpStreamResponse, UrllibStreamTransport, UrllibTransport
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


def _messages(error: BaseException | None) -> str:
    messages: list[str] = []
    seen: set[int] = set()
    current = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        messages.append(str(current))
        current = current.__cause__ or current.__context__
    return "\n".join(messages)


def classify_compatible(requests: list[dict[str, Any]], error: BaseException | None, row: dict[str, Any]) -> dict[str, Any]:
    """The first request and the error, classified like php.php and ts-compatible.mjs."""
    base = classify([request["wire"] for request in requests])
    text = "\n".join(request["wire"] for request in requests)
    message = _messages(error)
    refusal = "none"
    if not requests and error is not None:
        if "not a valid provider name" in message:
            refusal = "name"
        elif "already registered" in message:
            refusal = "collision"
        elif "not a valid provider url" in message:
            refusal = "url"
        elif "not a valid api format" in message:
            refusal = "format"
        elif "not a supported provider driver" in message or "is not supported" in message:
            refusal = "unsupported"
        else:
            raise error
    first = requests[0] if requests else None
    entry_url = (row.get("entry") or {}).get("url")
    target = "none"
    if first is not None:
        if isinstance(entry_url, str) and first["url"].lower().startswith(entry_url.rstrip("/").lower() + "/"):
            target = "entry"
        elif first["url"].startswith("https://api.openai.com/"):
            target = "openai"
        else:
            target = "other"
    body = None
    if first is not None:
        try:
            parsed = json.loads(first["body"])
            body = parsed if isinstance(parsed, dict) else None
        except ValueError:
            body = None
    account = "none"
    if FIXTURE["organization"] in text or FIXTURE["project"] in text:
        account = "inherited"
    elif "org-test-entry" in text or "proj-test-entry" in text:
        account = "entry"
    return {
        "refusal": refusal,
        "dispatched": base["dispatched"],
        "credential": base["credential"],
        "authorization": first is not None and any(key.lower() == "authorization" for key in first["headers"]),
        "account": account,
        "target": target,
        "path": None if first is None else urlsplit(first["url"]).path,
        "body": body,
        "error_carries_credential": FIXTURE["inherited_key"] in message or FIXTURE["explicit_key"] in message,
    }


def observe_compatible(row: dict[str, Any], requests: list[dict[str, Any]]) -> dict[str, Any]:
    from prism import StringSchema, Tool, configure_providers  # type: ignore[attr-defined]
    from prism.schema import ObjectSchema

    error: BaseException | None = None
    try:
        if "entry" in row:
            configure_providers({row["name"]: {key: value for key, value in row["entry"].items() if value is not None}})
        if row["call"] == "structured":
            pending: Any = (
                Prism.structured()
                .using(row["provider"], "fixture-model", dict(row["config"]))
                .with_schema(ObjectSchema("reply", "a reply", (StringSchema("answer", "the answer"),), ("answer",)))
            )
        else:
            pending = Prism.text().using(row["provider"], "fixture-model", dict(row["config"]))
        if row["call"] == "tool":
            pending = pending.with_tools(
                [Tool().as_("lookup").for_("Look something up").with_string_parameter("query", "The query")]
            )
        pending = pending.with_prompt("hi")
        if row["call"] == "structured":
            pending.as_structured()
        elif row["call"] == "stream":
            for _ in pending.as_stream():
                pass
        else:
            pending.as_text()
    except Exception as caught:  # every failure is classified
        error = caught
    return classify_compatible(requests, error, row)


def observe(document: dict[str, Any]) -> list[dict[str, Any]]:
    if sorted(document["environment_names"]) != sorted(ENVIRONMENT_NAMES):
        raise ValueError("Unapproved environment isolation names.")
    wires: list[str] = []

    def send(self: UrllibTransport, request: HttpRequest) -> HttpResponse:
        headers = "\n".join(f"{key}: {value}" for key, value in request.headers.items())
        body = request.body.decode("utf-8", "replace") if isinstance(request.body, bytes) else ""
        wires.append(f"{request.url}\n{headers}\n{body}")
        requests.append({"url": request.url, "headers": dict(request.headers), "body": body, "wire": wires[-1]})
        if unreachable[0]:
            raise ConnectionRefusedError("Connection refused")
        return HttpResponse(status=500, body=b'{"error":{"message":"fixture"}}', headers={})

    def stream(self: UrllibStreamTransport, request: HttpRequest) -> HttpStreamResponse:
        response = send(UrllibTransport(), request)
        return HttpStreamResponse(status=response.status, headers={}, chunks=iter([response.body.decode("utf-8")]))

    requests: list[dict[str, Any]] = []
    unreachable = [False]
    rows = []
    with (
        patch.dict(os.environ),
        patch.object(UrllibTransport, "send", send),
        patch.object(UrllibStreamTransport, "stream", stream),
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
                        # A collision, or a name the registry refuses as unreadable.
                        if "already registered" not in str(error) and "not a valid provider name" not in str(error):
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
            elif row["kind"] == "compatible":
                saved = dict(registry._FACTORIES)
                wires.clear()
                requests.clear()
                unreachable[0] = row["transport"] == "unreachable"
                try:
                    result = observe_compatible(row, requests)
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
