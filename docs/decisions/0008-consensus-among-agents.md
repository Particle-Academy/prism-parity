# 0008 — Consensus among agents building separate packages

**Status:** accepted, 2026-08-25

## The problem this solves

The ecosystem is about to grow several packages at once, each built by a
different agent, in a different repository, with no shared runtime and no
shared review.

That is the condition under which conventions rot fastest. Every agent will
make the same set of decisions — how to register a service provider, what a
config file is called, how a contract is named, whether a failure throws or
returns — and each will make them reasonably. Reasonable and identical are
different things, and the difference only becomes visible once two packages are
used together.

[0003](0003-drift-and-existence.md) established that a conformance corpus
guards drift and not existence. This decision covers a third thing neither
mechanism touches: **agreement about design, before any code exists to compare.**

## What does NOT work, and why

**Review.** A coordinator reading five packages cannot hold five conventions in
their head, and nothing goes red when two of them disagree. This is the same
argument [0003](0003-drift-and-existence.md) makes about discipline.

**Copying an existing package.** The first package becomes the specification by
accident, including its mistakes, and nobody can tell which parts were decided
and which were incidental. `prism-harness` shipped a Redis default that broke a
fresh install; a package copying it would have inherited that and called it
convention.

**Restating conventions in each repo.** Restated documentation drifts exactly
like restated code, and nothing tests prose. See `docs/patterns/README.md`.

## The mechanism

### 1. One source, and it is this repository

`docs/patterns/` describes the model. `docs/decisions/` records what was
decided and why. **A package repository links here. It does not restate.**

An agent starting a package reads both directories first. That is not a
courtesy — a package built without them will disagree with its siblings in ways
that only surface when an application installs two of them.

### 2. A spec exists before the package does

`specs/<package>.md`, written and reviewed **before** the agent starts.

The spec states what the package is for, what it must not do, the contracts it
exposes, the decisions already taken, and — most usefully — the questions left
open. An agent that finds an open question in its spec raises it rather than
resolving it privately, because a private resolution is how two packages end up
with two answers.

This is the same ordering as [0006](0006-goldens-from-the-reference.md) and the
same reason: something written after the fact describes what happened;
something written before it is a specification that can be disagreed with.

### 3. Cross-cutting questions are escalated, never decided locally

An agent MUST escalate rather than decide when a choice would bind another
package:

- a contract or interface another package would implement or consume
- a naming convention (`prism-*`, config key, service provider, facade)
- a storage shape another package might read
- anything the boundary in `docs/decisions/` does not already settle
- any change to `prism` core

The last one is absolute. **Core is a provider API shuttle** and stays that way;
a package that wants something from core files it and works around it in the
meantime, rather than reaching in.

Escalation goes to the coordinating agent, which either answers or takes it to
the maintainer. The answer lands in `docs/decisions/` as a numbered decision, so
the next agent to hit the same question finds it decided rather than asking
again.

### 4. Disagreement is recorded, not smoothed over

When two packages want incompatible things, the resolution is a decision
document naming both positions and why one was chosen. A convention with no
recorded alternative reads as the only option anyone considered, and the next
agent to want the other thing has no way to know it was already weighed.

### 5. The manifest is the existence check

Every package appears in `manifest/packages.json` with its role, repository,
registry name and surface. `tools/parity-check.mjs` fails when a declared
package is missing — the same existence mechanism [0003](0003-drift-and-existence.md)
established for language mirrors, applied to the package axis.

A package that is not in the manifest does not exist as far as the ecosystem is
concerned, however much code it has.

## What agreement is NOT

**Not uniformity of implementation.** [0002](0002-idiom-vs-identity.md) draws
the line for languages: idiom is free until it changes an observable decision.
The same line holds across packages. A memory package and a workflow package
will look nothing alike inside, and should.

**Not a shared base package.** A common parent is a coupling that makes every
package wait for a release of the parent. Contracts live in `prism` core when
they are wire-level, and are duplicated deliberately when they are not — with
the duplication recorded here.

**Not consensus on everything.** Only on what crosses a boundary. Anything
entirely internal to one package is that package's business, and asking about it
wastes the mechanism's credibility on decisions nobody else can observe.

## Consequence

The cost is a spec and a reading step before each package starts, and an
escalation whenever a decision would bind a sibling.

The thing it buys is that an application installing three of these packages
finds one vocabulary rather than three dialects — which is the entire premise
of the ecosystem being an ecosystem rather than a collection.
