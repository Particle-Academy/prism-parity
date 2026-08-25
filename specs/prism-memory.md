# prism-memory

**Status:** specified, not built.
**Fills:** persistent context, semantic recall, vector storage.

Read [`docs/patterns/`](../docs/patterns/) and [`docs/decisions/`](../docs/decisions/)
first. This file says only what is particular to this package.

## What it is for

An agent's useful context outgrows its context window. `prism-harness` gives a
conversation a thread, and a thread replayed whole is the crudest possible
memory: it grows without bound, costs tokens linearly, and eventually stops
fitting.

This package stores what was said and retrieves **only the parts that matter
now**.

## What it must not do

**No UI.** Storage and retrieval. A memory browser is a Fancy component
consuming this package.

**No changes to `prism` core.** If retrieval needs something core does not
expose, file it and work around it.

**It does not own the conversation.** `prism-harness` owns threads. This
package reads them and stores derived representations. Two packages must not
both claim to be where a conversation lives.

## The shape

```php
$memory = PrismMemory::for($user, scope: 'support');

$memory->remember($response->messages);          // derive and store
$relevant = $memory->recall('billing address');  // retrieve what matters now

Prism::text()
    ->withSystemPrompt($relevant->asContext())
    ->withPrompt($question)
    ->asText();
```

Recall returns something that can become context, not raw rows — the caller
should not be assembling provider payloads by hand.

**This example was wrong in the first draft**, and the way it was wrong is
worth keeping. It read `->withMessages($relevant->asMessages())->withPrompt($question)`,
which throws `prompt_and_messages` the moment recall returns anything — and
passes in development against an empty store. A spec example that only fails
once the feature starts working is the worst kind.

## Decisions already taken

**This package owns the vector-store contract for the whole ecosystem.**
`prism-rag` will consume it rather than defining its own. Two vector
abstractions in one ecosystem is the thing that makes an ecosystem a collection.
The contract lives here because memory is the package that needs it first, not
because memory is more important. Recorded in
[0008](../docs/decisions/0008-consensus-among-agents.md) as a cross-cutting
decision.

**Embeddings come from Prism, not from a bundled model.** `Prism::embeddings()`
already speaks to every provider that offers them. A package that embeds text
its own way is a second provider integration nobody asked for.

**Storage is driver-based, database-first.** The harness learned this the
expensive way: its ephemeral store defaulted to Redis, and a fresh install threw
a connection error on a machine that never claimed to have one. Default to what
every Laravel app already has. A vector database is an opt-in.

**Durability rules follow the harness.** Memory that a deploy can clear is a
cache, and must say so. See `prism-harness`'s `Durability` enum — the same
distinction applies, and the reasoning is identical.

## Open questions — raise these, do not settle them privately

**What is stored: messages, summaries, or facts?** Storing raw turns is honest
and retrieves badly. Storing model-written summaries retrieves well and is a
second place for the model to be wrong, unauditably. Storing extracted facts is
the most useful and the most opinionated. This is the central design question
and it should be answered deliberately, not by whichever is easiest to build.

**Does recall ever run a model?** Semantic search over embeddings does not.
Summarisation and fact extraction do — which makes `remember()` a billable
operation with a latency budget, and that is a different kind of API than a
storage call. If it does, it must be visible in the call, not hidden.

**Forgetting.** Nothing here says how memory is scoped in time, or whether a
user can remove something. A memory package with no delete path is a compliance
problem waiting to be found by someone else.

## Conformance

Round-trip through storage is already a corpus category, and it exists partly
because of this package. A stored memory that rebuilds as an array where a value
object belonged is the `prism-harness` v0.1.1 defect repeating — see
[0007](../docs/decisions/0007-reference-language-limits.md) for why absent-vs-null
and enum handling are where this breaks first.

## First slice

A working vector store, a `remember`/`recall` pair, and one storage driver.
Depth before breadth: one honest path end to end beats four half-built ones,
and the open questions above are cheaper to answer against something running.
