# prism-rag

**Status:** specified, not built.
**Fills:** document ingestion, chunking, retrieval.

Read [`docs/patterns/`](../docs/patterns/) and [`docs/decisions/`](../docs/decisions/)
first. This file says only what is particular to this package.

## What it is for

Answering from a corpus the model was never trained on — documentation, a
contract, a codebase, a support history. Ingest documents, split them
sensibly, embed them, and retrieve the passages that bear on a question.

## What it must not do

**No UI.** No document manager, no upload widget.

**No changes to `prism` core.**

**It does not define a vector store.** `prism-memory` owns that contract for
the whole ecosystem — see [prism-memory.md](prism-memory.md). Consume it.
Defining a second one is how an ecosystem becomes a collection, and it would
mean an application storing embeddings twice.

**It does not own conversation memory.** Memory is a conversation's past; this
is a corpus. They share storage and nothing else.

## The shape

```php
PrismRag::corpus('handbook')->ingest($document);

$passages = PrismRag::corpus('handbook')->retrieve($question, limit: 5);

Prism::text()
    ->withSystemPrompt($passages->asContext())
    ->withPrompt($question)
    ->asText();
```

Retrieved passages must carry **where they came from**. An answer built from a
corpus that cannot cite it is not auditable, and the whole point of retrieval
over fine-tuning is that you can check it. This is the same reasoning that made
the Lab's research tool return sources rather than prose.

## Decisions already taken

**Chunking is a strategy, not a constant.** A contract, a source file and a
support thread do not split the same way. Ship a sensible default, make it
replaceable, and do not bury the choice.

**Embeddings come from Prism.** Same as memory: `Prism::embeddings()` already
speaks to every provider that offers them.

**Ingestion is idempotent.** Re-ingesting an unchanged document must not
duplicate it. A corpus that grows every time a sync runs retrieves worse each
time, and the failure is silent — you get more results, all of them the same
passage.

## Open questions — raise these, do not settle them privately

**Does retrieval rerank?** Perplexity, Cohere, Jina and VoyageAI all offer
reranking, and it materially improves results. It is also a second model call
per query. If it happens, it must be visible and optional.

**What is a passage's identity across re-ingestion?** If a document changes,
are its old chunks updated, replaced, or versioned? A corpus with no answer
accumulates stale passages that still retrieve.

**Where does the boundary with `prism-memory` actually sit?** Both embed text
and search it. The distinction stated above — a conversation's past versus a
corpus — is clean in principle and will blur in practice. Say something now.

## First slice

One document type in, one chunking strategy, retrieval with sources attached,
storage through `prism-memory`'s contract. Prove the seam between the two
packages before adding a second document type.
