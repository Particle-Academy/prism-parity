# 06 — Response parsing

**Enforced by:** `suites/openai-text-response`

A provider's raw body becomes a `Response`: the text, why generation stopped, what
it cost, and the full message list that produced it.

## The shape

```
Step        one provider round trip: text, finish reason, tool calls,
            tool results, usage, meta, the messages that went in, raw
ResponseBuilder   accumulates steps
Response    the final step's result, plus every step, plus the total usage,
            plus the messages INCLUDING the trailing assistant turn
```

A single-step generation still produces one `Step`. Multi-step tool loops produce
several and the builder sums their usage. Only the shape is in the slice; the
loop itself is `deferred`.

## The response carries the conversation, not just the answer

`$response->messages` is the full exchange — everything sent, plus the assistant
turn that came back, plus tool calls and results from every step.

That is what makes Prism's threads read-only: an application persists
`$response->messages` afterwards and Prism never writes to storage, never owns a
schema, and never has an opinion about a lifecycle. A conversation interrupted
mid-tool-loop can be stored and resumed where it stopped.

## Finish reasons decide the branch, so mapping them is not cosmetic

| Provider signal | Finish reason | What happens |
|---|---|---|
| top-level `incomplete` + `content_filter` | `ContentFilter` | parsed normally |
| top-level `incomplete`, any other reason | `Length` | **THROWS** |
| last output item `completed` + `message` | `Stop` | parsed normally |
| last output item `completed` + `*_call` | `ToolCalls` | enters the tool loop |
| anything else | `Unknown` | parsed normally |

`trs-0003` exists because getting content-filter wrong routes a filtered answer
into the branch that throws. The top-level status is inspected **before** the
per-item status, and that order is the contract.

## The last output item, and the empty case

Text is the last output item's first content part. Reasoning items come *before*
the message, so "last" is what makes the answer the answer and not the model's
thinking.

The reference expresses this as `data_get($data, 'output.{last}.content.0.text')`,
which returns null on an empty `output` array and falls through to `''`. It is
correct and entirely implicit — a port that indexes the last element without
guarding crashes on a response the provider is entitled to send. `trs-0004` pins
the empty case: text `''`, finish reason `Unknown`, no exception.

## Usage arithmetic

```
prompt_tokens = usage.input_tokens − usage.input_tokens_details.cached_tokens
```

The cached count is *also* reported separately. A port that passes `input_tokens`
straight through double-counts the cache on every prompt-cached request and
silently inflates the caller's cost reporting.

`trs-0002` is the only row with a non-zero cached count, which is precisely why it
exists — and why the `prompt-tokens-unadjusted` probe declares exactly that one
row.

Token counts are compared **exactly**. There is no tolerance anywhere in this
corpus; see [decision 0005](../decisions/0005-canonical-json.md).

## Fields the provider omitted become explicit nulls

`service_tier` absent from the body becomes `"service_tier": null` on the parsed
result, not a missing key (`trs-0007`). This is the mirror of `trq-0001` on the
response side, and it is the half a port is most likely to get wrong in a
language where absent and null are different values.

## `raw` is a passthrough, and passthroughs are where language limits bite

`Response.raw` carries the provider's body untouched. Two things travel badly
through it:

- **Container type.** PHP decodes `{}` and `[]` to the identical value, so a
  PHP-generated golden cannot say which one the provider sent.
- **Large integers.** JavaScript rounds anything above 2^53 on parse and cannot
  detect that it has.

Neither is hypothetical for a passthrough, which by definition carries whatever
the vendor invents next. Both are pinned in
`suites/json-container-identity` and written up in
[decision 0007](../decisions/0007-reference-language-limits.md).
