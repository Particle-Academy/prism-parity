# 03 — The provider contract

**Enforced by:** `suites/text-errors` (the unsupported-capability path)

A provider is an abstract base with **one method per capability**, and every one
of them throws by default:

```php
abstract class Provider
{
    public function text(TextRequest $request): TextResponse
    {
        throw PrismException::unsupportedProviderAction('text', class_basename($this));
    }

    public function embeddings(EmbeddingsRequest $request): EmbeddingsResponse { … }
    public function stream(TextRequest $request): Generator { … }
    // …one per capability
}
```

A concrete provider overrides what it supports and inherits a throw for what it
does not.

## Why throwing is the default, and why it matters more than it looks

**A capability a provider does not support must fail loudly. It must never
degrade, silently drop the feature, or return something plausible.**

This is not defensive style; it is the lesson from a live incident. Perplexity
accepted `withTools()` for its entire life in this package and never offered the
tools to the model. Callers got a perfectly good answer back, with zero steps and
zero tool calls, and nothing errored. The run read as *the model choosing not to
call the tool*. It took a live call against a real key to find, because passing
tests sat happily on top of the silence.

An unsupported capability that throws is a five-minute fix at integration time.
One that silently no-ops is a defect that looks like model behaviour, and those
are found by customers.

## What a provider owns

Everything vendor-specific, and nothing else:

- mapping the frozen `Request` into the vendor's payload
- the HTTP call, its headers and its auth
- mapping the response back into the **same** value objects every other provider
  returns
- mapping the vendor's error responses onto Prism's failures

What a provider must **not** own: anything a caller can observe that is not
genuinely vendor-specific. If two providers would sensibly return different
shapes for the same concept, that is a mapping problem to solve in the provider,
not a difference to hand to the caller.

## Providers may have several API formats

The OpenAI provider speaks two: `responses` (the default) and
`chat_completions`, selected by configuration, with a different handler per
format. The ports implement `responses` only; `chat_completions` is recorded as
drift rather than deferred, because it is a genuine gap and not a decision.

## Configuration resolution

Providers are resolved from configuration by key — `'openai'`, `'anthropic'` —
with per-call overrides available through `usingProviderConfig()`. The key is a
string, the model is a string, and neither requires a package release to change.

## Error mapping

Each provider maps its own HTTP failures onto Prism's exception types before they
reach the caller: rate limits, overload, request-too-large, and a general
provider error carrying the vendor's own error type and message.

The types are shared; the vendor detail is carried inside. See
[07](07-errors.md) — and note finding F-1: today those failures are distinguished
by an English sentence, which is why the ports add codes.
