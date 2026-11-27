# Bench driver protocol — `prism-bench-driver/1`

**Status:** v1, 2026-11-27. The first slice of G-10 (the missing cross-language
lane-execution contract). **Implemented by:** `prism-harness` (PHP,
`bin/prism-harness-bench`). The TypeScript and Python harness drivers implement
this same protocol later; nothing here is PHP-shaped.

## What it is for

A benchmark (Terminal-Bench through Harbor, τ²-bench, anything else) owns the
task, the sandbox and the grading. A harness owns the agent loop. This protocol
is the seam between them: a **benchmark adapter** starts a **harness driver** as a
subprocess and the two exchange JSON lines over stdio. The adapter executes every
tool call itself, in the benchmark's own environment; the driver never touches
the sandbox and never sees anything the adapter does not send it.

So one adapter drives every harness, in every language, and a harness result is
comparable with a neutral agent's result on the same model, tasks and seed.

## What it must not do

- **The driver never executes a benchmark tool.** It proxies the call to the
  adapter and waits for the result. A driver that ran `bash` locally would be
  running the task on the CI runner, outside the task container.
- **The driver never runs uncapped.** `limits.max_cost_usd` is required and must
  be a positive finite number; the driver refuses to start without it. The
  harness's own per-call hard cost cap enforces it (each call is admitted against
  its worst case before any provider request). The adapter's own arm cap is the
  outer limit and is enforced from the `usage` events — two independent caps,
  because a cap enforced only by the process spending the money is enforced by
  the party with the bug.
- **No credential crosses the protocol.** The provider key reaches the driver as
  its own environment variable, set by the adapter on the subprocess only. No
  message carries a key, and the driver never echoes its environment.
- **stdout is the protocol and nothing else.** Logs go to stderr. A stray line on
  stdout is a protocol error, not noise to skip.

## Framing

- One JSON object per line, UTF-8, terminated by `\n`. No pretty-printing.
- Every message carries `"v": 1` and a `"type"`.
- A line is at most **8 MiB**. A receiver refuses a longer line rather than
  buffering it (a hostile tool output must not exhaust the driver's memory).
- Unknown **fields** are ignored, so v1 can grow additively. An unknown **type**,
  a wrong `v`, or a line that is not a JSON object is a protocol error: the
  driver emits `end` with `status: "protocol_error"` and exits non-zero.

## The exchange

```
driver  -> hello
adapter -> start
  ( ( ( driver -> tool_call                   zero or more, each answered
        adapter -> tool_result | abort )*     before the driver writes again
      driver -> usage                         one per model call
    )*
    driver -> reply                           the turn's final assistant text
    adapter -> user | close                   another user turn, or done
  )*
driver  -> end
```

The driver writes `hello` before reading anything. Every `tool_call` is answered
by exactly one `tool_result` with the same `call_id` before the driver writes
anything else. **A model call's `usage` line FOLLOWS the tool calls that call
asked for**: the harness settles a call after its tool calls have run, so the
tool calls between two `usage` lines belong to the later one. (Measured on the
PHP reference, not assumed; an adapter building per-step trajectories depends on
it.) `end` is the last line; the driver exits after writing it.

**A run may have several user turns** (τ²-bench's simulated user answers the
agent). When a turn finishes normally the driver writes `reply`; the adapter
answers `user` to continue the SAME session — same thread, same ledger, so the
cost cap and step budget are per run, never per turn — or `close` to finish. A
turn that stops (cap, step limit, abort, error) writes `end` directly, with no
`reply`. A single-turn benchmark (Terminal-Bench) answers the first `reply`
with `close`.

### `hello` (driver → adapter)

| field | type | |
|---|---|---|
| `protocol` | string | exactly `prism-bench-driver/1` |
| `driver.name` | string | e.g. `prism-harness-php` |
| `driver.harness_version` | string | the harness package version actually loaded |
| `driver.runtime` | string | e.g. `php 8.4.1` |

### `start` (adapter → driver)

| field | type | |
|---|---|---|
| `run_id` | string | `[A-Za-z0-9._:-]{1,128}`; the adapter's trial id |
| `task_id` | string | the benchmark's task name, same character set |
| `instruction` | string | the task, sent as the user turn |
| `system_prompt` | string, optional | the harness default when absent |
| `tools` | array | `{name, description, parameters}`; `name` matches `[A-Za-z0-9_-]{1,64}`, `parameters` is a JSON Schema object (`type: object`) |
| `model.provider` | string | e.g. `anthropic` |
| `model.id` | string | e.g. `claude-haiku-5-5` |
| `model.provider_options` | object, optional | passed to the provider unchanged (reasoning effort lives here) |
| `model.reasoning_effort` | string, optional | a LABEL recorded in results; it changes nothing by itself |
| `limits.max_cost_usd` | number | **required**, > 0 |
| `limits.max_steps` | integer | model calls, ≥ 1 |
| `limits.max_output_tokens_per_call` | integer | ≥ 1 |
| `pricing` | object | USD per million tokens: `inputPerMTok`, `outputPerMTok`, optional `cacheWritePerMTok`, `cacheReadPerMTok`, and `toolOverheadTokens` (required when `tools` is non-empty) |
| `approval_policy` | string | exactly `auto_grant_all` in v1 |

`approval_policy` exists because a benchmark has no human to ask. v1 knows one
policy: **every gated call is granted, and every grant is reported** as an
`approval` event, so a result never hides that approvals were automatic. A
harness that gates nothing emits none.

### `tool_call` (driver → adapter)

`call_id` (string, unique within the run), `name`, `arguments` (object, exactly
what the model sent).

### `tool_result` (adapter → driver)

`call_id` (must equal the pending call's), `output` (string, the text returned
to the model), `is_error` (boolean). A mismatched `call_id` is a protocol error.

### `abort` (adapter → driver)

`reason` (string). Sent instead of a `tool_result` when the adapter stops the run
(its arm cap, a timeout). The driver returns no further output to the model,
makes no further model call, and ends with `status: "aborted"`.

### `reply` (driver → adapter)

`text` (string): the turn's final assistant text.

### `user` (adapter → driver)

`text` (non-empty string): the next user turn. An empty one is a protocol error.

### `close` (adapter → driver)

No fields. The run is finished; the driver writes `end` with `status: "completed"`.

### `approval` (driver → adapter)

`approval_id`, `tool_call_id`, `decision` (`granted`), `policy` (`auto_grant_all`).

### `usage` (driver → adapter)

One per settled model call, whatever its outcome.

| field | type | |
|---|---|---|
| `call_id` | string | the harness's id for the model call |
| `outcome` | string | `completed`, `failed` or `abandoned` |
| `usage_known` | boolean | false when the provider reported nothing usable |
| `input_tokens` | integer | **fresh** input only, cache excluded |
| `cache_write_tokens` | integer | |
| `cache_read_tokens` | integer | |
| `output_tokens` | integer | includes reasoning |
| `reasoning_tokens` | integer or null | a breakdown of `output_tokens`, never an addition |
| `charged_usd` | number | what the harness ledger charged; when usage is unknown, the reserved worst case |

All input = `input_tokens + cache_write_tokens + cache_read_tokens`, and the
cache-read share is `cache_read_tokens` over that sum.

### `end` (driver → adapter)

| field | type | |
|---|---|---|
| `status` | string | one of the table below |
| `code` | string or null | the harness error code, when there is one |
| `final_text` | string | the last assistant text, `""` when none |
| `steps` | integer | model calls the harness admitted |
| `charged_usd` | number | the harness ledger's total |

| status | meaning | counts as solved? |
|---|---|---|
| `completed` | the model stopped by itself | the benchmark's grader decides |
| `budget_stopped` | the next call could not fit under `max_cost_usd` | grader decides, recorded `cap_stopped` |
| `step_limit` | `max_steps` was reached | grader decides |
| `aborted` | the adapter sent `abort` | grader decides, recorded `cap_stopped` when the adapter's cap fired |
| `refused` | the run never started (uncapped, unpriced, invalid start) | no |
| `error` | the provider or the harness failed | grader decides |
| `protocol_error` | a line broke this document | no |

A stopped run is still graded: the container is in whatever state the agent left
it, and the benchmark's verdict on that state is the honest one. What the
calibration plan forbids is recording a stopped run as SOLVED without the
grader, and the status makes that impossible to do by accident.

## Conformance fixture

[`bench-driver/conformance.jsonl`](bench-driver/conformance.jsonl) is one
complete exchange: `dir` says which side wrote the line, `msg` is the line.
Fields listed in a line's `volatile` array are compared for presence and type
only (versions, the harness's model-call ids). The model replies the fixture
assumes are in `bench-driver/replies.json`, in Anthropic Messages shape, so a
driver test can fake the provider and replay the adapter's lines.

`node tools/bench-driver-contract.mjs` checks the fixture against the ordering
and field rules above; each harness repo vendors the fixture and checks that its
driver produces the driver-side lines.

## Decided

- JSON lines over stdio, not HTTP: no port, no listener, nothing reachable from
  the task container.
- The adapter owns the sandbox; the driver owns the loop. Never both.
- Approvals are automatic in a benchmark and always reported.
- Two caps: the harness's per-call cap (inner) and the adapter's arm cap (outer).

## Open

- Streaming deltas (`text_delta`) — not needed for scoring; add as an optional
  type when a consumer needs it.
- Multi-modal tool results (an image from a screenshot tool) — v1 is text only.
