# 0021 — Parity is the shipping-library set

**Status:** accepted, 2026-08-30

## The problem

The first parity kit compared one vertical slice of core: text, OpenAI and the
value objects that cross that boundary. Both ports passed it. That result was
true and easy to over-read: PHP carried twelve core capabilities, eighteen
providers and eight shipping satellites while the TypeScript and Python ports
each carried one capability, two providers and no satellites.

A green core slice is not the workflow parity an agent experiences when it uses
Prism to build an application.

## Decision

The coordinated parity target is the set of reusable shipping libraries:

- core
- browser
- harness
- human-plus
- mcp
- memory
- opentelemetry
- perplexity
- workspace

Labs and documentation/demo applications are consumers, not packages to port.
`prism-parity` is the shared control plane and provider-watch is shared
infrastructure; neither is cloned per language.

`manifest/packages.json` records an immutable PHP baseline and a PHP,
TypeScript and Python implementation for every family. `planned` means the gap
is acknowledged and no implementation is claimed. `in-progress` means a real
repository exists but is incomplete. `shipped` requires a repository and is the
only state admitted by the coordinated launch gate.

No public TypeScript or Python package from this parity program is released
until every family is shipped and the exact versions are recorded in one kit.
Private/local prerelease artifacts may be used by Prism Labs to make progress
measurable.

## Workflow runtime

Fancy Flow is the workflow runtime for durable execution, approvals,
pause/resume, cancellation and subagent orchestration. Prism does not adopt a
second workflow engine when a Fancy Flow language runtime is absent. The gap is
owned and fixed in Fancy.

This does not move workflow behavior into Prism core. Core remains the provider
API shuttle and may perform its bounded request-level tool loop. Harness
composes single-step core calls into durable Fancy Flow runs.

## Language shape

Observable behavior, security boundaries and general workflows match. Internal
class layout does not:

- TypeScript uses promises, async iterables, discriminated unions and abort
  signals.
- Python is async-first for I/O-heavy satellites and provides sync facades. Its
  core keeps its zero-required-runtime-dependency constraint.
- PHP remains the executable reference and keeps PHP 8.2 support.

Existing 0.1 entrypoints are preserved where sound. A pre-1.0 break is allowed
only for correctness or native async behavior, and is recorded rather than
smoothed over.

## Consequence

The old three-mirror check remains useful, but it can no longer be presented as
the ecosystem finish line. The parity report always prints the package-family
target and its remaining implementation gaps beside the core drift report.
