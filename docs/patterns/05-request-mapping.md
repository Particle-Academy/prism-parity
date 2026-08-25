# 05 — Request mapping

**Enforced by:** `suites/openai-text-request` (28 cases)

How a frozen `Request` becomes the bytes a provider receives. This is where ports
diverge, because it is almost entirely made of decisions about *absence*, and no
two languages spell absence the same way.

## The shape of a mapper

A provider's request builder does exactly two things:

1. Merge the keys that are **always present**, whatever their value.
2. Merge the keys that are present **only when not null**, after the first set.

```php
return array_merge([
    'model'             => $request->model(),
    'input'             => (new MessageMap($request->messages(), $request->systemPrompts()))(),
    'max_output_tokens' => $request->maxTokens(),      // ← null and still emitted
], Arr::whereNotNull([
    'temperature' => $request->temperature(),
    'top_p'       => $request->topP(),
    'tools'       => $this->buildTools($request) ?: null,
    …
]));
```

Two groups, and which group a key is in is a **decision**, not a detail.

## The five rules a port must hold

### 1. Unconditional keys are emitted even when null

`max_output_tokens` is in the first group, so it appears as an explicit `null`
when nobody set it.

This is the single most important row in the corpus (`trq-0001`), because it is
the mistake a port makes by accident: `JSON.stringify` drops `undefined`
properties, and a naive dict comprehension drops `None`. **Absent and null are
different**, and a port that models "unset" as absence produces different bytes
on every request it ever sends.

### 2. Optional keys are filtered on NULLITY, not falsiness

`temperature: 0` is sent (`trq-0006`). `store: false` is sent (`trq-0016`).

Zero and false are legitimate values a caller chose deliberately, and dropping
them inverts the intent rather than degrading gracefully: temperature 0 becomes
the model's default sampling, and `store: false` becomes `store: true`.

### 3. …except where the reference filters on falsiness, which it does inside tools

`ToolMap` uses a plain `array_filter`, so `strict: false` never reaches the wire
(`trq-0010`) while `store: false` does. **Reproduce the inconsistency; do not
tidy it.** A port that "fixes" it sends a different request from the reference,
which is the thing this corpus exists to prevent. It is recorded as finding F-7.

### 4. An empty collection collapses to absence

`'tools' => $this->buildTools($request) ?: null` — an empty tool array is falsy
in PHP, becomes `null`, and the not-null filter then drops the key.

An empty array is **truthy** in JavaScript and Python, so a direct transliteration
sends `tools: []` — which some OpenAI models reject and which silently changes
`tool_choice` defaults on others. `trq-0008` is the highest-value falsiness trap
in the suite.

### 5. Order is contract

- System prompts are **prepended** to the message list (`trq-0002`, `trq-0003`).
- Provider-native tools are merged **in front of** the caller's tools
  (`trq-0027`).
- Tools keep **declaration order** (`trq-0026`).

Nothing errors when these change. The model just chooses differently, which is
the hardest class of divergence to notice in production.

## Enums map in the provider, not in the value object

`ToolChoice` has no backing value. `Auto` → `"auto"`, `None` → `"none"`, and
`Any` → **`"required"`** — the one member whose wire name differs from its own
name (`trq-0012`). A port that derives wire strings by lowercasing the enum
member gets three right and one wrong, and OpenAI rejects the fourth.

Providers differ here. That is the point of the mapping living in the provider.

## Messages map per role, and the roles are shaped differently

Within one payload:

| Role | Shape |
|---|---|
| system | `{"role":"system","content":"…"}` — content is a bare string |
| user | `{"role":"user","content":[{"type":"input_text","text":"…"}, …]}` — content is a parts array |
| assistant | `{"role":"assistant","content":[{"type":"output_text","text":"…"}]}` |
| tool call | its **own top-level item**, `{"type":"function_call", …}` |
| tool result | its own item, `{"type":"function_call_output", …}` |

Three details that catch ports:

- A tool call's `arguments` is a **JSON-encoded string**, not an object
  (`trq-0018`). Unusual enough that a port is likely to "fix" it; OpenAI accepts
  the object and misreads the call.
- An assistant message with empty content emits **no assistant item at all**
  (`trq-0028`) — an empty `output_text` part is rejected.
- `UserMessage.additionalAttributes` is **spread at item level**, as siblings of
  `role` and `content` (`trq-0020`), not nested under a key.

## Serialization

One canonical form, everywhere: UTF-8, no insignificant whitespace, slashes and
non-ASCII unescaped, keys in insertion order. None of the three languages does
this by default. See [decision 0005](../decisions/0005-canonical-json.md).
