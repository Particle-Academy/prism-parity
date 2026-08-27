# Working in the Prism ecosystem

**The shared half of every package's `AGENTS.md`.** Each repository has its own
root `AGENTS.md` covering what is true of that repository; this page covers what
is true of all of them, and each of those files links here.

It is one page for the same reason the [patterns](patterns/README.md) are one
page: restated documentation drifts exactly like restated code, and nothing
tests prose. If a rule here is wrong, fix it **here**.

This file is harness-agnostic. It is a prompt, not a configuration format — any
agent, in any tool, can read it and follow it.

## Three kinds of documentation, and which one you are reading

Getting this wrong is how a repository ends up with three descriptions of itself
that disagree.

| | Written for | Lives in |
|---|---|---|
| **README** | someone **using** the package | the repo root |
| **AGENTS.md** | someone **working on** the package | the repo root |
| **decisions / patterns** | the **whole ecosystem** | `prism-parity/docs/` |

So an `AGENTS.md` does not explain what the package does — the README already
did, and the copy would drift. It says what must stay true while you change it.

And when you reach for an explanation of the *model* — what a pending request
is, what a provider must do with a capability it lacks — link to
[`docs/patterns/`](patterns/README.md) instead of writing it again.

## The boundary, which is the thing most worth protecting

**`prism` core is a shuttle to provider APIs. It is not an agent framework.**

Core speaks to eighteen providers. Every capability added to it is a capability
each of those eighteen carries, and must keep carrying, for as long as the
package exists. That cost is invisible at the moment a feature is added and
permanent afterwards — which is exactly the shape of decision that gets made
casually and regretted structurally.

So the question for anything that looks agentic — memory, sessions, workspaces,
tool brokering, telemetry, retrieval — is not *"is this useful?"*. It is
**"which satellite owns it?"**. The answer is never core.

The satellites exist so that answer can be "not core" without the capability
being lost:

| | |
|---|---|
| `prism-harness` | durable sessions — threads, modes, tool permissions, subagents |
| `prism-memory` | persistent context and semantic recall |
| `prism-workspace` | a sandboxed place for an agent to keep files |
| `prism-mcp` | tools from servers you do not own, across a visible trust boundary |
| `prism-perplexity` | the Perplexity endpoints that do **not** fit the provider abstraction |
| `prism-opentelemetry` | Prism's telemetry events as GenAI-convention spans |
| `prism-parity` | parity control, the canonical patterns, the binding decisions |
| `prism-ts`, `prism-py` | language ports of the text capability |
| `prism-provider-watch` | drift detection against the providers core wraps |
| `prism-labs` | the local-only testbed and the agent team (never deployed) |
| `prism-sandbox` | the public demo app (deployed, credential-light) |

A satellite depends on core. **Core depends on no satellite** — and a change to
core made to suit one satellite is the boundary failing quietly.

## Rules that bind every repository here

**Unsupported means throw.** A provider asked for a capability it does not have
raises; it never degrades quietly. A run that completes while silently doing
less is indistinguishable from a model choosing not to act, and that ambiguity
has already cost this ecosystem real debugging time — see
[0011, when silence is allowed](decisions/0011-when-silence-is-allowed.md).

**Test the shipped configuration, not your test configuration.** A suite whose
every case sets a value explicitly never exercises the default an installing
application actually receives.
[0012](decisions/0012-test-the-shipped-configuration.md) exists because a
package shipped a default that broke every fresh install, and had a green suite
while it did.

**The error path is a channel.** Anything guarded on the success path needs the
same guard on the failure path, because to an attacker they are one channel with
a boolean between them — [0015](decisions/0015-the-error-path-is-a-channel.md).

**No bandaids.** Fix the root cause. Do not pin around a vulnerable transitive
dependency when the fix is updating the parent; do not swallow an error; do not
weaken a test to make something pass. A bandaid is a hidden bug and it will
resurface, usually further from its cause.

**Decisions bind, and are cited rather than restated.** If your change
contradicts a decision in [`docs/decisions/`](decisions/), the decision changes
first — as a new decision or an amendment, in this repository, with the reason.
Code that silently contradicts an accepted decision is worse than code that
never had one.

**A behaviour change a port can see belongs in the corpus.** If you change what
core does at the boundary the ports mirror, `suites/` changes in the same
breath. Otherwise the ports drift, and the mechanism that exists to notice is
the thing you skipped.

## Gates

Every PHP package here runs the same three, and they are cheap:

```sh
composer test      # pest
composer types     # phpstan
composer format    # pint (and rector, in core)
```

**Run all three before you push.** CI runs them as separate jobs, so a local
pass on two of three reads as green right up until it is not.
`composer-require-checker` runs in CI for most packages too: it fails on a
symbol used but not declared as a dependency, which is how an *optional*
integration quietly becomes a required one.

The ports have their own:

```sh
npm test && npm run typecheck && npm run lint && npm run conformance   # prism-ts
python -m pytest -ra                                                   # prism-py
```

## Before you commit, merge, or release

Three review prompts ship in the workspace envelope under `.claude/skills/`.
They are harness-agnostic markdown — read the file and follow it verbatim if
your tool has no native slash commands:

- **`security-review`** — before pushing substantive branch work in any repo
- **`pr-security-review`** — before merging any PR, especially an upstream absorption
- **`prerelease-audit`** — before tagging or publishing a release

Each ends in PASS / PASS WITH WARNINGS / BLOCK. They are not ceremony: the
error-path hole that became decision 0015 was found by one of them, in a draft
whose suite was green.

## Filing what you learn

When something you discover outlives the run that found it — a cross-language
disagreement, a provider contradicting its own documentation, a gap that only
appears where two packages meet — file a **0L report**. The format, and why each
part of it is required, is [0017](decisions/0017-the-0l-report-format.md).

Do not file one for a routine pass. The value of the channel is that a 0L
arriving is worth reading, and that survives exactly as long as they stay rare.

## Plausible is not verified, and it does not feel like guessing

Every mechanism in this repository — the corpus, the existence check, the
fact-checker, the collapse hunter — exists to catch something a person would
otherwise act on because it seemed reasonable. So the state worth learning to
notice is not *doubt*. It is **plausibility**.

Doubt already sends you to look. Plausible does not: a name that is adjacent to
the right one, a README that seems to point that way, a manifest that matches
what you remember, a tool that got quieter after you improved it. None of those
feel like guessing, which is precisely why they get acted on.

The day this was written produced five corrections between two estates, and
every one began the same way — someone treating a plausible thing as a settled
thing:

- a server about to be moved onto a client library because the names were adjacent
- a finding filed from a tool reading that was true eleven hours earlier
- a manifest believed over the instrument that read the disk
- a rule that went quiet, read as the code getting better
- a sabotage that "passed", read from an exit code a pipe had replaced

None was carelessness and none was resolved by argument. Each moved when
somebody went and looked.

**So the operational rule is not "be rigorous".** It is: when a thing seems
reasonable and you have not checked it, say so in that sentence — *"I believe X,
I have not verified it"* — and then either verify it or hand it over labelled.
Half the corrections above came from a claim that was volunteered with its
provenance attached, which is what let the other side notice it was stale.

That second half is the stronger one, and it is easy to under-weight. "Read the
source" is a discipline, and a discipline only works while the person exercising
it is right. **A claim carrying where it came from can be checked by whoever
receives it** — so it catches the case where the careful party was careful and
wrong. Care does not survive being mistaken; a citation does.

## The blind spot to keep in view

**Cross-language agreement is not correctness.** The corpus detects
*disagreement*. It is structurally blind to every implementation being
identically wrong — which is the *likely* failure, because one implementation
was ported from another.

The counter, and it generalises well past this ecosystem: **write down what you
expect before the run, and review against that.** A prediction made in advance
can be wrong in a way a retrospective judgement cannot.

The same shape appears one level up in any lab that grades its own output, and
again in any suite that tests a contract using only fakes built from that
contract — such a suite cannot discover that the contract itself is missing
something.

## Attribution

Commits and pull requests here carry **no AI self-attribution** — no
`Co-Authored-By` for a model, no "generated with" trailer. The work is the
author's.
