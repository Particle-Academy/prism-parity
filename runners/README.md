# Writing a runner

A **runner** is a small CLI in a port's repository that executes the conformance
corpus against that port and prints its verdicts as JSON. It is a subprocess
contract on purpose: `scripts/cross-check.mjs` runs every runner and requires
**identical verdicts**, which is a stronger claim than three suites that each
went green on their own.

Three green ticks are not a three-way comparison. The cross-check is.

## Invocation

```
<runner> [--suite <id>] [--probe <id>] [--root <path>] [--version]
```

| Flag | Meaning |
|---|---|
| `--suite` | Run one suite. Omitted, the runner runs every suite the corpus ships. |
| `--probe` | Run under a named probe from `probes/probes.json`. Omitted or `faithful` means the port exactly as shipped. |
| `--root` | Load the corpus from an explicit root. Omitted, the loader discovers it by walking up from its own file. |
| `--version` | Print the corpus version and exit 0. |

## Output

**stdout is JSON and nothing else.** One document per suite; a bare array when
more than one suite ran.

```json
{
  "corpus_version": "0.1.0",
  "corpus_digest": "sha256:…",
  "language": "ts",
  "suite": "openai-text-request",
  "probe": "faithful",
  "results": [
    { "id": "trq-0001", "status": "pass" },
    { "id": "trq-0021", "status": "skip", "reason": "…" },
    { "id": "trq-0008", "status": "fail", "expected": "…", "actual": "…" }
  ]
}
```

`status` is exactly one of `pass`, `skip`, `fail`. Every case in the suite gets
a row, **including skipped ones** — a skip that vanishes from the report is a
suite that quietly shrank.

**stderr is for humans.** Print the corpus version and root there on every run.
A port pinned to a stale corpus otherwise stays green against a contract that
has moved on and nobody is told.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Every case passed or skipped |
| 1 | At least one case failed |
| 2 | The corpus failed to load — stdout carries `{"error_code": "…"}` |
| 3 | The runner could not start (missing dependency, no build) |

Under `--probe`, a mutant is *expected* to fail cases, so the caller — not the
runner — decides whether the run was correct. Keep the exit codes above as-is
and let `scripts/cross-check.mjs` and the port's own probe test do the judging.

## Rules a runner must follow

1. **Use the published loader.** Do not re-implement case loading. Four
   consumers elsewhere wrote private loader copies and two shared a silent bug —
   they read a per-language `skip` as a truthy scalar, which skipped every
   language at once *and* made the blank-reason guard unreachable, because a
   non-empty map is never blank. Both effects were invisible; both builds stayed
   green.

2. **Never resolve fixtures relative to a sibling checkout.** The loader ships
   the corpus inside its own artifact and finds it by walking up from its own
   file. A hard-coded `../../` works in exactly one directory layout and
   silently no-ops everywhere else, including CI, which checks out one repo.

3. **Report skips with their reason.** The reason is mandatory in the corpus;
   carrying it through to the report is what keeps a skip visible.

4. **Compare with the loader's `compare`.** Byte equality on the canonical JSON
   string, with a per-case `tolerance` only when the row declares one. Do not
   invent a comparison rule: a loader can assert something the reference
   language cannot express, and no amount of green ticks will surface it.

5. **Map builder-script method names to your idiom, not the other way round.**
   The corpus names calls in the canonical (PHP) spelling. `withPrompt` is
   `with_prompt` in Python. The call *sequence* is the contract; the spelling is
   not.

## Installing the loader — the ordering that bites

**Install the loader LAST.**

The loader is not published yet, so it is installed from a path
(`npm install ./.parity/loaders/ts --no-save`, `pip install ./.parity/loaders/py`).
A `--no-save` npm install leaves the package *extraneous*, and **any later
`npm install` prunes it**. Run the loader install after every other install step,
in CI and locally, or the conformance job will find no loader.

This is the same family of failure as caret-pinning a 0.x conformance
dependency: the mechanism is correct and silently not running. Both produce a
green build against a contract nobody actually loaded.

So the runner must **detect its own absence**:

- If the loader cannot be imported, exit **3** with a message saying so. Do not
  fall back, and do not carry a vendored copy of the corpus for this case.
- If the corpus loads but yields **zero suites**, that is a failure too, not a
  vacuously successful run. A runner that reports nothing must not report
  success.

## Probes

`--probe <id>` runs the port with one deliberate defect injected, named in
`probes/probes.json`. Each probe declares the **exact** set of case ids it must
fail. The port's own test asserts that the observed failure set *equals*
`corpus.expectedProbeFailures(probeId, language)` — not that it is non-empty.

The `faithful` probe is the **control**, and it is not optional: without an
implementation that passes everything, the mutants prove only that the port is
broken.

### A mutation is a TRANSFORM over real output, never a re-implementation

Implement each mutant as a small transformation applied to what the real library
produced — drop these keys, reorder that list, skip this subtraction. Never as a
second code path that rebuilds the payload itself.

A mutant that rebuilds the body drifts for reasons unrelated to the mutation, and
from then on the probe measures the mutant rather than the library. The failure
set it produces is then a fact about test-support code, and the exact-set
assertion that was supposed to be a measurement becomes a description of
whatever the copy happens to do.

The nicest expression of this we have: `prism-py`'s `keep-empty-tools` mutant
wraps the real `build_tools` output in a list subclass whose `__bool__` is always
`True`. The collapse-to-null stops happening, nothing is re-implemented, and the
hazard is stated as a **type** rather than as a branch. Reach for that shape when
you can.

### A probe's declared scope is part of its contract

If a probe says `"scope": "value object serialization"`, applying the same defect
globally is a *different* probe, not a better version of this one. Widening the
behaviour to match a wider intuition makes the declaration wrong. Add a second
probe with its own scope and its own declared set — that is what
`omit-null-on-serialize` and `omit-null-on-parse` are.

### When the corpus and the measurement disagree

Work out which is right; do not assume either. If the corpus is wrong, say so and
get it corrected **upstream** — a port must never edit the corpus to match its
own output, because that turns the check into a tautology.

A port that needs to run before the correction lands should carry the pending
corrections as an explicit, reviewable list, and assert that each correction is a
strict **superset** of the declared set. That invariant is the point: a
correction can only ADD expected failures, never launder away a declared one.

## Windows

`php` installed via a shim (Herd, for instance) cannot be spawned from Node.
`scripts/cross-check.mjs` resolves an absolute path to a real `php.exe`; set
`PHP_BINARY` if discovery fails.
