# 01 — The model

**Enforced by:** nothing directly. This page describes the shape the other pages
pin. Treat it as orientation, not as a guarantee.

## What Prism is for

An application that talks to models should talk to **one** thing, and that thing
should absorb provider churn rather than pass it on.

`Prism::text()->using(…)->withPrompt(…)->asText()` means the same thing across
every provider. When a provider retires an endpoint — as Perplexity's Sonar
endpoints were, on 33 days' notice — the change lands inside a provider class,
not in every caller.

That is the claim. Everything below exists to make it true across languages too.

## The five parts

```
Prism::text()          entry point      →  a fresh pending request
  ->using(…)           pending request  →  a mutable builder
  ->withPrompt(…)                          accumulating configuration
  ->toRequest()        request          →  an immutable snapshot
                       provider         →  vendor-specific mapping and HTTP
  ->asText()           response         →  the result and how it was reached
```

Every capability — text, structured, embeddings, images, audio, moderation,
speech, FIM, batch — has the same five. Learn them once.

## Why the freeze in the middle matters

The pending request is deliberately permissive: it validates nothing, and every
method returns `$this`. The `Request` it produces is deliberately immutable.

The boundary between them is where validation happens, and it is the only place
it happens. That gives one answer to "when does this blow up?" — at
`toRequest()`, never earlier and never scattered.

It also gives the conformance corpus somewhere to stand: a builder script plus
`toRequest()` is a pure function from calls to a payload, with no HTTP involved.
Every request-mapping case in the corpus is that function.

## What a provider is responsible for

**Everything vendor-specific, and nothing else.**

A provider translates the frozen request into that vendor's payload, makes the
call, and translates the response back into the same value objects every other
provider returns. Callers never see a vendor's shape.

The corollary is the one that keeps this honest: **a capability a provider does
not support THROWS.** It does not degrade, silently drop the feature, or return
something plausible. Perplexity accepted `withTools()` for its entire life and
never offered the tools to the model — the caller got a good answer, zero steps,
and no indication that anything had been ignored. That is the failure mode a
throw prevents.

## What the ports must carry

Not the feature list — the ports have one provider and one capability, and that
is fine. What has to survive the crossing is:

- the same five parts in the same order
- the same value objects with the same field names
- the same decisions about absence, falsiness and ordering
- the same failures, identified by the same codes

An agent that has learned this model in PHP should be able to build the same
application in TypeScript without relearning it. That is the goal, and it is a
documentation and API-shape problem rather than something a fixture table can
enforce — which is why these pages live here and the ports link to them instead
of restating them.
