# 0002 — Where idiom stops and identity begins

**Status:** accepted, 2026-08-25

## The question

How far may a port be idiomatic before it stops being the same package? A Python
client that is async-first and a PHP one that is synchronous are genuinely
different shapes. Where is the line?

## The line

**The contract is shared. The spelling is idiomatic. Idiom is free until it
changes an OBSERVABLE DECISION.**

An observable decision is anything a caller, a provider, or a stored record can
tell apart:

- what bytes go on the wire
- what an implementation does with a value it was given
- whether a field is present, absent, or present-and-null
- which failure a given misuse produces

Everything else is spelling.

## Free — spelling

| | |
|---|---|
| **Method names** | `withPrompt` in PHP and TypeScript, `with_prompt` in Python. The corpus names calls in the canonical PHP spelling and each runner maps them. The call *sequence* is the contract. |
| **Type systems** | TypeScript gets real generics and discriminated unions; Python gets full type hints and dataclasses; PHP gets its readonly classes. None of this reaches the wire. |
| **Class names** | `Text\Response` became `TextResponse` in TypeScript because a class called `Response` shadows a global. Nobody can observe the difference. |
| **Enum representation** | PHP's `ToolChoice` is a pure enum; TypeScript's is numeric; Python's is a `str` enum. All three map to the same wire strings, which is the part that is pinned. |
| **Concurrency shape** | Sync versus async is shape, not decision. A port may be async-first — provided the same calls in the same order produce the same request. |
| **Error prose** | Explicitly outside the contract. Only codes are pinned; see [0004](0004-error-codes.md). |

## Not free — decisions

| | |
|---|---|
| **Absent versus null** | PHP has ONE absent value. JavaScript has `null` AND `undefined`. Python has `None`. `max_output_tokens` is emitted as an explicit `null` even when never set, and a port that models unset as `undefined` drops the key. Different bytes, different request. |
| **Falsiness** | `0`, `""`, `"0"` and `[]` are falsy in PHP; `[]` and `"0"` are truthy in JavaScript and Python. The reference filters some keys on nullity and others on falsiness, in the same payload. Both behaviours are pinned. |
| **Container type** | `{}` and `[]` are different JSON values to every language except PHP, which cannot tell them apart at all. See [0007](0007-reference-language-limits.md). |
| **Ordering** | System prompts before messages; provider tools before user tools; tools in declaration order. Nothing errors when these change — the model just answers differently, which is the hardest divergence to notice. |
| **Number rendering** | The float `1.0` renders as `1` in PHP and JavaScript and as `1.0` in Python. Same JSON number, different bytes. Verified, not assumed. |

## When a language genuinely cannot express a case

Do **not** delete the case and do **not** fudge the port. Instead:

1. **Skip it for that language, with a mandatory reason.** The reason is enforced
   at load time in every loader, because a skip that does not say why becomes
   permanent silently.
2. **Keep the case**, because the divergence is worth recording. A deleted case
   is a divergence nobody will rediscover until it costs something.
3. **Add a new case** pinning the same rule in a form every language *can*
   express.

Two rows, one rule, divergence documented rather than discovered.

Worked example — `trq-0025` and `trq-0005`. Both pin "temperature is passed
through". `trq-0025` uses the integral float `1.0`, which Python's `json` module
renders as `1.0` where PHP and JavaScript render `1`; it is skipped for Python.
`trq-0005` uses `0.7`, which all three render identically, and is enforced
everywhere.

## And when the *reference* is the one that is wrong

Skip the reference, keep the corpus honest, and say so in the row.

`trq-0021`, `trq-0022` and `err-0003` encode the CORRECT behaviour for a falsy
prompt and are skipped for PHP, because the reference drops it. The port contract
is the golden, not the defect. The suite manifest records the gap so the
reference's green tick on that suite is not read as agreement on every row.

**Prove the divergence before writing the reason.** Every claim in this document
was tested by running all three languages, not reasoned about. One of them came
out the opposite way round from the expectation that prompted the test.
