# Specs

One file per package, written **before** the package exists — or, where a
capability spans an existing package and its ports, one file for that
capability, written before it is built. The reason is the same either way:
the shared half gets decided once instead of three times.

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
| [prism-agent-team.md](prism-agent-team.md) | *(the Lab + one agent per language)* | ecosystem-wide testing team, coordinated by Prism.php |
| [agent-task-lists.md](agent-task-lists.md) | *(a capability in `prism-harness` + both ports)* | durable task lists, claim-and-lease, running until a goal is met |

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

**Read that as "do not build a SECOND one", never as "graphs are out of
scope".** The distinction has already misled a reader of this file: a design was
nearly narrowed to a flat list on the strength of the paragraph above, turning a
statement about where a capability LIVES into a statement that it may not exist.
A graph runtime is wanted. It is `fancy-flow`.

Which means **extending a Fancy package to serve a Prism capability is expected
and optimal, not a workaround.** If a needed capability is blocked by a rule
written here, argue the rule rather than scoping the work down to fit it.

## Where the gaps came from

The Mastra capability comparison, run through the Lab's own research tool. What
Prism already had — model routing, tools, human-in-the-loop, observability —
is not repeated here. These four are what it did not.
