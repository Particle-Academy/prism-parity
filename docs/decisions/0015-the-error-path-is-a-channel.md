# 0015 — The error path is a channel to the model, and guards must cover it

**Status:** accepted, 2026-08-25

Found by the `prism-mcp` agent, reviewing its own first draft. It is the worst
of four holes that review found, and it is the one that generalises.

## The hole

`prism-mcp` guards what a remote MCP server can say to the model. Results are
bounded in size, framed with a per-call nonce, and filterable — because a tool
result re-enters the model's context, and a server that returns a paragraph of
instructions has injected them.

Every one of those controls sat on the **success** path.

Prism turns a thrown tool exception into a `ToolError`, which the model reads.
So a server answering `isError: true` reached the model **unframed and
unbounded**, past both controls, through a path nobody had thought of as
output.

## The general form

**An error is not the absence of output. It is output, on a different path.**

Anywhere a guard exists on what reaches a model, a caller, or a log, ask what
the failure path carries — because it usually carries attacker-influenced
content too, and it is usually written by someone thinking about diagnostics
rather than about trust.

Three properties make this easy to miss:

- The error path is written first and reviewed least. It is scaffolding, and
  scaffolding does not feel like an interface.
- Tests assert that a failure *is* a failure. Almost none assert what the
  failure **contains**.
- The guard on the success path is visible and looks complete, which is what
  makes the gap invisible. Nothing is missing; something is bypassed.

## The rule

**A guard on output covers every path that produces output, including the
failure path.**

When you write one, enumerate the ways a value reaches its destination — return
value, exception message, error object, log line, telemetry span — and state
which are covered. If a path is deliberately uncovered, say so and why.

## Related

The same shape as [0013](0013-test-an-exception-at-its-boundary.md): a rule
holding where it is tested and bending where it is not. There, the untested
place was a reserved key; here it is the failure path.

And [0003](0003-drift-and-existence.md)'s discrimination point once more — a
guard is proven by the case that violates it, not by the case that respects it.
