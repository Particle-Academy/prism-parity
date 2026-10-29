from __future__ import annotations

import json
import os
from pathlib import Path

from prism_harness import AgentRuntime, FileSessionStore, LlmResponse, LlmToolCall, ModeRegistry, Participant, ParticipantAdapters, ParticipantRef, PrismHarness, RunBudget, RunContext, Subagent, SubagentRunner, ToolAuthorizer, ToolRegistry, record_approval

spec = json.loads(Path(__file__).with_name("coexistence-cases.json").read_text(encoding="utf-8"))
rows = []
for number, order in enumerate(spec["boot_orders"]):
    directory = Path(os.environ["PRISM_COEXIST_WORK"]) / f"py-{number}"
    store, tools, modes = FileSessionStore(directory), ToolRegistry(), ModeRegistry()
    counters, calls, offered = {"handlers": 0, "requests": 0, "approval_phase": False, "next_approval": False}, [], []
    participant, adapters = ParticipantRef(**spec["participant"]), ParticipantAdapters()
    adapter_calls = [0]

    def actor_adapter(_):
        adapter_calls[0] += 1
        return object()

    adapters.register(participant.type, actor_adapter)

    class Tool:
        def __init__(self, name, agent):
            self.name, self.agent = name, agent

        def handle(self, args):
            counters["handlers"] += 1
            return f"owned:{self.agent}"

    def legacy_provider(_):
        raise AssertionError("A named agent invoked the legacy provider")

    tools.register(Tool(spec["legacy_tool"], "legacy"))
    tools.register_provider(legacy_provider)
    for agent in order:
        def provider(_, current=agent):
            calls.append(current)
            return [Tool(f"remote_{current}", current)]

        tools.for_agent(agent).register(Tool("lookup", agent), agent).register(Tool(spec["omitted_tool"], agent), "harness").register_factory("context", lambda _, current=agent: Tool("context", current), agent).register_provider(provider, agent, "catalog")
        modes.for_agent(agent).register(spec["mode"], {"tools": [row["name"].replace("$agent", agent) for row in spec["expected_tools"]]}, agent).set_default(spec["mode"])

    def client(request):
        counters["requests"] += 1
        offered.append([tool.name for tool in request.tools])
        if counters["approval_phase"]:
            if counters["next_approval"]:
                counters["next_approval"] = False
                return LlmResponse(text="", finish_reason="tool_calls", tool_calls=[LlmToolCall("approval-call", spec["approval"]["tool"], {})])
            return LlmResponse(text="done", finish_reason="stop")
        tool = next(tool for tool in request.tools if tool.name == spec["positive_tool"])
        return LlmResponse(text=tool.handle({}), finish_reason="stop")

    runtime = AgentRuntime(client=client, tools=tools, modes=modes)
    harness = PrismHarness(runtime=runtime, participant_adapters=adapters, drivers={"owned": lambda: store}, stores={"ephemeral": "owned", "durable": "owned"})
    agents = []
    for agent in spec["agents"]:
        session = harness.for_agent(agent).for_(participant).session(spec["scope"])
        def snapshot():
            return sorted((str(path.relative_to(directory)), path.read_bytes().hex()) for path in directory.rglob("*") if path.is_file())

        before_files, before_requests, before_handlers = snapshot(), counters["requests"], counters["handlers"]
        calls.clear()
        inspection = runtime.effective_tools(session, spec["mode"])
        inspection_calls = calls.copy()
        inspection_safe = {"writes": int(before_files != snapshot()), "requests": counters["requests"] - before_requests, "handlers": counters["handlers"] - before_handlers}
        calls.clear()
        response = runtime.send(session, "go")
        offer_calls, actual = calls.copy(), offered[-1]
        foreign = next(candidate for candidate in spec["agents"] if candidate != agent)
        hostile_requests, hostile_handlers, errors = counters["requests"], counters["handlers"], []
        for template in spec["hostile_requests"]:
            name = template.replace("$foreign", foreign)
            try:
                runtime.send(session, "forged", [name])
                errors.append({"name": name, "refused": False, "native": None})
            except Exception as error:
                errors.append({"name": name, "refused": True, "native": {"class": type(error).__name__, "code": getattr(error, "code", None), "message": str(error)}})
        before_adapter = adapter_calls[0]
        child = harness._pending(session.participant, session.agent, session.actor).session(spec["scope"] + "::sub::worker")
        handoff = {"same_actor": child.actor is session.actor, "adapter_calls": adapter_calls[0] - before_adapter, "same_owner": child.participant is session.participant, "same_agent": child.agent == agent, "distinct_address": child.key() != session.key()}
        try:
            tools.for_agent(agent).resolve_detailed(["*"], harness.for_agent(foreign).for_(participant).session(spec["scope"]))
            foreign_registry = {"refused": False, "native": None}
        except Exception as error:
            foreign_registry = {"refused": True, "native": {"class": type(error).__name__, "code": getattr(error, "code", None), "message": str(error)}}
        agents.append({"agent": agent, "inspection": inspection, "offered": actual, "inspection_safe": inspection_safe, "inspection_providers": inspection_calls, "offer_providers": offer_calls, "result": response.text, "positive_handlers": counters["handlers"] - before_handlers, "hostile_requests": counters["requests"] - hostile_requests, "hostile_handlers": counters["handlers"] - hostile_handlers, "refusals": errors, "foreign_registry": foreign_registry, "handoff": handoff})
    collisions = []
    for test in spec["collision_cases"]:
        registry, before = ToolRegistry().for_agent("support"), counters["handlers"]

        def add(source, owner, identifier):
            if source == "static":
                registry.register(Tool("lookup", "support"), owner)
            if source == "factory":
                registry.register_factory("lookup", lambda _: Tool("lookup", "support"), owner)
            if source in ("provider", "duplicate-provider"):
                registry.register_provider(lambda _: [Tool("lookup", "support") for _ in range(2 if source == "duplicate-provider" else 1)], owner, identifier)

        native = None
        try:
            add(test["first"], test["owners"][0], "first")
            add(test["second"], test["owners"][1], "second")
            registry.resolve_detailed(["*"], harness.for_agent("support").for_(participant).session(spec["scope"]))
        except Exception as error:
            native = {"class": type(error).__name__, "code": getattr(error, "code", None), "message": str(error)}
        collisions.append({"id": test["id"], "refused": native is not None, "handlers": counters["handlers"] - before, "native": native})
    counters["approval_phase"] = True
    approval_spec = spec["approval"]
    for agent in (approval_spec["source"], approval_spec["foreign"]):
        modes.for_agent(agent).register(approval_spec["mode"], {"tools": [approval_spec["tool"]], "requires_approval": [approval_spec["tool"]]}, agent)

    def approval_session(agent, scope):
        session = harness.for_agent(agent).for_(participant).session(scope)
        session.using_mode(approval_spec["mode"])
        return session

    source, foreign = approval_session(approval_spec["source"], approval_spec["scope"]), approval_session(approval_spec["foreign"], approval_spec["scope"])
    counters["next_approval"] = True
    pending = runtime.send(source, "request approval")
    approval_id = pending.pending_approvals[0].id
    before_foreign = counters["handlers"]
    record_approval(foreign, approval_id, True)
    decision_visible = any(value["approval_id"] == approval_id and value["approved"] is True for row in source.thread().messages() for value in row.message.get("tool_approval_responses", []))
    request_visible = any(value["approval_id"] == approval_id for row in foreign.thread().messages() for value in row.message.get("tool_approval_requests", []))
    runtime.send(foreign, "")
    foreign_handlers = counters["handlers"] - before_foreign
    before_source = counters["handlers"]
    runtime.send(source, "")
    source_handlers = counters["handlers"] - before_source
    own = approval_session(approval_spec["source"], approval_spec["scope"] + ":positive")
    counters["next_approval"] = True
    own_pending = runtime.send(own, "request approval")
    own_id = own_pending.pending_approvals[0].id
    before_own = counters["handlers"]
    record_approval(own, own_id, True)
    runtime.send(own, "")
    approval = {"pending_created": len(pending.pending_approvals) == len(own_pending.pending_approvals) == 1, "foreign_decision_visible": decision_visible, "foreign_request_visible": request_visible, "foreign_handlers": foreign_handlers, "source_without_decision_handlers": source_handlers, "own_approval_handlers": counters["handlers"] - before_own, "native": {"foreign_id": approval_id, "own_id": own_id, "initial_finish": pending.finish_reason}}
    parent = harness.for_agent("support").for_(participant).session("child-authority")
    context = RunContext.root("child-authority-root", RunBudget(10))
    declaration = Subagent("worker", "Worker", spec["mode"], RunBudget(2))
    before_child_requests, before_child_handlers, before_child_files = counters["requests"], counters["handlers"], snapshot()
    child_native = None
    try:
        SubagentRunner(harness, runtime).tool(declaration, parent, context, "parent-run").handle(spec["child_request"])
    except Exception as error:
        child_native = {"class": type(error).__name__, "code": getattr(error, "code", None), "message": str(error)}
    child_authority = {"refused": child_native is not None, "requests": counters["requests"] - before_child_requests, "handlers": counters["handlers"] - before_child_handlers, "ledger_steps": context.ledger.steps, "storage_writes": int(before_child_files != snapshot()), "native": child_native}
    modes.for_agent("support").register("policy-child", {"tools": ["lookup"]}, "support")
    child_policy = []
    for test in spec["child_policy_cases"]:
        state = {"granted": test["phase"] != "offer_revoked", "offer_checks": 0, "call_checks": 0, "actor_matches": True, "model_calls": 0, "offered": []}
        before_handlers, expected_actor = counters["handlers"], parent.actor

        def offer_policy(view, tool):
            state["offer_checks"] += 1
            state["actor_matches"] = state["actor_matches"] and view.actor is expected_actor
            return state["granted"] and tool.name == "lookup"

        def call_policy(view, _tool, _args):
            state["call_checks"] += 1
            state["actor_matches"] = state["actor_matches"] and view.actor is expected_actor
            return state["granted"]

        def policy_client(request):
            state["model_calls"] += 1
            if state["model_calls"] == 1:
                state["offered"] = [tool.name for tool in request.tools]
            if test["phase"] == "call_revoked":
                state["granted"] = False
            if state["model_calls"] == 1 and test["phase"] != "offer_revoked":
                return LlmResponse(text="", finish_reason="tool_calls", cost_usd=0, tool_calls=[LlmToolCall("policy-call", "lookup", {})])
            return LlmResponse(text="done", finish_reason="stop", cost_usd=0)

        policy_runtime = AgentRuntime(client=policy_client, tools=tools, modes=modes, authorizer=ToolAuthorizer(enabled=True, agents={"support": {"offer": offer_policy, "call": call_policy}}))
        policy_context = RunContext.root("policy-root", RunBudget(10))
        result = SubagentRunner(harness, policy_runtime).run(Subagent("policy_" + test["phase"], "Policy child", "policy-child", RunBudget(2)), parent, policy_context, "parent-run", "go")
        child_policy.append({"phase": test["phase"], "offered": state["offered"], "handlers": counters["handlers"] - before_handlers, "offer_policy_checked": state["offer_checks"] > 0, "call_policy_checked": state["call_checks"] > 0, "actor_matches_parent": state["actor_matches"], "native": {"outcome": result.outcome, "requests": state["model_calls"], "ledger_steps": policy_context.ledger.steps, "kind": "runtime child loop"}})
    legacy_tools, legacy_modes, legacy_actor = ToolRegistry(), ModeRegistry(), object()
    legacy_state = {"requests": 0, "actors": []}

    def legacy_factory(view):
        legacy_state["actors"].append(view.actor)
        return Tool("actor_probe", "legacy")

    def legacy_client(_request):
        legacy_state["requests"] += 1
        return LlmResponse(text="done", finish_reason="stop", cost_usd=0)

    legacy_tools.register_factory("actor_probe", legacy_factory)
    legacy_modes.register("legacy-child", {"tools": ["actor_probe"]})
    legacy_runtime = AgentRuntime(client=legacy_client, tools=legacy_tools, modes=legacy_modes)
    legacy_harness = PrismHarness(runtime=legacy_runtime, drivers={"owned": lambda: store}, stores={"ephemeral": "owned", "durable": "owned"})
    legacy_parent = legacy_harness.for_(Participant("legacy-owner", "1")).as_actor(legacy_actor).session("legacy-authority")
    legacy_child = {}
    for identifier, arguments in (("task_only", {"task": spec["legacy_child"]["request"]["task"]}), ("extra_actor", spec["legacy_child"]["request"])):
        before_requests, before_actors = legacy_state["requests"], len(legacy_state["actors"])
        legacy_context = RunContext.root("legacy-" + identifier, RunBudget(10))
        native, refused = {"class": "str", "result": None}, False
        try:
            native["result"] = SubagentRunner(legacy_harness, legacy_runtime).tool(Subagent("legacy_" + identifier, "Legacy child", "legacy-child", RunBudget(2)), legacy_parent, legacy_context, "parent-run").handle(arguments)
        except Exception as error:
            refused, native = True, {"class": type(error).__name__, "message": str(error)}
        native["ledger_steps"] = legacy_context.ledger.steps
        actor_views = legacy_state["actors"][before_actors:]
        legacy_child[identifier] = {"refused": refused, "requests": legacy_state["requests"] - before_requests, "child_started": bool(actor_views), "actor_matches_parent": all(actor is legacy_actor for actor in actor_views) if actor_views else None, "native": native}
    rows.append({"order": order, "agents": agents, "collisions": collisions, "approval": approval, "child_authority": child_authority, "child_policy": child_policy, "legacy_child": legacy_child})
print(json.dumps(rows, separators=(",", ":")))
