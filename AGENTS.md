# AGENTS.md — prism-parity

Parity control for Prism and its language ports — and the home of the canonical
patterns and the decisions that bind the whole ecosystem.

> **[The shared guide lives here](docs/AGENTS.md)**, in `docs/AGENTS.md`, and
> every other repository's `AGENTS.md` links to it. Read it first. This file is
> only what is true of *this* repository.

## This repo is the canon, which raises the cost of being careless in it

Three things here are cited by other repositories, and by estates outside this
one:

| | |
|---|---|
| `docs/patterns/` | the model, described **once**; every port links rather than restating |
| `docs/decisions/` | binding decisions, cited by name across the ecosystem |
| `docs/AGENTS.md` | the shared half of every package's agent guide |

A change to any of them is a change to something other people's code and
documentation already point at. Edit them like published interfaces.

## It answers one question, two ways, and one cannot replace the other

**Has a port fallen behind?**

- **Drift** — `suites/`, a conformance corpus every implementation runs. Fails
  when a port produces different bytes from the reference.
- **Existence** — `manifest/packages.json` + `tools/parity-check.mjs`. Fails
  when a committed mirror is missing from a language that requires it.

A conformance corpus **cannot** catch the second: a fixture table compares two
implementations and can never fail on absence, because a missing mirror has
nothing to run the rows against. That is why there are two tools, and it is
written up in
[0003](docs/decisions/0003-drift-and-existence.md). Do not merge them.

## Goldens are executed, never written

Goldens come from **running the reference implementation** (PHP), never from
hand-authoring the expected bytes —
[0006](docs/decisions/0006-goldens-from-the-reference.md).

A hand-written golden encodes what the author *believed* the reference does. If
that belief is wrong, the corpus now enforces the mistake across every language,
and it will look like the ports are correct.

## And the corpus still cannot tell you the reference is right

The mechanism detects **disagreement**. Every implementation being identically
wrong passes — and that is the *likely* failure, because the ports were derived
from the reference.

This is the ecosystem's standing blind spot, stated in the shared guide and in
[0017](docs/decisions/0017-the-0l-report-format.md). The counter is a case that
asserts an **expected value** rather than only cross-language equality, written
down before the run. The corpus is where that belongs and it is not built yet.

Until it is, be careful with wording: "the languages agree" is true; "the
languages are correct" is a different claim the tooling does not support.

## Adding a decision

Numbered, dated, with a status line. Records **why**, not what — a decision that
only restates the rule cannot be applied to a case its author did not foresee,
and that is the entire reason to write one down.

Cite decisions by number and link. Never paraphrase one into another repository:
the paraphrase drifts, and a rule that exists in two slightly different forms is
worse than a rule that exists in none.

Amend rather than silently supersede. Something out there already cites the old
number.

## Runners and loaders

`runners/README.md` holds the subprocess CLI contract. **Every loader ships the
fixtures inside its own artifact** — a loader that fetches the corpus at test
time makes every port's suite depend on this repository being reachable, and
turns a network blip into a red build in four languages.

`scripts/cross-check.mjs` requires **identical verdicts** across runners.
`parity/ledger.json` records which runners are cross-checked and the known gaps
— an honest gap in the ledger is worth more than a green run that quietly
skipped a runner.

`VERSION` is the fixture set's own semver, printed by every runner. Bump it when
the corpus changes; a run whose corpus version is unknown cannot be compared to
another run.

## Gates

```sh
node tools/parity-check.mjs
node scripts/cross-check.mjs
```

CI runs `corpus`, `cross-check` and `loaders`.
