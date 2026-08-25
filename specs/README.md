# Specs

One file per package, written **before** the package exists.

A spec states what the package is for, what it must not do, the contracts it
exposes, the decisions already taken, and the questions left open. An agent
building from a spec raises the open questions rather than resolving them
privately — see [0008](../docs/decisions/0008-consensus-among-agents.md).

Every agent reads `docs/patterns/` and `docs/decisions/` before its own spec.
The spec says what is particular to one package; those say what is true of all
of them.

## The set

| Spec | Package | Fills |
|---|---|---|
| [prism-memory.md](prism-memory.md) | `prism-memory` | persistent context, semantic recall, vector storage |
| [prism-rag.md](prism-rag.md) | `prism-rag` | document ingestion, chunking, retrieval |
| [prism-workspace.md](prism-workspace.md) | `prism-workspace` | sandboxed filesystem, code execution, skill files |
| [prism-mcp.md](prism-mcp.md) | `prism-mcp` | Model Context Protocol, server and client |

## What is deliberately NOT being built

**`prism-workflow` — a workflow engine.**

Mastra has one and the gap analysis flagged it, so the obvious move is to build
one. It is the wrong move.

A graph engine with durable runs, checkpoints and human-approval pauses is
**app plumbing, not AI**. The boundary is explicit: Fancy owns plumbing, Prism
owns the AI side. And Fancy already ships `fancy-flow-php` — a PHP runtime for
workflow graphs with queued durable runs, resume-from-checkpoint, human
approval and `user_input` pauses, **and an agent node**.

Building a second one would duplicate a working engine, split the ecosystem's
workflow story across two brands, and put Prism on the wrong side of its own
boundary.

**What is actually needed is the seam**: making sure `fancy-flow`'s agent node
can drive a Prism agent well — a harness session, a thread, tool permissions.
That is work in `prism-harness` and a conversation with the Fancy team, not a
new repository.

Recorded here because the gap is real and someone will propose filling it
again. The answer is that it is already filled, by the package that should own
it.

## Where the gaps came from

The Mastra capability comparison, run through the Lab's own research tool. What
Prism already had — model routing, tools, human-in-the-loop, observability —
is not repeated here. These four are what it did not.
