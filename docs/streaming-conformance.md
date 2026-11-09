# Streaming conformance

The `anthropic-text-stream` suite has <!-- metric:suite.anthropic-text-stream.cases -->21<!-- /metric --> owned SSE byte fixtures. PHP executes
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

The original ten goldens came from published PHP0.135.0. The current exact
reference requirement is recorded in `runners/php/composer.json`; subsequent
changes follow the released-reference rule described below. The result contains ordered
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

## Provisional usage after a failed stream

`stream-failure-usage` has <!-- metric:suite.stream-failure-usage.cases -->54<!-- /metric --> controls. Its original reference evidence used normally installed PHP0.146.0. Every core-reference golden was regenerated from normally installed [PHP 0.147.1](https://github.com/Particle-Academy/prism/releases/tag/v0.147.1); every pre-existing canonical row retains its original bytes. The additive `fau-0054` tool-identity control also passes with both current and floor dependencies. Both executions reproduce the candidate bytes and independently require one owned tool invocation and the second request's failure. The controls cover Anthropic, OpenAI Responses and Mistral with owned SSE bytes and read faults. Early usage in a synthetic fixture is a boundary control, not evidence that a provider sends that sequence in production or bills those counts.

An optional `failure_usage` contains the full Usage shape, a reported-field mask, provisional status and attempt/step scope. Missing reports remain absent; explicit zero remains reported. Independent predicates check cumulative replacement, preservation across unrelated chunks, cache split invalidation, retry reset, interleaved isolation, privacy and native error serialization. Failed accounting excludes completed steps. Error-event and exception channels for the same failure describe one attempt and must not be added as separate charges. The predicates are tested with deliberate defects applied to executed native output.

Native failure channels remain explicit in each row. PHP's malformed JSON raises its SDK decode exception. Anthropic ports retain their error event and Error end. Recognized malformed JSON in OpenAI/Mistral ports emits one typed failure error event, even without reported usage, and adds no fabricated end event or thrown wrapper. Foreign transport errors retain their original class and object identity; reported usage travels on the preceding error event. The raw foreign exception itself gains no accessor. Port release notes must call out the newly observable malformed-stream failure.

Two hostile Anthropic count cases declare PHP's raw TypeError as a known G-214 difference. These cases are reported separately and excluded from verified cross-language agreement. Three native continuation cases are PHP-only under G-215 because the ports have no native multi-step stream/tool loop. Their adapters must not simulate that loop. Three additional PHP-only cases exercise public generation telemetry, whose dispatch API is outside the ports' shared stream-event surface. Every other new row is mandatory in all three languages.

The five old reported-then-error traces `ats-0002`, `ats-0003`, `ats-0006`, `ats-0007` and `ats-0009` gain only released-reference `failure_usage` fields. Their inputs, semantic properties and all remaining trace fields are unchanged; no-report errors and successful baselines retain their bytes. G-125 remains open for both suites: runners retain actual ordered native traces and independently verify declared semantics without aligning event vocabulary.
