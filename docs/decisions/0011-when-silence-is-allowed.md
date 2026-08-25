# 0011 — When degrading silently is allowed

**Status:** accepted, 2026-08-25

Raised by the `prism-memory` agent while proposing a portable prompt-cache
hint. It noticed the proposal collided with an otherwise absolute rule and
asked for the distinction rather than quietly making an exception.

## The rule it collided with

`docs/patterns/03-provider-contract.md`: **a provider that cannot do something
throws.** It does not accept the request and ignore the part it cannot honour.

That rule was learned expensively. Prism's Perplexity provider accepted
`withTools()` and silently dropped it — the run came back with zero steps, zero
tool calls, and an answer that read as the model declining to use the tool.
Nothing failed. It now refuses loudly.

## Why it cannot be absolute

A portable cache hint has three incompatible provider models behind it:
mark-in-place (Anthropic), automatic prefix (OpenAI — nothing to declare,
ever), and create-and-reference (Gemini).

Throwing on OpenAI because it has no explicit breakpoints would be wrong. The
caller asked for *cheaper*, not for a feature, and **the answer is
byte-identical either way**.

## The distinction

**Silent degradation is acceptable only when the degradation is already
visible in the response.**

A cache miss is visible: `Usage::$cacheReadInputTokens` is populated by twelve
providers, so a caller who cares can see exactly what happened without being
told in advance.

A dropped tool was visible nowhere. The response looked like a model that had
chosen not to call it — indistinguishable, from the outside, from success.

So the test is not *how important is this feature*. It is: **after the call,
can the caller tell?** If the answer is in the response, degrade quietly. If it
is not, throw.

## Applying it

Before degrading rather than throwing, name the field in the response that
reveals it. If you cannot name one, you are not degrading — you are producing a
result that lies about what it is.

That reframing is the useful part: an unobservable degradation is not a lesser
form of working, it is a wrong answer delivered confidently.
