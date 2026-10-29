"""Public APIs shared by published0.3.0 and the candidate; preserve native defaults."""
from __future__ import annotations
import json
import sys
from prism_harness import AgentRuntime, FileSessionStore, LlmResponse, ModeRegistry, Participant, PrismHarness, ToolRegistry

store = FileSessionStore(sys.argv[1])
harness = PrismHarness(drivers={"owned": lambda: store}, stores={"ephemeral": "owned", "durable": "owned"})
session = harness.for_(Participant("legacy", 7)).session("initial")
rows = {}

class Tool:
    def __init__(self, name, label):
        self.name, self.label = name, label
    def handle(self, args):
        return self.label

def resolved(registry):
    return [[key, tool.name, tool.handle({})] for key, tool in registry.resolve(["probe"], session).items()]

rows["duplicate_static"] = resolved(ToolRegistry().register(Tool("probe", "first")).register(Tool("probe", "second")))
rows["duplicate_factory"] = resolved(ToolRegistry().register_factory("probe", lambda _: Tool("probe", "first")).register_factory("probe", lambda _: Tool("probe", "second")))
rows["duplicate_providers"] = resolved(ToolRegistry().register_provider(lambda _: [Tool("probe", "first")]).register_provider(lambda _: [Tool("probe", "second")]))
for order in ("sf", "fs", "sp", "ps", "fp", "pf", "sfp", "pfs"):
    registry = ToolRegistry()
    for kind in order:
        if kind == "s":
            registry.register(Tool("probe", "static"))
        elif kind == "f":
            registry.register_factory("probe", lambda _: Tool("probe", "factory"))
        else:
            registry.register_provider(lambda _: [Tool("probe", "provider")])
    rows["precedence_" + order] = resolved(registry)
rows["factory_name_mismatch"] = resolved(ToolRegistry().register_factory("probe", lambda _: Tool("other", "legacy-mismatch")))
requests = []

def client(request):
    requests.append([tool.name for tool in request.tools])
    return LlmResponse(text="done", finish_reason="stop", cost_usd=0)

runtime = AgentRuntime(client, ModeRegistry({"default": "chat", "modes": {"chat": {"tools": ["inside"]}}}), ToolRegistry().register(Tool("inside", "inside")).register(Tool("outside", "outside")))
runtime.send(session, "widen", ["outside"])
runtime.send(session, "empty", [])
rows["caller_lists"] = requests
assert requests == [["outside"], ["inside"]]
initial = session.key()
session.participant = Participant("legacy", 8)
changed_id = session.key()
session.scope = "changed"
changed_scope = session.key()
rows["mutable_legacy"] = {"id_changes_key": initial != changed_id, "scope_changes_key": changed_id != changed_scope, "scope": session.scope}
assert rows["mutable_legacy"]["id_changes_key"] and rows["mutable_legacy"]["scope_changes_key"]
print(json.dumps(rows, separators=(",", ":"), ensure_ascii=False))
