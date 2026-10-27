"""Execute the failed-step corpus against the installed Python harness."""

from __future__ import annotations

import json
import sys
import tempfile
from importlib import import_module
from importlib.metadata import version
from pathlib import Path

from prism_harness import (
    AgentRuntime,
    FileSessionStore,
    HarnessError,
    LlmResponse,
    LlmToolCall,
    MemorySessionStore,
    ModeRegistry,
    Participant,
    PrismHarness,
    RunBudget,
    RunContext,
    ToolRegistry,
    record_approval,
)

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "loaders" / "py" / "src"))
Corpus = import_module("prism_conformance").Corpus


class Tick:
    name = "tick"

    def __init__(self, state):
        self.state = state

    def handle(self, _args):
        self.state["tools"] += 1
        return "ran"


corpus = Corpus.open(str(ROOT))
results = []
for entry in corpus.suite("harness-failed-step").cases("py"):
    if entry["skipped"]:
        raise RuntimeError("Failed-step acceptance cannot skip a case")
    with tempfile.TemporaryDirectory(prefix="prism-failed-step-") as directory:
        spec = entry["input"]
        owner = PrismHarness(
            drivers={
                "memory": MemorySessionStore,
                "files": lambda: FileSessionStore(directory),
            },
            stores={"ephemeral": "memory", "durable": "files"},
        )
        session = owner.for_(Participant("corpus", entry["id"])).session("failed-step")
        session.using_provider("anthropic").using_model("corpus-model")
        modes = ModeRegistry(
            {
                "default": "chat",
                "modes": {
                    "chat": {
                        "tools": ["tick"],
                        "max_steps": 4,
                        "requires_approval": ["tick"] if spec["guarded"] else [],
                    }
                },
            }
        )
        state = {"models": 0, "tools": 0}

        def client(_request, state=state, spec=spec):
            state["models"] += 1
            return LlmResponse(
                text='{"ok":true}',
                structured={"ok": True},
                cost_usd=0.04,
                finish_reason=spec["finish"] if state["models"] == 1 else "stop",
                tool_calls=[LlmToolCall("failed-call", "tick", {})]
                if state["models"] == 1 and spec["tools"]
                else [],
            )

        runtime = AgentRuntime(
            client=client, modes=modes, tools=ToolRegistry().register(Tick(state))
        )
        context = RunContext.root("corpus", RunBudget(4))
        failure = None
        try:
            if spec["api"] == "structured":
                runtime.send_structured(
                    session, "go", {"type": "object"}, context=context
                )
            else:
                runtime.send(session, "go", context=context)
        except HarnessError as error:
            failure = error
        run = session.run()
        rows = [row.message for row in session.thread().messages()]
        pending = sum(
            len(row.get("tool_approval_requests", []))
            for row in rows
            if row["type"] == "assistant"
        )
        result = {
            "error_code": failure.code if failure else None,
            "finish_reason": failure.finish_reason if failure else run["finish_reason"],
            "run_status": run["status"],
            "model_calls": state["models"],
            "tool_calls": state["tools"],
            "steps": context.ledger.steps,
            "cost_retained": context.ledger.cost_usd == 0.04,
            "pending_approvals": pending,
            "resumed_tools": 0,
        }
        native = {
            "error_code": failure.code if failure else None,
            "reason": failure.finish_reason if failure else None,
            "cost_usd": context.ledger.cost_usd,
            "settlement_outcome": None,
            "package_version": version("prism-ai-harness"),
        }
        record_approval(session, "failed-approval", True)
        runtime.send(session, "")
        result["resumed_tools"] = state["tools"]
        results.append({"id": entry["id"], "result": result, "native": native})
print(
    json.dumps(
        {"language": "py", "corpus_version": corpus.version, "results": results},
        separators=(",", ":"),
    )
)
