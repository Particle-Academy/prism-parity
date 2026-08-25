# 0005 — One canonical JSON, and no global tolerance

**Status:** accepted, 2026-08-25

## Canonical form

Every golden in this corpus, and every value compared against one, is a **JSON
string in canonical form**:

- UTF-8, no insignificant whitespace
- forward slashes **not** escaped
- non-ASCII **not** escaped
- object keys in **insertion order**, never sorted

None of the three languages produces this by default:

| | Default | What the port must do |
|---|---|---|
| PHP | escapes `/` as `\/` and non-ASCII as `\uXXXX` | `JSON_UNESCAPED_SLASHES \| JSON_UNESCAPED_UNICODE` |
| Python | escapes non-ASCII; pads separators | `ensure_ascii=False, separators=(",", ":")` |
| JavaScript | correct already | nothing |

`trq-0023` pins this with a prompt containing a URL, a `ü` and Japanese text, so
a port that accepts its encoder's defaults goes red rather than shipping a
different payload.

## Key order is part of the contract

Insertion order, not sorted order. Key order does not change what a JSON API
means, but it does change what a port can silently alter, and the cheapest way to
notice a mapper being rewritten is to notice its output moving. All three
languages preserve insertion order in their object types, so this costs nothing
to hold.

## Comparison: byte equality, and nothing else

**There is deliberately no global float epsilon.**

The reasoning is the same as the reason a skip must state its cause: a global
tolerance is **invisible**. Nobody reading a fixture can tell whether it asserts a
value or a neighbourhood. Worse, an invisible tolerance lets two implementations
that computed *different* values pass as equal — in the repository whose entire
product is catching that.

A row that genuinely needs slack declares `tolerance` **on itself**, where a
reader of that row can see it:

```json
{ "id": "…", "title": "…", "since": "…", "expect": { … }, "tolerance": 1e-9 }
```

**No row in the corpus needs one today**, and a loader test asserts that — so the
day one appears, it appears deliberately.

Token counts are exact. Cost is exact, because it is a decimal the provider
reported rather than a number anyone recomputed, so there is nothing for a
tolerance to absorb.

### Test the justification before softening an assertion

A tolerance elsewhere existed for a written reason — that a decimal literal in
JSON parses to different doubles in different languages. When that reason was
finally tested, across `0.002`, `0.1`, `1e300`, `DBL_MAX`, the `5e-324` denormal
and `0.30000000000000004`, compared as raw IEEE-754 bits, the results were
bit-identical every time. Decimal-to-double conversion is specified, not
per-implementation. The stated reason had been false for the tolerance's entire
life, and what it actually did was hide disagreement.

So: **if you write a justification for a tolerance, an exclusion, or any
softening of an assertion, test the justification.** A plausible reason in a
comment is not evidence, and a wrong one is load-bearing for as long as nobody
checks.

## The one number-rendering divergence we found by testing

| Value | PHP | JavaScript | Python |
|---|---|---|---|
| `0.7` | `0.7` | `0.7` | `0.7` |
| `1.0` | `1` | `1` | **`1.0`** |
| `1e300` | **`1.0e+300`** | `1e+300` | `1e+300` |

Two separate divergences, and note that PHP is the odd one out in the second row
— the opposite of the expectation that prompted the test.

`trq-0025` records the first and is skipped for Python. `prism-py` ships a
canonical encoder that normalises integral floats, so its wire bytes do match;
the row stays skipped anyway so the divergence remains visible in the corpus
rather than hidden inside one port's encoder.

Nothing in the corpus exercises exponent-form floats, so the second row is
recorded here and not yet pinned.

## Do not judge a comparator's output with the comparator

The loader tests that exercise `compare` assert its verdicts with the host
language's own `assert`/`==`, never with `compare` itself. Using a comparator to
judge its own output is circular: a broken one could pass its own table.
