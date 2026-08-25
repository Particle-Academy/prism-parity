# 0006 — Goldens come from running the reference

**Status:** accepted, 2026-08-25

## The rule

**Every golden is produced by EXECUTING the reference implementation. None is
hand-authored, and none is reasoned about.**

`tools/generate-goldens.php` drives the real `particle-academy/prism` — the
released package installed by composer, not a working copy — through each case's
builder script, and writes what comes back.

## Why not just write down what the value obviously is

Because "what the value obviously is" and "what the code actually produces"
diverge exactly where it matters.

The formatting of `1e300` is 301 digits and is *not* a 1 followed by 300 zeros,
because the nearest double to 10^300 is not 10^300. A first draft elsewhere
asserted the round number and was wrong — a golden that pinned the author's model
of the code rather than the code.

Our version of that is everywhere in this corpus:

- `prompt_tokens` is not `input_tokens`. It is `input_tokens` minus the cached
  count (`trs-0002`: 1024 − 896 = **128**).
- A JSON Schema property renders `description` **before** `type`, decided by the
  schema value object rather than by the tool mapper (`trq-0009`).
- An empty map serialises as an empty **array** (`rtp-0009`).
- A tool's `strict: false` vanishes while a provider option's `store: false`
  survives, in the same payload (`trq-0010`, `trq-0016`).

Every one of those is something a careful author would have written down wrongly,
and every one was correct on the first generated run.

## Two consequences the generator enforces

### A row the reference cannot run needs a hand-authored golden, deliberately

When a case is skipped for the reference language, there is no reference
behaviour to record. The generator **refuses** to leave such a row on the
`@generate` placeholder and stops with an explanation.

That guard fired on the first run, for `trq-0021`. It is what forces a human to
decide what the correct behaviour *is*, and to write the reasoning into the
row's notes, rather than letting an unrunnable case quietly carry nothing.

Three rows are hand-authored today, all of them for the same reason: the
reference is wrong (finding F-2) or cannot express the value (finding F-3). Each
says so in its notes and in its suite manifest.

### `--check` mode fails rather than rewriting

CI regenerates in `--check` mode. A golden that no longer matches what the
reference produces is a **failure**, not a silent rewrite.

That failure is the signal. Either the reference changed behaviour — which is
exactly what a parity repository exists to notice — or somebody edited a golden
by hand. Both need a human, and a generator that quietly re-blessed the new
output would hide both.

## The reference must be a released artefact

`runners/php/composer.json` requires `particle-academy/prism` from Packagist, not
a path repository pointing at a checkout.

A golden generated against a working copy describes somebody's uncommitted
branch, and nobody else can reproduce it. Today's goldens come from **v0.114.0**,
recorded in `manifest/packages.json`.

## And the limit that comes with it

A golden cannot encode a distinction the language that produced it cannot hold.
PHP cannot tell `{}` from `[]`, so no PHP-authored golden here is authoritative
about container type. That is written up in
[0007](0007-reference-language-limits.md), and it is why one suite carries raw
JSON strings instead of generated goldens.
