# CI evidence alignment

Run `node tools/alignment.mjs` from this repository. The coordinating alignment job
runs before the corpus, cross-check, loader and factcheck jobs. It runs the
regression tests, corpus guards, copy check, trust rubric and parity inventory
check, then compares published metric claims with freshly computed values.

## Published counts

Write a produced count as an HTML comment-delimited metric claim. The comments
are hidden in rendered Markdown; the number remains visible. For example, the
metric key `security.corpora` obtains its value from `trust-rubric.mjs --json`.
`node tools/alignment.mjs --write` updates marked values. Normal execution never
rewrites them and reports a mismatch with its file, line, old value and new value.

Claims are discovered in `README.md`, `AGENTS.md` and Markdown under `docs/`.
Unknown keys and incomplete markers fail. Common unmarked inventory/count
phrases and suite-table totals also fail, to catch an added claim that omitted
its marker. This syntax check does not understand arbitrary English: reviewers
must identify new produced counts and mark them. Historical incidents, numerical
examples and rubric thresholds are not current inventory claims.

The family count describes declarations with a suite, not executed parity. The
security count describes suites selected by the rubric, and the adversarial count
uses that rubric's note classifier. Neither proves the implementations ran or
that adversarial inputs are covered completely. Stored golden rows are inventory;
only runner verdicts establish verified cases. Runtime coverage is deliberately
not copied into a static document without an execution report.

## Runner and skip evidence

`guard-corpus.mjs` checks declared local runner files. A non-full implementation
must name its cause and gap. External runner locators are printed as
`UNVERIFIED` by the local guard, even when a developer happens to have the sibling
checked out. The remote phase below checks those public repositories separately.

The cross-check's coverage is independently reconciled with per-language runner
results. Every reported skip must retain its language, case and reason. A skipped
or absent row cannot contribute to verified agreement. A suite skipped in every
language fails, including when other suites passed. The regression tests exercise
these mixed cases rather than only an entirely empty run.

## Gate execution evidence

Gate steps use `tools/run-gate.mjs`. It runs the command without shell expansion,
preserves its output and requires both a successful exit and the gate's own
verdict. Commands that do nothing, crash, time out, or print no expected verdict
fail. Where the verdict contains a work count, that count must be positive.
Install/setup steps are not classified as test gates.

The verdict patterns are declared in `tools/gate-contracts.mjs`. A tool changing
its output must update its contract and regression tests in the same change.
This proves the expected output was emitted, not that a malicious tool could
never print a fabricated verdict. Tests and review still establish what the
producer actually checks.

## Public repositories

Run `node tools/remote-alignment.mjs` with authenticated `gh` access. CI uses its
built-in read-only token; no personal access token or package checkout is needed.
The alignment workflow runs daily at 06:20 UTC, on pushes and pull requests, and
on manual dispatch. It then calls the existing corpus, cross-check, loader and
factcheck workflows, all depending on successful alignment. Those workflows are
reusable only: the remote audit runs once, rather than repeating the same API
reads in each workflow. The daily event still enables factcheck's strict currency
check and runs the cross-check against the moving ports.

The audit resolves each claimed repository's `main` to a commit, prints that SHA,
and uses it for all contents requests in that repository. Shared runner files
are fetched once but assessed separately for each suite claim. A confirmed 404
counts as missing. Authentication, rate-limit, network and decoding failures are
unresolved and fail the job; they never count as verified or missing files.

Every full runner must mention its suite identifier or a discovered vendored
fixture filename. This is evidence of a reference, not proof of execution: a
comment can mention a suite, and a generic runner may read it through a loader
without a literal identifier. Such a generic runner fails this lexical check
rather than receiving an inferred exemption. Review a failure against the
reported source file before changing a claim.

A recursive tree listing discovers `cases.json`, suite-named and corpus-named
JSON files, literal JSON filenames referenced by runners, and byte-identical
aliases identifiable by their Git blob hash. The contents API fetches candidates;
their `suite` field identifies the canonical document. The audit shares the
local synchronizer's byte comparison and SHA-256 diagnostic helper. Whitespace
changes are drift too. A truncated tree or unreadable candidate fails discovery.
Canonical `suites/<id>/cases.json` sources in parity are excluded from the
vendored-copy count; loader copies in that repository are still checked.
An arbitrarily renamed, modified JSON file referenced only through a dynamically
computed helper path cannot be identified reliably by static inspection; keep
vendored copies identifiable by these names or direct references.

The summary separates checked claims from declared claims, reports verified
claims, missing files, full runners without corpus references and unresolved
claims, and separately counts matched and stale corpus copies. Existence and
lexical reference verification never count as executed test coverage.

## What these checks cannot verify

The contents API does not execute package tests or prove that a source reference
is reached. It also cannot establish that a `G-NN` register entry describes
current code, a handoff is current, or an external version claim matches a
release. Executing package tests needs pinned checkouts and dependencies. The gap
register and handoffs need their owning envelope as an input and a defined
revision to compare. `tools/tests-wired.mjs` remains an envelope check; none of
these facts is represented as verified by the remote contents audit.
