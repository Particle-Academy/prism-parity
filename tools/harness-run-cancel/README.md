This suite runs eleven scripted runs through each language's real harness runtime and
cancels them from another process (G-285). The cancel comes from a second session object
with its own store instances over one shared durable backing: PHP uses two
`DatabaseSessionStore` instances over in-memory SQLite, and TypeScript and Python use
`FileSessionStore` instances over a temp directory. The model is scripted: PHP uses Prism's
real OpenAI handler on faked HTTP with stray requests refused, and the ports use their
client callback with fetch and sockets refused.

**No golden is recorded, because none can be yet.** Goldens come only from published
artifacts (decision 0006), and no harness release in any language carries G-285.
`tools/run-cancel-contract.mjs` holds `PUBLISHED = { php: null, ts: null, py: null }`, and
until each entry names a real registry release, `tools/run-cancel-corpus.mjs` refuses every
mode except `--development`. That mode checks candidate runtimes and never writes. The
manifest marks every language `partial` with cause `unpublished`, and every result column
is `null`, and no row carries `agrees`. `validate-cases` refuses a recorded column beside a partial
manifest, and an `agrees` claim on an unrecorded row.

```sh
PRISM_HARNESS_PHP_RUNNER=<prism-harness checkout> \
PRISM_HARNESS_AUTOLOAD=<prism-harness checkout>/vendor/autoload.php \
PRISM_HARNESS_TS=<directory holding a built dist/ and its package.json> \
PRISM_HARNESS_PY=<prism-harness-py>/src \
node tools/run-cancel-corpus.mjs --development
```

`PRISM_RUN_CANCEL_LANGUAGES=php` (or `ts,py`) runs a subset, in development only.

**The shared projection.** `outcomes` lists every `cancel()` return value. Then come the
run's read status, its stored status and `ended_as`, the error code, model calls, the tools
that ran in order, the tools refused with `Not run: the run was cancelled.`, and whether the
script's last answer is in the thread. After those: the events normalised to
`cancel_requested`, `cancelled`, `finished` and `failed`, the request event's `state`,
whether every cancel event carries the run's tags, and the approval status before and after.
The last two say whether every decision path and every empty-prompt resume was refused.
Each language's own vocabulary goes in `native`: event names, the error class, per-path
decision and resume codes, the run id shape and the package version.

**Decided out of scope (2026-11-25).** A parked run's stored record is not compared, and it
is recorded natively as `park_stored_status`. `cancel()` on a parked run rewrites no run
record in any language, and the read is what consumers see. Events are projected from the
first cancel onward. Both differences predate G-285 and concern how a parked run is
represented: PHP stores `completed` and emits `RunFinished` at park time, while the ports
store `running` and emit nothing at park.

**The id forms** (`id-forms.mjs`, mirrored in the PHP runner and `runner.py`) derive each
hostile id from the live run id at run time: a forged id that is one character off, plus
empty, truncated, extended, a `../` prefix, upper case, a trailing newline, a space after
and before, a zero-width space, a no-break space, a NUL and a Cyrillic lookalike. Those bytes
exist only at run time, so the trust rubric's identifier-bytes criterion cannot see them in
`cases.json`. They are named by form instead, and the contract requires every one to be
refused.

**When the releases exist:** set `PUBLISHED`, add `package.json` and `pyproject.toml` pins
here with their allowlist step, add a `runCancel` gate to `tools/gate-contracts.mjs` and a
goldens-job step beside `failedSteps`, run `--record`, and set each language `full`.
