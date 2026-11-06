"""Native observers; controlled DNS and HTTP seams never make a connection."""
from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import sys
from unittest.mock import patch

for key in ("PRISM_POLICY_BROWSER_PY_SRC", "PRISM_POLICY_HUMAN_PY_SRC"):
    if os.environ.get(key):
        sys.path.insert(0, str(Path(os.environ[key]).resolve()))

import prism_browser as browser
import prism_human_plus as human


def observe(document):
    rows = []
    frame = {"jsonrpc": "2.0", "id": "probe", "method": "tools/call", "params": {}}
    rpc = 'data: {"jsonrpc":"2.0","id":"probe","result":{"fixture":true}}\n\n'
    for entry in document["cases"]:
        value = entry["given"]
        kind = value["kind"]
        if kind == "browser-serialization":
            rows.append({"id": entry["id"], "observed": {"keys": sorted(browser.BrowserPolicy(["example.com"]).to_dict())}})
            continue
        if kind == "browser":
            calls = [0]

            class Engine:
                def navigate(self, url):
                    calls[0] += 1
                    return browser.Observation(origin="https://fixture", url=url, content={"fixture": True})

                def act(self, action):
                    raise AssertionError("Unexpected browser action")

            outcome = "returned"
            try:
                policy = browser.BrowserPolicy(value["allowedHosts"], **({"allow_private_addresses": value["value"]} if value["mode"] == "constructor" else {}))
                if value["mode"] == "property":
                    policy.allow_private_addresses = True
                browser.GuardedBrowser(Engine(), policy).navigate(value["url"])
            except (browser.BrowserRefused, TypeError):
                outcome = "refused"
            rows.append({"id": entry["id"], "observed": {"outcome": outcome, "engineCalls": calls[0]}})
            continue
        state = {"posts": 0, "streams": 0, "dnsCalls": 0}

        def lookup(host, port, *args, **kwargs):
            index = state["dnsCalls"]
            state["dnsCalls"] += 1
            answers = value.get("answers", [["8.8.8.8"]])
            answer = answers[min(index, len(answers) - 1)]
            if answer is False:
                raise socket.gaierror("PRIVATE-B3-DNS")
            return [(socket.AF_INET6 if ":" in address else socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (address, 443, 0, 0) if ":" in address else (address, 443)) for address in answer]

        class Http:
            def post(self, url, headers, body):
                state["posts"] += 1
                status = value["status"] if kind == "relay-call" and value["operation"] != "stream" else value.get("postStatus", 200)
                return human.RelayResponse(status, value.get("body", ""))

            def stream(self, url, headers):
                state["streams"] += 1
                return human.RelayStream(value["status"] if kind == "relay-call" else value.get("getStatus", 200), [rpc])

        observed = {"category": "success", "private": True}
        with patch.object(socket, "getaddrinfo", lookup), patch.object(socket.socket, "connect", side_effect=AssertionError("Unexpected observer network")):
            try:
                subject = human.SsePostRelayTransport(Http(), allowed_relay_hosts=value.get("allowedHosts", ["8.8.8.8"]), allowed_relay_ports=value.get("allowedPorts", [443]), egress_proxy=None if value.get("proxy", True) is None else "http://proxy.fixture:3128", allow_unverified_egress=value.get("allowUnverified", False))
                if kind == "relay-classifier":
                    subject._assert_live(value["status"], value["body"], value["operation"] == "detach")
                else:
                    assert kind in ("relay-call", "relay-dns", "relay-literal", "relay-native")
                    invitation = human.SurfaceInvitation(relay_base_url=value.get("url", "https://8.8.8.8"), session_id="b3session", token="T" * 32, surface_id="board:fixture", application="Fixture", allow_insecure_loopback=value.get("allowInsecureLoopback", False))
                    attachment = human.SurfaceAttachment("surface_x", "session:one", invitation, human.Participant("agent:b3", "Fixture", "#fff"), "b3_client")
                    if value.get("operation") == "detach":
                        subject.detach(attachment)
                    elif value.get("operation") == "notify":
                        subject.notify(attachment, frame)
                    else:
                        assert subject.exchange(attachment, frame)["result"] == {"fixture": True}
            except human.HumanPlusError as error:
                observed = {"category": type(error).__name__, "private": "PRIVATE-B3" not in str(error)}
        if kind not in ("relay-classifier", "relay-native"):
            observed.update(state)
        rows.append({"id": entry["id"], "observed": observed})
    return rows


print(json.dumps(observe(json.loads(sys.stdin.buffer.read()))))
