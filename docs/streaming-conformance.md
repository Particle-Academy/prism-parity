# Streaming conformance

The `anthropic-text-stream` suite has ten owned SSE byte fixtures. PHP executes
the published core handler with an HTTP-faked PSR body. TypeScript and Python
execute their native provider, byte decoder and SSE parser with a fake fetch or
urllib response. No inference, provider network call or tool execution occurs.
Every case uses maxSteps(1), and a missing suite, missing row or empty byte input
fails rather than asserting nothing.

Each case declares properties before reference execution: retained text, balanced
text starts/completions, one terminal end, specifically
Stop or Error as required, accounting completeness and no
completed tool call from partial JSON. Complete controls pin cache buckets and
explicit zero reasoning. EOF, provider-error, sticky-error, split UTF8 and
ping/unknown/comment controls test the boundaries independently of agreement.
Text deltas must retain the full declared text in every language. The ports'
completion payload also carries that text and is checked; PHP's completion
payload carries only a message ID, so its completion check requires closure.

Goldens come from executing published PHP0.135.0. The result contains ordered
native event types and their public payloads, native iteration outcome and the
number of faked HTTP requests. Only event IDs/timestamps and consistent aliases
of opaque message/reasoning IDs are normalized. Identity reuse remains visible;
owned tool IDs remain literal. Step events, public keys, finish literals,
absent/null usage and cost are retained. Private billing object metadata is
outside this wire-facing suite.

The initial measurement found two different problems. Both ports failed six
semantic cases. Independently, their native event vocabulary lacks PHP's step
events and their public payloads differ. The maintainer adjudicated the semantic
fixes for ports0.5.0 and kept event-vocabulary design separate as G-125.

The suite therefore explicitly declares `comparison.mode=stream-properties`
and `exact_trace_gap=G-125`. A property failure is a failed case. A property pass
records `trace_comparison` with the actual canonical trace, reference golden,
`match` or `known-divergence` status and the gap when applicable. PHP must still
match its generated golden. Cross-check validates the trace evidence and
independently rechecks its properties; a false equality claim or unregistered
divergence fails. Reports distinguish semantic verification from exact trace
equality and from unsupported skips. Other suite kinds cannot select this mode.

G-125 closes only after a separate event-vocabulary decision and its coordinated
implementation. Removing step events, inventing missing events or rewriting
public payloads in a runner would hide that gap and is not this comparison.

Port0.5.0 changes observable Anthropic behavior: EOF emits non-recoverable
`incomplete_stream` and terminal Error, provider errors close unfinished text and
still end Error, Error is sticky, and absent final accounting stays unknown.
The corpus and both ports use a reviewed pin/port/unpin rollout. A temporary
checkout pin must be removed and main tracking green before either port release.
