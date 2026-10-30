"""Public strict legacy opt-ins and the always-strict named mode ceiling."""
import json
import sys
from prism_harness import AgentRuntime, FileSessionStore, HarnessError, LlmResponse, ModeRegistry, Participant, PrismHarness, RegistrationCollision, ToolRegistry

store = FileSessionStore(sys.argv[1])
h = PrismHarness(drivers={"owned": lambda: store}, stores={"ephemeral": "owned", "durable": "owned"})
participant = Participant("test", "opt-in")
session = h.for_(participant).session("legacy")
named = h.for_agent("support").for_(participant).session("named")
class Tool:
    def __init__(self, name): self.name = name
    def handle(self, args): raise AssertionError("No handler expected")
def collision(fn):
    try: fn()
    except RegistrationCollision: return
    raise AssertionError("Duplicate must be refused")
strict = ToolRegistry(refuse_duplicates=True).register(Tool("inside"))
collision(lambda: strict.register(Tool("inside")))
collision(lambda: strict.register_factory("inside", lambda _: Tool("inside")))
modes = ModeRegistry(refuse_duplicates=True).register("chat", {"tools": ["inside"]})
collision(lambda: modes.register("chat", {"tools": ["outside"]}))
assert modes.resolve("chat").tools == ["inside"]
tools = ToolRegistry().register(Tool("inside")).register(Tool("outside"))
tools.for_agent("support").register(Tool("inside"), "support").register(Tool("outside"), "support")
modes.for_agent("support").register("chat", {"tools": ["inside"]}, "support")
requests = []
def client(request):
    requests.append([t.name for t in request.tools])
    return LlmResponse(text="done", finish_reason="stop", cost_usd=0)
runtime = AgentRuntime(client, modes, tools, narrow_requested_tools=True)
session.using_mode("chat")
named.using_mode("chat")
def outside(runtime, view):
    try: runtime.send(view, "outside", ["outside"])
    except HarnessError as error: assert error.code == "tool_not_available"; return
    print(json.dumps({"optIn": True, "agent": view.agent, "modeTools": ["inside"], "requested": ["outside"], "nativeRequests": requests, "handlers": 0}), file=sys.stderr)
    raise AssertionError("Request must not widen the mode")
outside(runtime, session)
assert requests == []
runtime.send(session, "wildcard", ["*"])
runtime.send(session, "empty", [])
assert requests == [["inside"], []]
outside(AgentRuntime(client, modes, tools), named)
assert requests == [["inside"], []]
print(json.dumps({"language": "py", "checks": 8, "collisions": 3, "outsideRefusals": 2, "requests": requests, "handlers": 0}))
