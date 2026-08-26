# 0018 — Which MCP package for which direction

**Status:** accepted, 2026-08-26

## The question

`prism-mcp` and `laravel/mcp` both have "MCP" in the name and both are in scope
for a Laravel application. Adjacent names invite the assumption that they are
alternatives and that one of them is the newer, better choice.

They are not alternatives. They are the two ends of the protocol.

## The decision

| You are… | Use | Because |
|---|---|---|
| **exposing your own tools** over MCP so other agents can call them | `laravel/mcp` | It builds servers, and it builds them well. |
| **consuming a server you do not own** | `prism-mcp` | That is where the trust boundary lives, and the trust boundary is the product. |
| offering **your own** tools to **your own** Prism agent | neither — `Tool::make()` | Prism core already accepts a `Laravel\Mcp\Server\Tool`. No transport, no protocol, no boundary to police. |

`prism-mcp` will not grow a server direction. It is recorded as deferred in that
package's README, and this decision is why: a package whose entire justification
is *what you must not trust about the other end* has no business also being the
other end.

## Why this needed writing down

An operator instructed a team to move a working MCP **server** off `laravel/mcp`
and onto `prism-mcp`, on the reasonable-sounding basis that `prism-mcp` is the
in-house package. The team stopped and asked because the README's deferred table
contradicted the instruction.

That is the right outcome and it was reached by reading a table in one package's
README, which is not a mechanism. Swapping a server onto a client library is the
kind of change that looks correct at review and fails at the first request.

## They do not interoperate yet, and that is not obvious

`prism-mcp` speaks `2026-07-28` only. `laravel/mcp` `v1.0.0-beta.1` implements
the previous revision — `initialize`, then a session. `2026-07-28` removed the
handshake and made the protocol stateless, so these are two protocols wearing
one name rather than two versions of one.

**So a `laravel/mcp` server is not reachable from `prism-mcp` today.** It becomes
reachable when `laravel/mcp` ships `2026-07-28`, and not before.

This is worth stating in a decision because a client and a server published by
one estate read as interoperable by default. The first team to wire them
together discovered otherwise from a JSON-RPC `-32601`, which named a missing
method and said nothing about a version.

Two things changed as a result, and both generalise:

- **The client now reads `-32601` on `server/discover` as a probable revision
  mismatch.** That method is a server MUST in this revision, so a server
  reporting it does not exist is not implementing this revision. The client had
  only ever caught `-32022` — which can *only* come from a server that already
  knows about the new revision and is declining it. Catching the modern half of
  a version-negotiation failure and not the legacy half means the guard misses
  the case that actually happens.
- **The README says the two do not yet talk.** An absence that a reasonable
  reader would not predict has to be written down; see
  [0003](0003-drift-and-existence.md) for the general form of this.

## The general rule

**When two packages in one estate sit at opposite ends of a protocol, say so
where someone deciding between them will read it — and say whether they can
currently talk to each other.**

Interoperability between two packages with the same author is an assumption
people make for free. If it is not true, the cost of finding out lands on them
at wiring time, in the form of an error about something else.
