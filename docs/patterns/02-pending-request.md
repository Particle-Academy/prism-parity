# 02 — The pending request

**Enforced by:** `suites/openai-text-request`

A mutable, fluent builder. Every configuration method returns the builder, so
calls chain in any order.

```php
Prism::text()
    ->using('openai', 'gpt-4o')
    ->withSystemPrompt('You are terse.')
    ->withPrompt('Who are you?')
    ->withMaxTokens(256)
    ->asText();
```

## It validates nothing

Deliberately. The builder accumulates; the freeze decides.

That gives one answer to "when does this blow up?" — at `toRequest()`, never
earlier and never scattered across twelve setters. It also means a caller can
build a request in whatever order suits their code without hitting an error
because two settings happened to arrive the wrong way round.

## Accumulate or replace — and which is which is a decision

| Method | Behaviour |
|---|---|
| `withSystemPrompt` | **Appends.** Called twice, both survive, in call order. |
| `withSystemPrompts` | Replaces the whole list. |
| `withMessages` | Replaces. |
| `withTools` | Replaces. |
| `withProviderOptions` | Replaces. |
| `withPrompt` | Replaces. |

`trq-0002` and `trq-0003` pin the append, and they exist as a pair on purpose: a
port that models `withSystemPrompt` as a setter passes the first and fails the
second. One system-prompt case would not have been enough.

## The freeze

`toRequest()` produces the immutable `Request`. Three things happen, and only
here:

1. **Prompt and messages are checked for conflict.** Both set is a refusal
   (`err-0001`), not a precedence rule — there is no defensible order to merge
   them in, and silently picking one would send a conversation the caller did not
   write.
2. **The message list is assembled**: thread history first, then explicit
   messages, then the prompt as a trailing user message.
3. **Tool error handling is resolved** if it was switched off.

A prompt that is empty or `"0"` is still a prompt. `trq-0021`, `trq-0022` and
`err-0003` pin that, and are skipped for PHP because the reference gates both the
conflict check and the append on truthiness — so a `"0"` prompt is dropped *and*
slips past the refusal. See finding F-2.

## `using()` resolves the provider eagerly

`using('openai', 'gpt-4o')` resolves the provider instance immediately, from
configuration, and stores the model as a plain string.

**Model names are strings, not enums.** That is a deliberate and load-bearing
choice: providers rotate model rosters constantly, and a new model id must never
require a package release. It is also why a new model id is *noise* in a drift
report while an SDK major is signal.

## Threads compose with the prompt; messages do not

`withMessages()` and `withPrompt()` are mutually exclusive. `withThread()` and
`withPrompt()` are not — the thread is the history and the prompt is the turn
being taken now, which is the entire point of continuing a conversation rather
than rebuilding it.

Thread history is resolved once and memoised, because `messages()` may return a
generator and a generator is spent after one pass. Without the memo, building the
request a second time would quietly produce a conversation with no history at
all.

Threads are `deferred` in the ports — see `manifest/packages.json`.
