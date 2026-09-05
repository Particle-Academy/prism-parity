# 0007 — What a PHP-authored golden cannot say

**Status:** accepted, 2026-08-25

Every golden in `suites/` except one is produced by **executing PHP**. That is
the right way to make goldens (see [0006](0006-goldens-from-the-reference.md)),
and it has a consequence that has to be written down rather than discovered:

> **A golden cannot encode a distinction the language that produced it cannot
> hold.**

PHP is exact where JavaScript is not, and blind where both others can see. Both
directions are live for us, and both are pinned in
`suites/json-container-identity/`.

## Limit 1 — PHP cannot tell `{}` from `[]`

```php
json_decode('{}', true) === json_decode('[]', true)   // true
```

Verified, not assumed. PHP has one array type, so an empty JSON object and an
empty JSON array decode to the identical value, and re-encode identically. The
same limit appears on the way out: a map-typed field serialises as `[]` when
empty and as `{}` when populated — **the same field changes JSON type with its
contents**.

Node and Python both distinguish the two.

This is not academic. JSON APIs distinguish them constantly: empty tool arrays,
empty content lists, empty metadata objects. The reference itself works around it
at the send boundary, with `?: (object) []` guards duplicated across eight
provider message maps — so an empty tool-call argument set goes out as `{}`
rather than `[]`. A ninth provider added without that guard would send `[]` and
be rejected, and nothing would catch it.

**How the corpus handles it**

- `jci-0001` states the distinction as two RAW JSON STRINGS and asks each
  implementation whether its own parser tells them apart. PHP is skipped, because
  it cannot answer.
- `trs-0006` and `rtp-0009` isolated the serialisation side. Every *other* row in
  those suites deliberately carries a NON-EMPTY map so the ambiguity contaminated
  two rows instead of forty. **Both are un-skipped as of 2026-09-04.**

**F-3 is FIXED, and the recommendation this document used to give was half of the
answer.** It said "cast map-typed fields to objects". That is *key-aware*: it
works where you know which fields are maps, and it does not reach a `{}` nested
arbitrarily deep inside arbitrary JSON. Building it found the rest.

The naive generalisation is worse than the narrow rule, not better. Promoting
EVERY empty array to an object renders the entirely ordinary `"required": []` as
`{}` — trading one silent divergence for a commoner one.

**Two mechanisms are needed, and the distinction between them is the finding:**

| | for | why the other one cannot do it |
|---|---|---|
| **key-aware** (`JsonMap`) | fields the package *declares* to be maps and defaults to empty | A `UserMessage` built with no `additionalAttributes` was never decoded from anything. **There is no input to carry**, so the declaration is the only evidence there is. |
| **decode-boundary** (`Json::decode(preservingContainerTypes: true)`) | arbitrary JSON from a provider or a tool | Reaches a `{}` nested at any depth, under keys nobody enumerated. Nothing is inferred: the distinction is carried from the input rather than guessed at the output. |

`json_decode($raw, true)` is the line that throws the information away.

**The prediction in this document came true four times before anyone looked.**
It warned that "a ninth provider added without that guard would send `[]` and be
rejected". When the guards were removed, **four send sites had never had one** —
Azure, OpenAI ChatCompletions and Qwen on tool-call arguments, and OpenAI
ChatCompletions on tool schemas. Fifteen duplicated guards were deleted and
replaced by accessors, and the test that covers them **discovers** the provider
maps from the filesystem, so provider #16 is covered without anyone remembering.

### The same limit applies on the INPUT side, and this document did not say so

Un-skipping `rtp-0009` immediately caught `prism-py` emitting
`"additional_content":[]` — and the cause was the case's **input**, authored
`"additionalContent": []` back when `[]` was the only spelling the reference
could write.

This document's rule is that a GOLDEN cannot hold a distinction its authoring
language cannot express. The same is true of a **subject**, and that is the
sharper trap: a wrong golden is compared and fails, while a wrong input is fed
to all three languages and they agree about the wrong thing. Fixing the
reference is what made it visible; it had been masked by the very defect being
fixed.

Where the reference cannot discriminate a row it now enforces on the ports and
merely does-not-fail for itself, recorded on the manifest rather than left to
look like agreement.

## Limit 2 — JavaScript cannot represent integers above 2^53

```
9007199254740993
  PHP     -> 9007199254740993   exact
  Python  -> 9007199254740993   exact
  Node    -> 9007199254740992   silently rounded
```

And the part that makes it nasty: in JavaScript,

```js
JSON.parse('{"id":9007199254740993}').id === 9007199254740993   // true
```

because the literal on the right rounds to the same double. **The language cannot
see its own error even when asked directly.**

Here PHP is the strong reference and the TypeScript port is the weak
implementation — the opposite direction from limit 1. Nothing in the corpus
carries such a value today: provider ids are strings (`resp_…`, `msg_…`) and
timestamps are in seconds. A provider adopting snowflake ids or nanosecond
timestamps would walk straight into it.

**How the corpus handles it**

- `jci-0002` pins the boundary as raw strings. Python and PHP pass; TypeScript is
  skipped, with the fix identified (carry such values as strings or `BigInt` in
  the raw passthrough) and recorded as finding F-5.
- `tools/guard-corpus.mjs` forbids any shipped case file from carrying an
  **unquoted** integer outside the safe range.

## The checker must not be subject to the defect it checks for

The large-integer guard reads the case files **as text**, with a scanner that
tracks JSON string boundaries itself. It never parses them.

That is not fastidiousness. The guard runs on Node. `JSON.parse` would round the
offending value and then report it safe — destroying the evidence using the very
defect being looked for. Generalise it: **when checking for a defect, do not use
a tool that is subject to that defect.**

## Presence is not usage

`jci-0001` is the corpus's hardest case and also its own discrimination probe,
and that is deliberate.

The raw-string channel exists so the corpus can carry what PHP cannot compare. It
would be easy to write a test asserting the raw strings are PRESENT and believe
that proves they are USED — but presence is satisfied by the authoring alone. The
field would exist, the assertion would pass, and no loader would ever have read
it.

What discriminates is a row where **the decoded values are equal and only the raw
strings differ**. In PHP, `[]` and `{}` decode identically, so `jci-0001` is
exactly that pair. It has no decoded input at all: a runner can only answer it by
parsing `left_raw` and `right_raw` itself.

Without that row the entire raw-string mechanism could be inert and every test
here would still be green.

The principle generalises to anything that carries what a language cannot hold:
**prove the channel is read, with a case that can only pass if it was.**
