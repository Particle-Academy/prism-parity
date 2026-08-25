# 07 — Errors

**Enforced by:** `suites/text-errors`

## Codes are the contract. Prose is not.

Every failure carries a stable machine-readable code. The sentence a human reads
is worded idiomatically per language and is **explicitly outside the contract**.

The corpus asserts `prompt_and_messages`. It never asserts
`"You can only use \`prompt\` or \`messages\`"`.

Pinning prose would hold three ports to a translation and turn the first
improvement to an error message into a red build with no behaviour change behind
it. That makes the test suite a reason not to improve error messages, which is
backwards. See [decision 0004](../decisions/0004-error-codes.md) for the taxonomy
and for finding F-1, which is that the reference has no codes at all.

## Fail at the freeze, not in the builder

The pending request validates nothing. `toRequest()` validates everything.

One place to look when something blows up, and one place to change when the rules
move.

## Refuse ambiguity; do not resolve it

Prompt and messages together is a **refusal** (`err-0001`), not a precedence
rule. There is no defensible order to merge them in, and silently picking one
would send a conversation the caller never wrote — a successful call that
answered a different question.

`err-0003` is the same refusal with a prompt of `"0"`, and it is skipped for PHP
because the reference guards it with a truthiness test that `"0"` slips straight
past. Finding F-2.

## Fail where the fault is

A tool call whose arguments string is not valid JSON fails at **mapping** time
with `malformed_tool_call_arguments` (`err-0002`), naming the tool — not later,
as a generic encoding error, and not at the provider as a malformed function
call.

The general rule: the error should name the thing the caller can act on. An
exception that surfaces three layers away, mentioning a class the application
never referenced, is the shape of the `prism-harness` defect described in
[04](04-messages.md).

## Unsupported means throw

Never degrade, never silently drop, never return something plausible. See
[03](03-provider-contract.md) — this is the rule the Perplexity `withTools()`
incident bought.

## Provider failures map onto shared types

HTTP status becomes a Prism exception before it reaches the caller:

| Status | Becomes |
|---|---|
| 413 | request too large |
| 429 | rate limited, carrying the provider's rate-limit headers and retry-after |
| 529 | provider overloaded |
| anything else | provider request error, carrying the vendor's error type and message |

The **types** are shared so a caller can branch once and have it work across
providers; the vendor's own detail rides inside rather than leaking out as a
different shape per provider.

## What is not an error

- An empty `output` array. Text is `''`, finish reason is `Unknown`, nothing
  throws (`trs-0004`).
- A content filter. It has its own finish reason and parses normally
  (`trs-0003`) — routing it into the length branch would turn a filtered answer
  into an exception.
- A field the provider omitted. It becomes an explicit null (`trs-0007`).

Stopping on **length** is the exception: the OpenAI Responses handler throws,
because a truncated answer that looks like a complete one is worse than a failure.
