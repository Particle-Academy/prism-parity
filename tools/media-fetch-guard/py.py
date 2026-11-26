"""Native Python observations for the media-fetch-guard WIRE rows (G-386).

Each row enters through ``Image.from_url(...).fetch_public()`` over the REAL
default transport, against the loopback server the entry point started for
that row. The resolver answers the row's ``answers_any`` for every name it is
asked, which is what an attacker's own DNS zone does. Whether anything arrived
is read off the server; this records only WHICH refusal code stopped the fetch.

The network guard lets the process look up a name only when it is a spelling
of loopback (percent-decoded, NFKC-folded, inet_aton numeric forms) and connect
only to a 127.x address. Every wire row's host is such a spelling, so a guard
that admits one reaches the loopback server, and nothing leaves the machine.
Python has no unguarded media fetch; a row's ``skip`` says so and is not run.
"""
from __future__ import annotations

import json
import os
import re
import socket
import sys
import unicodedata
from pathlib import Path
from typing import Any
from unittest.mock import patch
from urllib.parse import unquote

if os.environ.get("PRISM_PY_SRC"):
    sys.path.insert(0, str(Path(os.environ["PRISM_PY_SRC"]).resolve()))

from prism import Image, PrismError

REFUSALS = (
    "scheme_not_allowed",
    "private_address_refused",
    "host_did_not_resolve",
    "redirect_refused",
    "too_many_redirects",
    "non_ascii_host_use_punycode",
)
LOOPBACK = re.compile(r"\A127\.\d+\.\d+\.\d+\Z")

_real_getaddrinfo = socket.getaddrinfo
_real_connect = socket.socket.connect


def _inet_aton(host: str) -> int | None:
    parts = host.split(".")
    if len(parts) > 4:
        return None
    numbers = []
    for part in parts:
        if re.fullmatch(r"0[xX][0-9a-fA-F]*", part):
            numbers.append(int(part[2:] or "0", 16))
        elif re.fullmatch(r"0[0-7]+", part):
            numbers.append(int(part, 8))
        elif re.fullmatch(r"[0-9]+", part):
            numbers.append(int(part))
        else:
            return None
    last = numbers.pop()
    value = 0
    for index, number in enumerate(numbers):
        if number > 255:
            return None
        value |= number << (24 - 8 * index)
    if last >= 1 << (32 - 8 * len(numbers)):
        return None
    return value | last


def reaches_loopback(host: str) -> bool:
    candidates = [host, unquote(host)]
    for candidate in list(candidates):
        candidates.append(unicodedata.normalize("NFKC", candidate))
        candidates.append(candidate.replace("。", ".").replace("．", ".").replace("｡", "."))
    for candidate in candidates:
        candidate = candidate.lower().rstrip(".")
        if candidate == "localhost":
            return True
        address = _inet_aton(candidate)
        if address is not None and address >> 24 == 127:
            return True
    return False


def observe(document: dict[str, Any]) -> list[dict[str, Any]]:
    def getaddrinfo(host: Any, *args: Any, **kwargs: Any) -> Any:
        if isinstance(host, (str, bytes)) and reaches_loopback(host.decode() if isinstance(host, bytes) else host):
            return _real_getaddrinfo(host, *args, **kwargs)
        raise socket.gaierror(socket.EAI_NONAME, "Only a spelling of loopback may be looked up in this corpus.")

    def connect(self: socket.socket, address: Any) -> Any:
        if isinstance(address, tuple) and LOOPBACK.match(str(address[0])):
            return _real_connect(self, address)
        raise ConnectionRefusedError("Only loopback may be contacted in this corpus.")

    rows = []
    with patch("socket.getaddrinfo", getaddrinfo), patch.object(socket.socket, "connect", connect):
        for entry in document["cases"]:
            answers = list(entry["answers_any"])
            honest = dict(entry["resolves"])

            class Resolver:
                def resolve(self, host: str) -> list[str]:
                    return list(honest.get(host, answers))

            refusal = None
            try:
                if entry.get("guarded", True) is not True:
                    raise ValueError("Python has no unguarded media fetch.")
                Image.from_url(entry["url"]).fetch_public(resolver=Resolver(), timeout=10.0)
            except PrismError as error:
                code = str(getattr(error.code, "value", error.code))
                if code in REFUSALS:
                    refusal = code
                else:
                    print(f"{entry['id']}: PrismError {code}", file=sys.stderr)
            except Exception as error:  # the server answers 500 with no image: not a refusal
                print(f"{entry['id']}: {type(error).__name__}", file=sys.stderr)
            rows.append({"id": entry["id"], "refusal": refusal})
    return rows


if __name__ == "__main__":
    document = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    sys.stdout.buffer.write(json.dumps(observe(document), ensure_ascii=False).encode("utf-8") + b"\n")
