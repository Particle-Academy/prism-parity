# 0023 — Embedding refusal behavior and native error identity

**Status:** accepted for G-65 by the assigned maintainer, 2026-10-30 (inbox3098).

## Decision and scope

The `embedding-decoding` security corpus compares decoding and refusal behavior.
For its valid controls, the three languages must return exactly the reference
floats, including their numeric bytes. For every hostile control, all three must
raise a library exception and return no vector or partial result. Returning an
empty vector is a failure, even if every language does it.

Observed columns record actual native identities: PHP's
`Prism\Prism\Exceptions\PrismException`, and TypeScript/Python's `PrismError`
with stable code `invalid_embedding`. A port's observed column must never contain
PHP's exception class as a projection. The row notes explicitly state:
"error identity is language-native; PHP carries no stable code (known reference
gap); refusal behaviour is identical".

This is an embedding-specific behavioral comparison, not permission to normalize
other corpus outputs or to relax byte equality elsewhere. It amends the
application of [0004](0004-error-codes.md) to this corpus; 0004's reference gap
remains open and is not fixed by translating a class name in a runner.

## Why

G-65 returned empty vectors for valid base64 and all seven hostile inputs in
both published core ports. Merely comparing languages would accept that result
if the PHP decoder regressed too. The security property is refusal of corrupt
data before consumers can store or rank it. The independent hostile-row oracle
must fail for any language returning any vector, including empty or partial
vectors. It must also reject a missing observation, the wrong native exception,
or an unrelated error code.

A PHP namespaced exception cannot be a TypeScript or Python native exception.
Faking that class name would hide an actual difference without adding safety.
Preserving native observations lets reviewers inspect the difference, while the
explicit behavioral rule checks the property that protects consumers.

## Execution and limits

The two core ports' package tests execute every canonical row through both real
OpenAI and Mistral parsers, using the installed corpus loader and comparator.
PHP's package tests exercise both handlers as well. Mark those runners full only
for executed coverage. Canonical columns are generated from actual observations,
never edited to make agreement green. Publication acceptance separately binds
the exact released archives to the reviewed runtime files and repeats all rows.

The generic core runner still delegates security corpora to package-specific
tests. No cache-hint declaration, OpenRouter capability, request option, provider
quality, dimension selection, quantized format or live provider call is claimed.
