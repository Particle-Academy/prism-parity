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
  release(task, worker, outcome)         record what happened — worker REQUIRED
  pending() -> int                       how many remain claimable
  find(id) -> ?AgentTask                 resolve an id to a task
```

`find()` was **not** in the first draft, and both ports built three methods
before the reference added it. It is not optional: `release()` takes a *task*
while every external caller — a tool, an HTTP route, a queued job — holds only
an **id**. Without it the contract cannot be driven from outside, and the
completion tool this spec requires cannot exist.

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

**Keys in DECLARATION order, and never sorted.** An earlier draft of this spec
said "keys sorted", which contradicts
[0005](../docs/decisions/0005-canonical-json.md) — an accepted decision that
pins insertion order precisely so that a mapper being rewritten shows up as its
output moving. A sort hides that. It also hides it *later*: these five keys
happen to be alphabetical, so a sort and a declaration produce identical bytes
today and would diverge silently the first time a sixth key is added.

So the record is BUILT in the order above and no sort is applied. Do not call a
sort function to arrive at it.

`claimed_by` and `claimed_until` are present-and-null when unclaimed, never
absent — [0002](../docs/decisions/0002-idiom-vs-identity.md) makes absent versus
null an observable decision, and a port modelling unset as `undefined` would drop
the keys. `claimed_until` is an integer Unix timestamp, not a formatted date,
because date formatting is exactly where three languages produce three strings
from one instant.

## Surfaced by the first implementation, 2026-09-04

The Python port landed first and hit six things this spec did not pin. They are
recorded here because a decision that lives only in one implementation is a
divergence waiting to be discovered — and because
[0004](../docs/decisions/0004-error-codes.md) pins error codes across languages,
so item 3 is binding rather than advisory.

**The reference (PHP) confirms or overrides these.** Where it overrides, the
ports follow it and this section is corrected.

1. **`release()` clears BOTH `claimed_by` and `claimed_until`** on a terminal
   task. Arguable the other way — retaining who did the work as an audit trail.
2. **Lease expiry is INCLUSIVE**: `claimed_until <= now` means expired. A
   one-tick boundary difference between ports is a real divergence, and exactly
   the kind nothing errors on.
3. **Five error codes**, identical in all three languages:
   `duplicate_task_id`, `task_identifier_blank`, `task_not_found`,
   `task_already_terminal`, `task_lease_not_held`. A volatile store reuses the
   existing `unsafe_state_configuration`; a budget-exhausted lease extension
   reuses `run_not_permitted`.
4. **A blank worker or task id is refused**, compared against `""` exactly, with
   **no trimming**. Deliberately no `trim()`: each language strips a different
   codepoint set, which is the G-36 lesson. Note `""` is falsy in PHP, so a blank
   owner would otherwise read as "unclaimed".
5. **The list is addressed at `{session.key()}:tasks`**, mirroring how the thread
   is addressed.
6. **Lease extension sets `now + granted` even when that SHORTENS an existing
   lease** — reachable only when a lease outruns the run's whole wall-clock
   allowance.

### `release()` takes the worker, and a guard in one tool is not a guard

The first draft of this spec gave `release()` two arguments. Both the reference
and one port hardened the *completion tool* instead and called the remaining gap
accepted. It is not acceptable, and the reference reversed itself:

> **A guard living in one tool leaves every other caller able to do what the
> guard forbids** — a queued job, an HTTP route, a direct call.

**No adversary is required to reach it.** Worker A's lease lapses mid-task. B
legitimately reclaims it and starts. A finishes and calls `release()`. A
overwrites B's live claim, the task reads `done` while B is still working, B's
work is discarded — and **B's own release then fails as "already terminal", so
the second worker is blamed for the first one's mistake.** Every step is normal
operation.

So the check belongs on the source, beside the rest of the state machine, and
reports `task_lease_not_held` — the same code as the lease guard, because it is
the same fact.

**Two audiences, two messages.** The exception may name the holder: a developer
reads it. The tool's refusal must name nobody: a model reads that, and the
holder's identity is not its business.

### Test the contract's guarantee against a NAIVE implementation of it

Keep the tool's own pre-check as well — and the reason is the transferable part.
Against the shipped source, deleting that check **changed nothing observable**:
the mutation *survived*, because the source already refused.

That reads like redundancy and is not. **An interface cannot make an
implementation check anything**, and a third party writing their own
`AgentTaskSource` will implement `release()` as "find it, set the state" —
because that is exactly what the signature suggests.

So the suite carries a deliberately **unguarded fixture source**, and a task
whose holder cannot be established at all, and requires the tool to refuse both
while still closing a task the worker really holds. A guarantee that only holds
because *your* implementation happens to enforce it is not a guarantee the
contract makes.

### A hole this spec had, found by building it

`release()` takes no worker. A completion tool bound only to a source therefore
lets an agent close **any** task in the list, including one another worker is
part-way through — which defeats the completion-authority rule above by going
around it rather than through it.

**The tool must require a worker and refuse any task that worker does not hold**,
and its refusal must not name the actual holder: a tool error is returned to the
model as readable text, so naming the holder leaks the list's contents to an
agent that was denied access to it.

This is the difference between asking "what did we send?" and "what can still be
invoked?" — the second question is the one that found it.

### A seventh code, because a typo must not grant the privileged outcome

`task_outcome_invalid`. The TypeScript port's completion tool began as
`args.outcome === 'failed' ? 'failed' : 'done'`, which records **done** for `{}`,
for `{outcome:'complete'}`, and for `{outcome:'DONE'}`.

That is model-supplied input coerced toward the MORE PRIVILEGED result — an
agent closing its task by mistyping, which is the completion-authority rule
defeated by a default branch. The outcome must be validated strictly and
anything that is not exactly `done` or `failed` refused.

### The lock underneath this is load-bearing, and it was broken

Found while building the TypeScript port, in code that predates this spec.
`FileSessionStore` acquired a lock with `open(..., 'wx')` and *then* wrote the
expiry. In the window between, the file exists and is **empty** — and
`Number('') === 0` read as "expired in 1970", so a waiter deleted a lock another
process was actively holding. One key, two callers. It presented as a ~1-in-8
flake.

**`claim()` atomicity rests entirely on that lock**, so a stolen lock means two
workers holding the same task — the single thing this design exists to prevent.
A capability is only as sound as the primitive under it, and this one was never
exercised hard enough to fail until something depended on it.

**There are TWO variants, and no language had both.** Checking for one and
declaring victory is how the second survives:

| | empty expiry | truncated expiry |
|---|---|---|
| TypeScript | had it (`Number('') === 0`) | **still had it after fixing the first** |
| Python | safe by accident (`float('')` raises) | **had it, and it was live** |

The truncated variant is the nastier one because it does not look like a parse
failure. **Every prefix of a ten-digit timestamp is a smaller number**, so a torn
write parses cleanly as a time in the past: `float('1735689')` is `1735689.0`,
comfortably `<= now`. Nothing errors; the lock is simply taken from a live
holder.

Python's fix is the one to copy: write the expiry in ONE unbuffered write with a
terminator, and refuse any value that is not terminated. Unreadable then means
**wait** — a loud, recoverable `session_locked` — rather than deleting somebody's
live lock. Failing safe here means waiting, never reclaiming.

### The lockfile format is SHARED SURFACE

If a PHP, TypeScript or Python worker ever runs against the same store
directory, they must agree on the byte format. Python now requires a trailing
terminator and TypeScript writes none, so Python would wait TypeScript's locks
out instead of reclaiming them. Safe direction, and still a divergence.

**The reference decides the format**, and it is an observable decision across
ports rather than an implementation detail of any one of them.

### Plant nothing you also have to read

A mutation run found a hole in Python's own lock tests: removing the terminator
from the written payload went **green**, because every test planted its lockfile
BY HAND and nothing ever round-tripped the store's own writer against its own
reader. A suite can pin a format exhaustively and still never check that the
thing under test produces it.

Any store test that constructs its fixture directly needs one companion that
writes with the real writer and reads with the real reader.

### Assert the TYPE of a stored timestamp, not its value

Mutation testing of the Python port caught 14 of 15 broken decisions. The miss:
`claimed_until` stored as a **float** passed every assertion, because
`1735689900.0 == 1735689900` is true. PHP has the same hazard inverted — `1.0`
renders as `1` — and JavaScript has no integer type at all.

Equality is not enough for this field in any of the three languages. Assert the
stored type (`Number.isInteger`, `is_integer`, `is_int`) against the raw store
payload.

## The reference's rulings

PHP landed last, read both ports, and settled the disagreements. These are
binding.

| | Ruling |
|---|---|
| Absent `outcome` on the completion tool | **Refused**, same `task_outcome_invalid` code as a malformed one. Python had it recording `done`. |
| A lease of `<= 0` | **Refused**, not clamped. TypeScript clamped to 1s. |
| Lease extension | Must check the ledger's **exhaustion**, not only `remainingSeconds`. A cancelled or step-exhausted run must not extend. |
| Lockfile expiry format | **Terminated.** Nothing else distinguishes a complete expiry from the first half of one. |
| `extendLease` on the contract | **No** — concrete source only. All three agreed. |
| `pending()` | Counts `todo` plus expired-claimed, and never writes. |
| A corrupt stored entry | **Refused**, not filtered out. A silently dropped task is work nobody will ever do. |

**On absent `outcome`, the reference's reasoning is worth keeping**, because it
overturns an argument that sounds right: *"the agent called `complete_task`, so
it meant completion"* is the **same reasoning that produced the hardcoded-`done`
bug** one level down. An agent that omits the field has not stated an outcome,
and inferring the privileged one from silence is that escalation reintroduced as
a default.

## A third lock defect, in the other store

`DatabaseSessionStore::withLock()` released by deleting the row for the key,
**without checking the row was still the one it inserted**. A worker whose TTL
lapsed while it was still inside its callback therefore deleted the lock a
*different* worker had legitimately reclaimed, and the next caller walked in
while that worker was mid-run.

**The Redis store has guarded this since it was written** — a random token,
compare-and-delete on release — and its comment names the hazard verbatim. The
database store simply never grew the guard. Two implementations of one contract,
one hardened and one not, is a shape worth looking for on sight.

The fix uses **the expiry as the token**: a reclaimer's expiry is necessarily
later, because it could only have taken the key after ours had passed and
stamped its own from that moment. Equality therefore means "nobody has taken
this since" — no extra column, and it compares on every driver where a JSON
payload column does not.

**Under SQL the truncated-expiry variant is worse, not better.** `'1735689' <
'2026-…'` is true as a **string** comparison, before anything attempts to read
either side as a date. A torn write is not merely parsed as the past — it never
reaches a parser at all.

## Mutation testing catches weak TESTS, not only weak code

Across the three ports, mutation runs caught 29 + 12 + 15 broken decisions. What
is worth recording is the ones that **survived**, because every single survivor
was a bad test rather than sound code:

- A no-trim check using **U+00A0** — which PHP's `trim()` does not strip — would
  have passed against a trimming implementation. The test proved nothing about
  the property it was named for.
- A float mutation that **never actually stored a float**, so the assertion it
  was meant to defeat was never exercised.
- A lockfile terminator dropped from the payload went green, because every lock
  test **planted its fixture by hand** and nothing round-tripped the store's own
  writer through its own reader.

A suite that has only ever passed cannot be distinguished from one that cannot
fail. Breaking each pinned decision on purpose is how you tell.

### …and the mutation harness itself can lie — in two different ways

Both ports' harnesses were wrong, and neither failure announced itself.

**Python's classified on the exit code.** It read pytest's **exit code 5 — "no
tests collected" — as "mutation caught"**, so a mutation that broke the suite
into *not running* scored as a pass, in the tool whose entire job is deciding
whether the tests work. Distinguish a real failure from a collection or compile
error. That false positive is what led to finding the unwired fixtures above.

**TypeScript's corrupted the source it was verifying, which is worse.** It
reverted each mutation by **text substitution**, and the pattern for a 4-space
`return null;` matched *inside* an 8-space one — silently rewriting `claim()`.
Twelve mutations then ran stacked on a progressively corrupted tree, so **every
verdict after the first was meaningless**. Nothing errored. The only visible
symptom was absurd failure counts (16, 18, 21 of 232) that a reader skimming for
"caught" would accept.

Two rules fall out, and a harness without both is not evidence:

1. **Revert from a byte snapshot**, never by re-substituting text. Refuse a
   mutation target that is not unique in the file.
2. **Carry a poison control** — a deliberately compile-breaking mutation whose
   expected verdict is POISONED. The old harness scored it a *pass*, which is
   exactly the signal that would have exposed both bugs on day one.

**PHP's could not see the test results at all.** Pest *colours* its summary, so
`Tests:` is followed by an ANSI escape rather than whitespace, and a `Tests:\s`
pattern matched nothing. All 32 mutations reported POISONED — and the harness
still printed **"Every mutation was caught"**, because POISONED verdicts were
never added to the problem list. Two independent bugs composing into a confident
green.

### A poison control is only as good as the runner's reaction

PHP's poison control worked and still did not help, which is the transferable
part. **A parse error in an autoloaded file is raised per-test**, so the suite
runs anyway and reports dozens of failures — which a failure-count classifier
reads as *caught*. The poison correctly reported `caught (55 failing)` and
thereby revealed that the classifier could not tell a broken mutation from a
real one.

A language whose runner **refuses to start** on broken code makes the poison
obvious. One that raises per-test hides it. So the harness needs a **syntax gate
before the suite is allowed an opinion** — `php -l`, `tsc --noEmit`, `python -m
compileall`.

Clean re-runs after all three were fixed: 21, 31 and a re-verified Python run,
every mutation caught, poison POISONED, targets unique, and **sources
byte-identical before and after**. That last check is the cheap one nobody runs.

**Treat every mutation count produced before those fixes as unverified.** Not a
weaker form of evidence — none.

### A padding fixture proves a DIFFERENT thing in every language

There is no portable list of adversarial whitespace, and a shared one is worse
than none because it looks rigorous:

| codepoint | PHP `trim()` | Python `strip()` | JS `trim()` |
|---|---|---|---|
| ASCII space | strips | strips | strips |
| U+00A0 | **leaves** | strips | strips |
| U+3000 | leaves | strips | strips |
| U+200B | leaves | leaves | leaves |

So a no-trim guarantee tested with **U+00A0 in PHP proves nothing** — the case
passes against a trimming implementation, because PHP would not have stripped it
anyway. The same fixture in Python is sharp. U+200B is useless everywhere.

Each language must pick padding its **own** trim actually removes, and assert
the codepoints it does *not* remove are preserved. The PHP port does exactly
this and says so at the fixture.

**Add a meta-test** asserting every padding value in the list is one that
language really strips, so the list cannot quietly stop being adversarial when
someone edits it.

### Confirm the adversarial cases are RUNNING

Python's `PADDED_OUTCOMES` fixture was defined and **never wired into the
parametrised refusal**. The NBSP, U+3000 and tab cases were not executing at
all — only two ASCII-space entries. A green run looks identical either way, and
it was found by listing the **collected test ids**, not by reading results.

The count of tests that ran is a fact; the count you believe you wrote is not.

### A silently accepted bad value beats a clamped one, downward

On a lease of `<= 0`, TypeScript clamped and Python **silently accepted** — and
accepting was worse: `claimed_until` landed in the past, so the claim expired
the instant it was granted and the next caller stole it. A lock that grants and
immediately releases is indistinguishable from no lock.

Refuse non-finite values **separately**: `NaN <= 0` is **false**, so `NaN`
passes a bare positivity check and detonates later.

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
