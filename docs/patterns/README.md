# The Prism patterns

**This is the one place each pattern is described. Every port's documentation
LINKS here rather than restating it.**

That rule is the whole mechanism, and it is not a style preference. Restated
documentation drifts exactly like restated code, and nothing tests prose. A
conformance corpus pins behaviour at the boundary; it says nothing about whether
two packages *teach* the same model. The only thing that keeps the model single
is there being one copy of it.

So: if you are writing a port and reach for an explanation of what
`withPrompt()` means, link to the page here. If the explanation here is wrong or
missing, fix it here.

## The shape

```
Prism::text()          →  a capability entry point
  ->using(…)           →  a pending request: a mutable builder
  ->withPrompt(…)      →  …accumulating configuration
  ->asText()           →  freeze to an immutable Request, hand to a Provider,
                          get a Response
```

Five things, and every capability has the same five:

| | | Pinned by |
|---|---|---|
| **Entry point** | `Prism::text()`, `Prism::structured()`, … Returns a fresh pending request and nothing else. | — |
| **Pending request** | A fluent, mutable builder. Every method returns `$this`. Nothing is validated here. | [02](02-pending-request.md) |
| **Request** | The frozen, immutable snapshot `toRequest()` produces. Validation happens at the freeze, not before. | [02](02-pending-request.md) |
| **Provider** | One class per vendor, with a method per capability. Unsupported capabilities THROW rather than degrade. | [03](03-provider-contract.md) |
| **Response** | The result, plus the messages that produced it, plus the raw provider body. | [06](06-response-parsing.md) |

## Pages

| Page | Enforced by |
|---|---|
| [01 — The model](01-the-model.md) | — |
| [02 — The pending request](02-pending-request.md) | `openai-text-request` |
| [03 — The provider contract](03-provider-contract.md) | `text-errors` |
| [04 — Messages and value objects](04-messages.md) | `value-object-roundtrip` |
| [05 — Request mapping](05-request-mapping.md) | `openai-text-request` |
| [06 — Response parsing](06-response-parsing.md) | `openai-text-response` |
| [07 — Errors](07-errors.md) | `text-errors` |

Each page names the suite that enforces it. A page with no suite is a claim; say
so on the page rather than letting it read like a guarantee.

## Naming across languages

The **call sequence** is the contract. The **spelling** is idiomatic.

| Canonical (PHP, TypeScript) | Python |
|---|---|
| `Prism::text()` | `Prism.text()` |
| `->using('openai', 'gpt-4o')` | `.using("openai", "gpt-4o")` |
| `->withPrompt(…)` | `.with_prompt(…)` |
| `->usingTemperature(…)` | `.using_temperature(…)` |
| `->asText()` | `.as_text()` |

The corpus names calls in the canonical spelling and each runner maps them. See
[decision 0002](../decisions/0002-idiom-vs-identity.md) for where idiom stops.
