# 0004 — Errors are codes; prose is not the contract

**Status:** accepted, 2026-08-25

## The decision

**Every failure carries a stable machine-readable CODE. The human sentence is
explicitly outside the contract.**

`suites/text-errors` asserts codes and never messages.

## Why

A test that pins error prose holds every implementation to a *translation*. Three
ports would have to word the same failure identically in three languages, and the
first person to improve a message — clearer wording, a better hint, a link to
docs — turns a green build red without changing any behaviour at all.

Worse, the tests then actively discourage the improvement. The suite becomes a
reason not to make error messages better, which is the opposite of what it should
be doing.

Codes are stable, greppable, branchable, and free to be worded differently
everywhere.

## The codes

| Code | Raised when |
|---|---|
| `prompt_and_messages` | Both a prompt and an explicit message list were set |
| `malformed_tool_call_arguments` | A tool call's arguments string is not valid JSON |
| `unknown_message_type` | A message type the provider mapper does not handle |
| `unsupported_provider_action` | A capability the provider does not implement |
| `provider_response_error` | The provider returned an error body |
| `max_tokens_exceeded` | The response stopped on length |
| `tool_loop_not_supported` | A port outside the slice met a tool-call finish |

Loader failures have their own codes, for the same reason:
`duplicate_case_id`, `unsorted_case_ids`, `missing_case_notes`,
`missing_case_since`, `skip_must_be_a_map`, `blank_skip_reason`,
`unknown_skip_language`, `unknown_language`, `corpus_not_installed`,
`suite_id_mismatch`, `empty_suite`, `unknown_probe`.

## The reference does not do this — finding F-1

`particle-academy/prism` identifies its failures by an English sentence and
nothing else. `PrismException` carries no code, so telling "prompt and messages
were both set" apart from "the provider returned an error" means matching on
prose.

That is not a hypothetical cost, and it is visible inside this repository: the
PHP runner's verdict on `text-errors` is reached by `str_contains` on message
text, in the suite whose whole argument is that prose is not the contract. The
shim lives in `runners/php/src/Driver.php::errorCode` and is deliberately placed
in the runner rather than the loader so that it reads as a shim.

Every downstream consumer that needs to branch on a failure is doing the same
thing, which means **every wording improvement in Prism is a silent breaking
change for them**.

The reference has already tripped over its own inconsistency here:
`Providers\Provider::stream()` passes `__METHOD__` to
`unsupportedProviderAction` where every sibling passes a short verb, so that one
message alone reads with a fully-qualified class name. A prose matcher written
against the other twenty would miss it.

**Recommended change.** Add a `code` to `PrismException`, set by each named
constructor. Additive, no behaviour change, and it lets consumers stop parsing
English. Both ports already do this, so the taxonomy above is already implemented
twice and only missing in the reference.
