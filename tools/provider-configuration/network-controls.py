"""Independent outer guards make regressions fail without risking real I/O."""
from __future__ import annotations

import importlib.util
import json
import os
import socket
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from copy import deepcopy

ROOT = Path(__file__).resolve().parents[2]
if os.environ.get("PRISM_PY_SRC"):
    sys.path.insert(0, str(Path(os.environ["PRISM_PY_SRC"]).resolve()))
spec = importlib.util.spec_from_file_location("owned_canonical_stream", ROOT / "tools/streaming/py.py")
assert spec and spec.loader
stream = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stream)
config_spec = importlib.util.spec_from_file_location("owned_canonical_configuration", ROOT / "tools/provider-configuration/py.py")
assert config_spec and config_spec.loader
configuration = importlib.util.module_from_spec(config_spec)
config_spec.loader.exec_module(configuration)
document = json.loads((ROOT / "suites/anthropic-text-stream/cases.json").read_text(encoding="utf-8"))
CASE = document["cases"][0]


class NetworkControls(unittest.TestCase):
    def test_fixture_cannot_grant_itself_an_environment_override(self) -> None:
        document = json.loads((ROOT / "suites/provider-configuration/cases.json").read_text(encoding="utf-8"))
        for mutation in [lambda names: names.append("NODE_OPTIONS"), lambda names: names.pop(), lambda names: names.append(names[0])]:
            candidate = deepcopy(document)
            mutation(candidate["environment_names"])
            with self.assertRaisesRegex(ValueError, "Unapproved environment isolation"):
                configuration.observe(candidate)

    def test_native_transport_is_intercepted(self) -> None:
        with (
            patch("socket.getaddrinfo", side_effect=RuntimeError("Outer DNS refusal.")),
            patch("socket.socket.connect", side_effect=RuntimeError("Outer socket refusal.")),
        ):
            trace = stream.parse_stream(CASE)
        self.assertEqual(trace["requests"], 1)
        self.assertEqual(trace["terminal"], {"status": "returned"})
        self.assertTrue(trace["events"])

    def test_changed_transport_cannot_escape_to_dns(self) -> None:
        self.assert_escape_refused(lambda: socket.getaddrinfo("offline.invalid", 443))

    def test_changed_transport_cannot_escape_to_a_socket(self) -> None:
        def connect() -> None:
            with socket.socket() as connection:
                connection.connect(("192.0.2.1", 443))
        self.assert_escape_refused(connect)

    def assert_escape_refused(self, operation: object) -> None:
        class EscapingProvider:
            def __init__(self, **_options: object) -> None:
                pass

            def stream(self, _request: object) -> object:
                operation()
                return iter(())

        with (
            patch.object(stream, "Anthropic", EscapingProvider),
            patch("socket.getaddrinfo", side_effect=RuntimeError("Outer DNS refusal.")),
            patch("socket.socket.connect", side_effect=RuntimeError("Outer socket refusal.")),
        ):
            trace = stream.parse_stream(CASE)
        self.assertEqual(trace["requests"], 0)
        self.assertEqual(trace["terminal"], {"status": "raised", "exception": "AssertionError"})


if __name__ == "__main__":
    unittest.main()
