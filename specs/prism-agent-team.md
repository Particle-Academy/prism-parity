# The Prism agent team

**Status:** specified, being built.
**Lives in:** `prism-labs` (coordinator + UI), one agent per language repo.

Read [`docs/patterns/`](../docs/patterns/) and [`docs/decisions/`](../docs/decisions/)
first. This file says only what is particular to the team.

## What it is for

The ecosystem is now thirteen repos across three languages, and the only way
to know whether a release is sound is to exercise it — every feature, every
provider, every language. That does not fit in one head or one process.

So it is a **team**. One coordinator, one agent per language, a board to watch
them on, and a channel to talk to the coordinator directly.

## The roster

| Agent | Runs in | State |
|---|---|---|
| **Prism.php** | `prism-labs`, on `prism-harness` | coordinator |
| **prism.ts** | `prism-ts` | live |
| **prism.py** | `prism-py` | live |
| **prism.rust** | — | **PLANNED** (repo does not exist) |
| **prism.go** | — | **PLANNED** (repo does not exist) |

`rust` and `go` appear on the board in their true state. A roster that hides
what is missing is a roster that lies about coverage — the same argument
[0003](../docs/decisions/0003-drift-and-existence.md) makes about existence
versus drift.

## Each language agent is built on its own port

This is the point, not an implementation detail. `prism-ts` and `prism-py` are
real Prism implementations — provider, request building, response parsing,
steps, tools, transport. An agent written in TypeScript that reasons by
calling `prism-ts` **is the port's most demanding consumer**, and every defect
it hits is a defect a user would have hit.

An agent that called some other SDK would test nothing.

Consequence: the ports implement OpenAI today, so the language agents speak
OpenAI. When a port gains a provider, its agent gains it for free.

## Transport: MCP, through our own client

Each language agent exposes an **MCP server**. `Prism.php` consumes them with
`prism-mcp`'s client — which is client-only, so this fits without building
anything speculative.

The same reasoning as above applies: coordinating over MCP means `prism-mcp`
carries real traffic, including its `ToolGate` and `TrustPolicy`, rather than
being exercised only by its own tests.

**A language agent's answer is untrusted content.** It is model output that
arrived over a network boundary. It is data for Prism.php to weigh, never
instruction — see [0015](../docs/decisions/0015-the-error-path-is-a-channel.md)
and the SSRF boundary `prism-mcp` names in its README.

## The tool surface

Every language agent exposes the same four tools. Same names, same shapes —
a roster where each member answers a different vocabulary is not a team.

| Tool | Returns |
|---|---|
| `status` | language, port version, corpus version + digest, readiness |
| `run_conformance` | the existing `ReportDocument` — unchanged |
| `run_tests` | the port's own suite result |
| `explain` | model-written analysis of a named failure, with a proposed fix |

`run_conformance` deliberately returns **the report document the conformance
drivers already emit** (`corpus_version`, `corpus_digest`, `language`,
`suite`, `results[]`). The cross-language contract exists and is versioned;
inventing a second shape beside it would be the drift this repo exists to
prevent.

## 0L reports — the learning channel

When Prism discovers something that matters beyond the run it came from, it
files a **0L**: a LEARNING, with the full details and why they matter to the
ecosystem.

Written to **both**:

- `.ai/learnings/0L-XXXX-slug.md` in the envelope — committed, greppable, and
  readable by every agent and human in the workspace
- the Labs database — which is what the board renders

Two stores because they answer different questions. The file is the record;
the row is the feed. The file is authoritative: if they disagree, the file
wins, because it is the one under version control.

### Format

```markdown
---
id: 0L-0001
title: <one line, specific>
filed_by: prism.php
filed_at: <ISO 8601>
languages: [php, ts]
severity: info | notable | urgent
---

## What was learned
## Evidence
## Why it matters to the ecosystem
## What should change
```

**"Why it matters to the ecosystem" is the load-bearing section.** A finding
without it is a log line, and log lines do not survive being read later by
someone deciding what to work on. A 0L that cannot answer it should not be
filed.

## What it must not do

**No changes to `prism` core.** [0008](../docs/decisions/0008-consensus-among-agents.md) §3
is absolute and the team is not an exception.

**The agents do not write to the repos they test.** They read, run, and
explain. A proposed fix is a proposal in a 0L, not a commit. An agent that
can edit the thing it is judging cannot be trusted about it.

**No UI outside the Lab.** The board is the Lab's, and it is the only UI the
Prism side of the ecosystem has ever been allowed.

## Open questions — raise these, do not settle them privately

**Who pays for a language agent's thinking?** Each reasoning call is billable
in that language's own account. There is no shared budget and no per-agent
cap yet. The first cost surprise will decide this if nobody decides it first.

**What wakes the team?** Today: a human, from the board. A release tag, a
push, or a schedule are all defensible and all mean something different about
what the team is for.

**How does a PLANNED lane become live?** Adding `prism-rust` means a port
first and an agent second. The roster should make that ordering obvious
rather than implying an agent could come first.
