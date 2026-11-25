"""G-285 harness-run-cancel, Python runner.

One scripted run per row through the real AgentRuntime. The model is a scripted
client and sockets are refused. The cancel comes from a SECOND PrismHarness and
AgentRuntime built on their own FileSessionStore instances over the same temp
directory, as another process would.
"""

from __future__ import annotations

import json
import os
import re
import socket
import sys
import tempfile
from importlib import import_module
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if os.environ.get("PRISM_HARNESS_PY"):
    sys.path.insert(0, os.environ["PRISM_HARNESS_PY"])
sys.path.insert(0, str(ROOT / "loaders" / "py" / "src"))


def _refuse(*_args: Any, **_kwargs: Any) -> None:
    raise RuntimeError("The run-cancel corpus never uses the network.")


socket.socket.connect = _refuse  # type: ignore[method-assign]
socket.create_connection = _refuse  # type: ignore[assignment]

harness = import_module("prism_harness")
Corpus = import_module("prism_conformance").Corpus
AgentRuntime = harness.AgentRuntime
FileSessionStore = harness.FileSessionStore
HarnessError = harness.HarnessError
HarnessEvents = harness.HarnessEvents
LlmResponse = harness.LlmResponse
LlmToolCall = harness.LlmToolCall
ModeRegistry = harness.ModeRegistry
Participant = harness.Participant
PrismHarness = harness.PrismHarness
ToolRegistry = harness.ToolRegistry
record_approval = harness.record_approval

REFUSAL = "Not run: the run was cancelled."
NAMES = {
    "run.cancel_requested": "cancel_requested",
    "run.cancelled": "cancelled",
    "run.finished": "finished",
    "run.failed": "failed",
}
WHO = {"same": "Ada", "other": "Bob", "empty": "Cy"}
LOOKALIKE = {"a": "а", "c": "с", "e": "е"}


def homoglyph(real: str) -> str:
    found = [real.find(ascii) for ascii in LOOKALIKE if real.find(ascii) != -1]
    if not found:
        return real + "а"
    at = min(found)
    return real[:at] + LOOKALIKE[real[at]] + real[at + 1 :]


def id_form(form: str, real: str, previous: str | None) -> str:
    """The run id forms every runner derives identically (see id-forms.mjs)."""
    last = real[-1:]
    if form == "previous":
        if previous is None:
            raise RuntimeError("No previous run id.")
        return previous
    forms = {
        "current": real,
        "forged": real[:-1] + ("1" if last == "0" else "0"),
        "empty": "",
        "truncated": real[:-1],
        "extended": real + last,
        "traversal": "../" + real,
        "upper": real.upper(),
        "trailing_newline": real + "\n",
        "trailing_space": real + " ",
        "leading_space": " " + real,
        "zero_width": real + "​",
        "nbsp": real + " ",
        "nul": real + "\u0000",
        "homoglyph": homoglyph(real),
    }
    if form not in forms:
        raise RuntimeError(f"Unknown id form {form}")
    return forms[form]


def code(error: BaseException | None) -> str | None:
    return error.code if isinstance(error, HarnessError) else None


class Tool:
    def __init__(self, name: str, result: str, world: World) -> None:
        self.name = name
        self._result = result
        self._world = world

    def handle(self, _args: dict[str, Any]) -> Any:
        self._world.tools_run.append(self.name)
        if self.name == "search" and self._world.during is not None:
            during, self._world.during = self._world.during, None
            during()
        return self._result


class World:
    def __init__(self, directory: str, spec: dict[str, Any]) -> None:
        self.directory = directory
        self.spec = spec
        self.events: list[Any] = []
        self.queue: list[Any] = []
        self.requests = 0
        self.on_request: Any = None
        self.during: Any = None
        self.tools_run: list[str] = []
        call = 0
        steps = [{"text": turn["text"]} for turn in spec["before"]] + list(spec["script"])
        for step in steps:
            call += 1
            if "calls" in step:
                tool_calls = []
                for name in step["calls"]:
                    call += 1
                    arguments = {"query": "tigers"} if name == "search" else {"city": "Detroit"}
                    tool_calls.append(LlmToolCall(f"call_g285_{call}", name, arguments))
                self.queue.append(LlmResponse(text="", finish_reason="tool_calls", tool_calls=tool_calls))
            else:
                self.queue.append(
                    LlmResponse(text=step["text"], finish_reason="stop", structured={"answer": step["text"]})
                )
        self.runtime, self._harness = self.process(worker=True)

    def _record(self, event: Any) -> None:
        if event.type in NAMES:
            self.events.append(event)

    def _client(self, _request: Any) -> Any:
        self.requests += 1
        if self.on_request is not None:
            self.on_request(self.requests)
        if not self.queue:
            raise RuntimeError("The scripted model has no response left.")
        return self.queue.pop(0)

    def _refuse_model(self, _request: Any) -> Any:
        raise RuntimeError("The web process never calls a model.")

    def process(self, worker: bool = False) -> tuple[Any, Any]:
        """A process: its own harness, NEW store instances, runtime and listener."""
        directory = self.directory
        owner = PrismHarness(
            drivers={
                "eph": lambda: FileSessionStore(os.path.join(directory, "ephemeral")),
                "dur": lambda: FileSessionStore(os.path.join(directory, "durable")),
            },
            stores={"ephemeral": "eph", "durable": "dur"},
        )
        events = HarnessEvents()
        events.listen(self._record)
        modes = ModeRegistry(
            {
                "default": "chat",
                "modes": {
                    "chat": {
                        "system_prompt": "You help.",
                        "tools": ["search", "weather"],
                        "max_steps": 6,
                        "requires_approval": list(self.spec["requires_approval"]),
                    }
                },
            }
        )
        tools = ToolRegistry()
        if worker:
            tools.register(Tool("search", "Found it", self)).register(Tool("weather", "Sunny", self))
        runtime = AgentRuntime(
            client=self._client if worker else self._refuse_model,
            modes=modes,
            tools=tools,
            events=events,
            config={"provider": "openai", "model": "gpt-4o"},
        )
        return runtime, owner

    def worker(self, name: str) -> Any:
        return self._harness.for_(Participant("User", name)).session("chat")

    def web(self, name: str) -> tuple[Any, Any]:
        runtime, owner = self.process()
        return runtime, owner.for_(Participant("User", name)).session("chat")


def execute(entry: dict[str, Any], directory: str) -> dict[str, Any]:
    spec = entry["input"]
    world = World(directory, spec)
    previous: str | None = None
    for turn in spec["before"]:
        world.runtime.send(world.worker(WHO[turn["who"]]), "setup")
        if turn["who"] == "same":
            previous = (world.web("Ada")[1].run() or {}).get("id")
    world.events.clear()
    world.tools_run = []
    base = world.requests
    outcomes: list[str] = []
    # The G-285 projection starts at the first cancel; earlier events are park vocabulary, kept native.
    marks: list[int] = []

    def cancel(cancels: list[dict[str, str]]) -> None:
        if cancels and not marks:
            marks.append(len(world.events))
        real = (world.web("Ada")[1].run() or {}).get("id")
        if not isinstance(real, str):
            raise RuntimeError("The subject run has no id in the store.")
        for one in cancels:
            runtime, session = world.web(WHO[one["by"]])
            outcomes.append(str(runtime.cancel(session, id_form(one["id"], real, previous)).value))

    cancel_at = spec["cancel_at"] or ""
    if cancel_at.startswith("tool:"):
        world.during = lambda: cancel(spec["cancels"])
    elif cancel_at.startswith("request:"):
        at = int(cancel_at[len("request:") :]) + base

        def on_request(request: int) -> None:
            if request == at:
                world.on_request = None
                cancel(spec["cancels"])

        world.on_request = on_request

    failure: HarnessError | None = None
    pending: str | None = None
    try:
        response = world.runtime.send(world.worker("Ada"), "go")
        approvals = getattr(response, "pending_approvals", None) or []
        pending = approvals[0].id if approvals else None
    except HarnessError as error:
        failure = error
    approval_before = None if pending is None else world.web("Ada")[1].approval_status(pending)
    if cancel_at in ("parked", "after"):
        cancel(spec["cancels"])
    cancel(spec["after"])

    decide_refused = resume_refused = None
    decisions: dict[str, str | None] | None = None
    resumes: dict[str, str | None] | None = None
    if spec["settle"]:

        def attempt(fn: Any) -> str | None:
            try:
                fn()
            except HarnessError as error:
                return str(error.code)
            except Exception as error:  # noqa: BLE001 - recorded natively, never swallowed as success
                return type(error).__name__
            return None

        decisions = {
            "record_approval": attempt(lambda: record_approval(world.worker("Ada"), pending, True)),
            "record_denial": attempt(lambda: record_approval(world.worker("Ada"), pending, False)),
            "decide_approve": attempt(lambda: world.runtime.decide(world.worker("Ada"), pending, True)),
            "decide_deny": attempt(lambda: world.runtime.decide(world.worker("Ada"), pending, False, "no")),
        }
        resumes = {
            "send": attempt(lambda: world.runtime.send(world.worker("Ada"), "")),
            "send_structured": attempt(
                lambda: world.runtime.send_structured(world.worker("Ada"), "", {"type": "object"})
            ),
        }
        decide_refused = all(value == "approval_not_pending" for value in decisions.values())
        resume_refused = all(value == "run_cancelled" for value in resumes.values())

    view = world.web("Ada")[1]
    run = view.run() or {}
    stored = view.state().get("run") or {}
    parked = spec["cancel_at"] == "parked"
    start = marks[0] if marks else 0
    projected = world.events[start:]
    texts = [step["text"] for step in spec["script"] if "text" in step]
    final = texts[-1] if texts else None
    rows = [row.message for row in view.thread().messages()]
    names = {
        call.get("id"): call.get("name")
        for row in rows
        if row.get("type") == "assistant"
        for call in row.get("tool_calls", [])
    }
    refused: list[Any] = []
    answer_kept = False
    for row in rows:
        if row.get("type") == "tool_result":
            for result in row.get("tool_results", []):
                if result.get("result") == REFUSAL:
                    refused.append(names.get(result.get("tool_call_id"), result.get("tool_name")))
        if row.get("type") == "assistant" and final is not None and row.get("content") == final:
            answer_kept = True
    cancel_events = [e for e in world.events if e.type in ("run.cancel_requested", "run.cancelled")]
    key = view.key()
    tagged = (
        None
        if not cancel_events
        else all(
            e.run_id == run.get("id")
            and e.root_run_id == e.run_id
            and (getattr(e, "parent_run_id", None) or None) is None
            and e.session_key == key
            for e in cancel_events
        )
    )
    result = {
        "outcomes": outcomes,
        "run_status": run.get("status"),
        # A parked run's stored record is park vocabulary, not cancel: compared natively.
        "stored_status": None if parked else stored.get("status"),
        "ended_as": stored.get("ended_as"),
        "error_code": code(failure),
        "model_calls": world.requests - base,
        "tools_run": world.tools_run,
        "refused_tools": refused,
        "final_answer_in_thread": answer_kept,
        "events": [NAMES[e.type] for e in projected],
        "request_states": [e.state for e in projected if e.type == "run.cancel_requested"],
        "events_tagged": tagged,
        "approval_status_before": approval_before,
        "approval_status_after": None if pending is None else view.approval_status(pending),
        "decide_refused": decide_refused,
        "resume_refused": resume_refused,
    }
    run_id = run.get("id")
    try:
        package_version: str | None = version("prism-ai-harness")
    except PackageNotFoundError:
        package_version = None
    if os.environ.get("PRISM_HARNESS_PY"):
        package_version = "development"
    native = {
        "event_names": [e.type for e in world.events],
        "projected_from": start,
        "park_stored_status": stored.get("status") if parked else None,
        "error": None if failure is None else type(failure).__name__,
        "decisions": decisions,
        "resumes": resumes,
        "run_id_shape": re.sub("[0-9a-f]", "x", run_id) if isinstance(run_id, str) else None,
        "package_version": package_version,
    }
    return {"id": entry["id"], "result": result, "native": native}


corpus = Corpus.open(str(ROOT))
results = []
for entry in corpus.suite("harness-run-cancel").cases("py"):
    if entry["skipped"]:
        raise RuntimeError("Run-cancel acceptance cannot skip a case")
    with tempfile.TemporaryDirectory(prefix="prism-run-cancel-") as directory:
        results.append(execute(entry, directory))
sys.stdout.write(
    json.dumps({"language": "py", "corpus_version": corpus.version, "results": results}, separators=(",", ":"))
    + "\n"
)
