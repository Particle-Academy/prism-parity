"""Native Python execution for the cross-origin-redirect corpus.

Every call enters through ``Prism.text().using(...)`` with the provider's url
and key read from the environment, over the default transport and real
sockets. DNS and connections to anything but a 127.x literal are refused.
Nothing is observed here: the loopback servers are the observation.
"""
from __future__ import annotations

import json
import os
import re
import socket
import sys
from pathlib import Path
from typing import Any
from unittest.mock import patch

if os.environ.get("PRISM_PY_SRC"):
    sys.path.insert(0, str(Path(os.environ["PRISM_PY_SRC"]).resolve()))

from prism import Prism

HERE = Path(__file__).parent
ENVIRONMENT_NAMES = json.loads((HERE / "environment-names.json").read_text(encoding="utf-8"))
LOOPBACK = re.compile(r"\A127\.\d+\.\d+\.\d+\Z")

_real_getaddrinfo = socket.getaddrinfo
_real_connect = socket.socket.connect


def _getaddrinfo(host: Any, *args: Any, **kwargs: Any) -> Any:
    if not LOOPBACK.match(str(host)):
        raise AssertionError("Only loopback hosts may be resolved in this corpus.")
    return _real_getaddrinfo(host, *args, **kwargs)


def _connect(self: socket.socket, address: Any) -> Any:
    if not (isinstance(address, tuple) and LOOPBACK.match(str(address[0]))):
        raise AssertionError("Only loopback hosts may be contacted in this corpus.")
    return _real_connect(self, address)


def execute(document: dict[str, Any]) -> None:
    if sorted(document["environment_names"]) != sorted(ENVIRONMENT_NAMES):
        raise ValueError("Unapproved environment isolation names.")
    with (
        patch.dict(os.environ),
        patch("socket.getaddrinfo", _getaddrinfo),
        patch.object(socket.socket, "connect", _connect),
    ):
        for row in document["rows"]:
            for name in ENVIRONMENT_NAMES:
                os.environ.pop(name, None)
            for name, value in row["env"].items():
                if name not in ENVIRONMENT_NAMES:
                    raise ValueError("Unapproved synthetic environment name.")
                os.environ[name] = value
            try:
                Prism.text().using(row["provider"], "fixture-model").with_prompt("hi").as_text()
            except Exception:  # every fixture ends in a 500 or a refused redirect
                pass


if __name__ == "__main__":
    execute(json.loads(sys.stdin.buffer.read().decode("utf-8")))
    sys.stdout.write("done\n")
