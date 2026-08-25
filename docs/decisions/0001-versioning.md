# 0001 — Independent versions, plus a kit version

**Status:** accepted, 2026-08-25

## The question

Do the language ports move in lockstep — one version number across PHP,
TypeScript and Python — or does each package version independently with a
compatibility matrix saying which combinations work?

## The decision

**Independent versions per package, plus a single "kit version" naming the set
tested together.**

`manifest/packages.json` carries both: a `kit` block mapping each package to the
version this kit was tested at, and a `kit_version` identifying that set.

Today:

| Package | Language | Version |
|---|---|---|
| `particle-academy/prism` | PHP | 0.114.0 |
| `@particle-academy/prism` | TypeScript | 0.1.0 |
| `prism-ai` | Python | 0.1.0 |

Kit version `2026.08.1`.

**Packages sitting on different numbers is not drift and is not to be fixed.**

## Why not lockstep

Lockstep sounds like parity and behaves like a tax.

The slowest port gates every release. A fix that only touches PHP cannot ship
until TypeScript and Python have something to say, and since they usually do
not, what actually ships is empty version bumps in two repositories to keep a
number aligned. The number then stops meaning anything, because a matching
version no longer implies matching behaviour — it implies someone ran a release
script.

It also encodes a claim we cannot honour. The PHP package is at 0.114 with 19
providers and 10 capabilities. The ports have one provider and one capability.
Calling them all 0.114 would be an overclaim in exactly the way that
`replace: "*"` would have been for `prism-php/prism`: telling a dependent we are
compatible when we are nowhere near.

## Why a kit version rather than a matrix

A compatibility matrix across N languages is N² entries, and every one of them is
a claim someone has to test or admit they did not. The kit version does the same
job with one number: it names a set that was tested together, and
`scripts/cross-check.mjs` is what tested it.

If a combination outside a published kit works, that is a happy accident and not
a promise.

## Consequences

- A port may release as often as it likes without touching its siblings.
- "Are these two packages compatible?" is answered by finding a kit that names
  both, not by comparing version numbers.
- The **corpus** version is a separate thing again (see `VERSION`), because the
  contract can move without any implementation moving, and a port running a stale
  corpus is the failure mode this repository exists to prevent.

## The pinning rule that goes with it

**Never caret-pin the conformance dependency on a 0.x version.** A caret on 0.x
locks the MINOR: `^0.4.0` accepts 0.4.9 and refuses 0.5.0. A repository pinned
that way runs a fixture set five releases stale, stays green against a contract
that has moved on, and nobody is told — including when the release it is missing
is the one written because every runtime had got a behaviour wrong at once.

So the corpus dependency is pinned **exactly**, the fixture set **prints its own
version and content digest on every run**, and something asserts that the version
is current. A stale corpus has to be a visible fact, not an inference.
