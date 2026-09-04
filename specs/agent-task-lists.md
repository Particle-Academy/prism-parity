# Agent task lists

**Status:** specified, not built. 2026-09-04.

Not a new package. A capability in `prism-harness` and its two ports, specified
here because it must land in three languages and the shared half has to be
decided once rather than three times.

Read [`docs/patterns/`](../docs/patterns/) and [`docs/decisions/`](../docs/decisions/)
first. [0002](../docs/decisions/0002-idiom-vs-identity.md) governs this document
more than any other: **the contract is shared, the spelling is idiomatic.**

## What it is for

An agent given a goal has to keep working across many requests until the goal is
met. It needs a list of what remains, and that list has to survive the request,
the worker, a crash, and a deploy.

The hard parts are identical for every consumer and easy to get wrong:

- durable state that outlives the process
- handing one task to exactly one worker
- telling "started and died" apart from "never started"
- stopping, when the stop condition cannot be "the goal is met"

The easy part — what a task *is* — is different for every consumer, and is not
ours to decide.

## What it must not do

**It must not ship a task model, a schema, or a migration.** A consumer with an
existing `Task` table adapts it. A consumer with none gets a store-backed
default. Both satisfy one contract.

**It must not become a second workflow engine.** `fancy-flow` already ships a
graph runtime with durable queued runs, resume-from-checkpoint, human approval
and an agent node, and `prism-harness/src/Flow/` already bridges to it. A task
list that grows a scheduler, retry policy or DAG executor has rebuilt it badly.
Dependency-ordered execution is a legitimate thing to want and the answer is to
drive it from `fancy-flow` — extending `fancy-flow` where the seam is thin is
expected, not a workaround.

**It must not let an ordering decision be invisible.** See "Ordering" below.

## The shape

Two contracts. Everything else is an adapter.

```
AgentTask                       one unit of work
  id() -> string                stable, unique within its source
  instruction() -> string       what the model is asked to do
  state() -> TaskState

AgentTaskSource                 where tasks come from
  claim(worker, lease) -> ?AgentTask     atomically take the next available task
  release(task, outcome)                 record what happened
  pending() -> int                       how many remain claimable
```

`claim()` is deliberately one call. "Read the next task" and "mark it mine" as
two calls is the race this whole design exists to prevent.

### Adapters shipped

1. **Store-backed** (the default) — tasks live in the harness's own durable
   session store. No schema, no migration, works immediately.
2. **Application-model** — the consumer's own record becomes an `AgentTask`. In
   PHP this is a trait on an Eloquent model; in TypeScript and Python it is
   whatever that language's natural mixin or protocol conformance looks like.
   **This is spelling, not identity** (0002).

## The state machine — IDENTITY, pinned in all three

```
        claim()                    release(done)
  todo ---------> claimed -------------------------> done
   ^                 |            release(failed)
   |                 +-------------------------------> failed
   |                 |
   +-----------------+
      lease expires
```

Four states: `todo`, `claimed`, `done`, `failed`. No others.

**Every one of these is an observable decision and must not vary by language:**

| | |
|---|---|
| A task is `claimed` by exactly one worker at a time | Two workers calling `claim()` concurrently get different tasks, or one gets `null`. Never the same task twice. |
| A claim carries an owner AND an expiry | An expired claim returns the task to `todo`, claimable by anyone. This is what makes a dead worker recoverable. |
| `claimed` is written BEFORE the work begins | So "started and died" is distinguishable from "never started". Writing it after means a crash looks like a task that was never attempted. |
| `done` and `failed` are terminal | Re-releasing a terminal task is an error, not a silent no-op. |
| An expired claim does not become `failed` | It becomes `todo`. A worker dying is not the task failing, and conflating them burns a retry that never ran. |

### Ordering

`claim()` returns tasks in **insertion order** unless the source defines
otherwise. A source MAY expose an explicit position; it MUST NOT reorder
implicitly.

This is pinned because ordering is the divergence class 0002 calls hardest to
notice: nothing errors when it changes, the agent simply does the work in a
different sequence and produces a different result.

## Completion authority — the alignment decision

**An agent cannot mark its own task complete by default.**

If the model can set its own task to `done`, then "run until the goal is met"
silently becomes "run until it decides it is met", and a run that has stalled
will end by declaring victory. That is the same failure `prism-human-plus`
addresses by reserving confirmation for the human.

So:

- By default, `release()` is called by the APPLICATION, from evidence.
- A consumer that wants the agent to close its own tasks must register a
  completion tool and authorize it explicitly through the existing
  `ToolAuthorizer`. No new permission mechanism.
- **The default is off in all three languages.** A port that ships it on has
  changed an observable decision.

## Stopping

The loop is bounded by the EXISTING `RunBudget` — cost, turns and wall-clock —
and not by a second limit invented here. Two spellings of one idea across an
ecosystem is how a limit ends up set in the place that is not enforced.

`maxSteps` is not a budget. It bounds iterations, and a handful of steps each
calling an expensive tool sits comfortably inside it.

Budgets **nest and do not reset**: a task that spawns subagents draws from the
same remaining allowance, per `RunBudget::nestedWithin()`. A per-task budget that
refreshes is not a bound.

## Durability

The list is **durable state**, not volatile. Losing it is a correctness failure,
not a degradation to a default — a half-finished task list that vanishes on a
deploy is indistinguishable from a finished one.

The harness already draws this line with its `Durability` enum, and already
refuses to point durable state at a volatile store. This capability inherits
that rule rather than restating it: **a task source backed by a volatile store
must refuse to start.**

This is what "an agent that survives a reboot picks up where it left off"
requires. A restarted process resolves the same session, sees the same list, and
finds any task its predecessor was holding either still leased or expired back to
`todo`.

## Decisions already taken

| Question | Decision |
|---|---|
| Ship a task model? | **No.** Contract plus adapters. |
| Default storage | **Store-backed**, so the loop works with no schema. |
| Consumer's own model | Supported as a first-class adapter, not an afterthought. |
| Agent may self-complete? | **Off by default**, enabled only via an authorized tool. |
| Stop condition | The existing `RunBudget`. No new limit. |
| Dependency graphs | **Not here.** Drive `fancy-flow`; extend it if the seam is thin. |
| Claim + read | **One atomic call.** |
| Traits vs interfaces | Spelling, per 0002. PHP gets traits under `src/Concerns/`. |

## Settled here, because three agents cannot each decide them

These were the open questions. They are **observable decisions**, so leaving
them open and fanning out three implementations guarantees three answers — the
exact divergence every cross-language suite in this ecosystem has found. They
are settled here so all three ports inherit one answer. Argue any of them; do
not silently implement a different one.

**Lease duration defaults to 5 minutes, and is configurable.** Long enough for a
model call plus tool work, short enough that a crashed worker does not wedge the
list for an hour. The number matters less than it being the same number
everywhere.

**A worker MAY extend its own lease, and only while it still holds it — bounded
by the run's REMAINING WALL-CLOCK BUDGET.** This is the part worth getting
right. Unbounded self-extension is how a wedged worker holds a task forever, and
a second timeout invented here would be the duplicated limit this document
already warns against. `RunLedger::remainingSeconds()` against the `RunBudget`
is already the stop condition, so extension stops when the run's own allowance
does. Nothing new to enforce, and nothing new to forget to enforce.

**A `failed` task does NOT return to `todo` on its own.** The application
re-queues it. Automatic retry is a policy, policy needs backoff and attempt
counts, and that is the scheduler this must not become.

**`pending()` returns a COUNT.** It exists to terminate the loop, and a count is
enough for that. A listing invites the source to materialise every task on every
pass, and a consumer that wants one already has its own query.

**Canonical JSON for a task record**, per
[0005](../docs/decisions/0005-canonical-json.md), is:

```json
{"claimed_by":null,"claimed_until":null,"id":"t-1","instruction":"…","state":"todo"}
```

Keys sorted; `claimed_by` and `claimed_until` present-and-null when unclaimed,
never absent — [0002](../docs/decisions/0002-idiom-vs-identity.md) makes absent
versus null an observable decision, and a port modelling unset as `undefined`
would drop the keys. `claimed_until` is an integer Unix timestamp, not a
formatted date, because date formatting is exactly where three languages produce
three strings from one instant.

## Genuinely still open — raise, do not settle

Per [0008](../docs/decisions/0008-consensus-among-agents.md):

1. **What happens when the store is unreachable mid-claim?** The claim either
   happened or it did not, and the worker cannot tell. Retrying risks a double
   claim; not retrying risks a lost task. This needs a decision before the
   store-backed source is trusted with anything expensive.
2. **Should a task carry a payload beyond `instruction`?** Consumers will want
   structured input. Adding it invites the task to become a job, and this is not
   a queue.

## First slice

1. The two contracts and the four-state machine.
2. The store-backed source, with claim-and-lease.
3. The PHP trait for a consumer's own model.
4. A conformance corpus for the state machine — **including the adversarial
   rows**: concurrent claims, an expired lease reclaimed mid-flight, a
   re-released terminal task, and a completion attempted by an unauthorized
   agent.

The corpus is part of the first slice, not a follow-up. Every cross-language
suite written in this ecosystem so far has found a disagreement, and the two
that found the worst defects found them in exactly this kind of boundary case.
