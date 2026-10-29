from __future__ import annotations

import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from prism_harness import AgentRuntime, FileSessionStore, LlmResponse, ModeRegistry, Participant, PrismHarness, ToolRegistry
import prism_harness.runtime as runtime_module
import prism_harness.session as session_module
import prism_harness.thread as thread_module


class FixedDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 1, 1, tzinfo=timezone.utc)


# Serial fixture only; real process contention probes keep the real clock/entropy.
for module in (runtime_module, session_module, thread_module):
    module.datetime = FixedDateTime
uuid.uuid4 = lambda: uuid.UUID("00000000-0000-4000-8000-000000000001")
directory = Path(sys.argv[1])
store = FileSessionStore(directory)
harness = PrismHarness(drivers={"owned": lambda: store}, stores={"ephemeral": "owned", "durable": "owned"})
session = harness.for_(Participant("legacy-person", 7)).session("same:/雪")
session.using_mode("chat").using_provider("anthropic").using_model("fixture-model")
session.using_capability("fixture", {"enabled": True})
session.tasks().add("fixed task", "fixed-task")
requests = []


class Tick:
    name = "tick"
    description = "Fixed tool"

    def handle(self, args):
        raise AssertionError("This fixture never requests a tool call")


class Tock(Tick):
    name = "tock"
    description = "Second tool"


def client(request):
    assert getattr(request, "max_output_tokens", None) is None and "_max_output_tokens" not in vars(request)
    requests.append(json.dumps({"system_prompt": request.system_prompt,"messages":request.messages,"tools":[{"name":tool.name,"description":tool.description} for tool in request.tools],"provider":request.provider,"model":request.model,"provider_options":request.provider_options,"schema":request.schema}, separators=(",", ":"), ensure_ascii=False))
    return LlmResponse(text=f"answer:{len(requests)}", finish_reason="stop", cost_usd=0)


runtime = AgentRuntime(client, ModeRegistry({"default":"chat","modes":{"chat":{"system_prompt":"Frozen instructions","tools":["tock","tick"],"max_steps":2,"provider_options":{"temperature":0.25}}}}), ToolRegistry().register_many([Tick(), Tock()]))
runtime.send(session, "first")
runtime.send(session, "second")
assert len(requests) == 2 and all(json.loads(raw)["tools"] == [{"name":"tock","description":"Second tool"},{"name":"tick","description":"Fixed tool"}] for raw in requests)
files = {}
for file in sorted(directory.iterdir()):
    assert file.is_file() and file.suffix == ".json", "No unfinished lock or temporary files"
    files[file.name] = file.read_bytes().hex()
assert len(files) >= 4
print(json.dumps({"session_key":session.key(),"requests":requests,"files":files},separators=(",", ":"),ensure_ascii=False))
