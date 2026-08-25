# 04 — Messages and value objects

**Enforced by:** `suites/value-object-roundtrip`

Four message types, one per role in a conversation:

| Type | Carries |
|---|---|
| `SystemMessage` | `content` |
| `UserMessage` | `content`, content parts, additional attributes |
| `AssistantMessage` | `content`, tool calls, additional content |
| `ToolResultMessage` | tool results |

Plus the supporting objects: `ToolCall`, `ToolResult`, `Usage`, `Meta`,
`ProviderTool`.

## Every value object serialises to a plain map

`toArray()` in PHP, `toObject()` in TypeScript, `to_dict()` in Python. Same keys,
same order, `snake_case` in all three regardless of the host language's
convention — because the serialised form is a wire format, not an API surface.

```json
{"type":"user","content":"Who are you?","additional_content":[{"text":"Who are you?"}],"additional_attributes":{"turn":"1"}}
```

## Optional fields serialise as explicit nulls

Not omitted. `Usage` with nothing but token counts still emits all six keys:

```json
{"prompt_tokens":11,"completion_tokens":56,"cache_write_input_tokens":null,"cache_read_input_tokens":null,"thought_tokens":null,"cost":null}
```

`rtp-0004` and `rtp-0005` are a pair — unset and set — and together they pin that
the **keys are unconditional and only the values vary**. A port that omits unset
counters produces a stored row that rebuilds into a different value object, and
the divergence surfaces on the next provider call rather than at save time.

## The ports can read them back; the reference cannot

**`toArray()` has no counterpart in `particle-academy/prism`.** The value objects
are write-only: there is no `fromArray()` for any message type, no cast, no
hydration anywhere in the package.

That gap is finding F-4, and it is not academic. It forced `prism-harness` to
invent its own `MessageMapper` and `ValueObjectMapper`, and that invention
shipped a defect that corrupted **every stored Anthropic assistant message** —
`additionalContent` was stored raw, JSON turned a `MessagePartWithCitations` into
an array, and it came back as one, failing on the *next* provider call inside a
mapper naming a class the application never mentioned.

A package that can write a conversation and cannot read it back pushes that
problem onto every consumer, and each one solves it differently.

So the ports ship `fromObject()` / `from_dict()`, and the roundtrip suite asserts
that **serialise → rebuild → serialise returns the identical bytes**. PHP is
recorded as unable to run that half.

## The trap that makes the roundtrip suite necessary

`UserMessage`'s constructor **mutates its own input**:

```php
public function __construct(public readonly string $content, public array $additionalContent = [], …)
{
    $this->additionalContent[] = new Text($content);
}
```

The stored `additional_content` therefore already contains a text part built from
`content`. Handing it straight back to the constructor appends a **second** copy,
and the message text doubles on every save-and-load cycle.

Nothing errors. The conversation just grows. `prism-harness` has to strip the
trailing part explicitly, and so does every port.

`rtp-0001` pins it, and the `rehydrate-reappends-text` probe proves the row
actually catches it. This is finding F-6; the suggested fix is to build the parts
list in a named constructor so the value object is idempotent under round trip.

## Two divergence axes to watch

**Absent versus null.** PHP has one absent value; JavaScript has `null` and
`undefined`; Python has `None`. Every nullable field in this suite exists to pin
which one is meant.

**Empty maps.** PHP renders an empty map-typed field as an empty JSON **array**
and a populated one as an **object** — the same field changing JSON type with its
contents. `rtp-0009` isolates that; every other row here carries a non-empty map
so the ambiguity contaminates one row instead of nine. Finding F-3, and
[decision 0007](../decisions/0007-reference-language-limits.md).
