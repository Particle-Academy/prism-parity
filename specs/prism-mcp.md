# prism-mcp

**Status:** first slice built — the client, over Streamable HTTP, speaking MCP
`2026-07-28`. Repository: https://github.com/Particle-Academy/prism-mcp
**Fills:** Model Context Protocol — server and client.

> **The open questions below are now answered** in
> [decision 0014](../docs/decisions/0014-consuming-untrusted-mcp-tools.md).
> They are left in place because a spec is the thing that was disagreed with,
> and editing the question out would leave only the answer.

Read [`docs/patterns/`](../docs/patterns/) and [`docs/decisions/`](../docs/decisions/)
first. This file says only what is particular to this package.

## What it is for

MCP is how tools and context reach agents across process and vendor boundaries.
Two directions, and they are different jobs:

- **Server** — expose a Laravel application's capabilities so any MCP client
  (Claude Code, Cursor, another agent) can use them.
- **Client** — let a Prism agent consume tools from an MCP server it does not
  own.

## What it must not do

**No UI.**

**No changes to `prism` core.** Core has `PrismServer`, which serves agents
behind an OpenAI-compatible endpoint. That is a different protocol solving a
different problem and it stays where it is.

**It does not duplicate `laravel/mcp`.** Laravel has a first-party MCP package.
Check what it covers before writing anything: the useful work may be a bridge
between it and Prism's tool abstraction rather than a protocol implementation.
Writing a second MCP server for Laravel because the first was not read would be
the most avoidable mistake available here.

## The shape

Client — an MCP server's tools become Prism tools:

```php
$tools = PrismMcp::client('https://example.com/mcp')->tools();

Prism::text()->withTools($tools)->withPrompt($question)->asText();
```

Server — the inverse, exposing Prism tools over MCP.

## Decisions already taken

**The drift watcher already tracks the MCP spec.** `prism-provider-watch` has
an `mcp` target, so protocol changes arrive as drift reports rather than as
surprises. Use that rather than pinning a spec version and forgetting it.

**A remote tool is untrusted input.** Tool descriptions from a server you do not
own reach the model as instructions. That is a prompt-injection surface, and it
is the reason this package needs a security section rather than a note. Say
plainly in the docs what a consumer is trusting when they connect.

## Open questions — raise these, do not settle them privately

**What does `laravel/mcp` already do?** Answer this first. It changes whether
this package is a protocol implementation or a thin bridge, and those are very
different amounts of work.

> **Answered.** As of `v1.0.0-beta.1` (2026-08-14) it ships a full client —
> stdio and Streamable HTTP, OAuth with DCR and PKCE, protocol `2026-07-28`,
> pagination, timeouts, serializable connections — documented in the Laravel
> 13.x docs. Its stable line, `v0.9.4`, has no client at all. It has no trust
> boundary, no client-side caching, and no permission model. `prism-php/relay`
> also already exists and is two protocol eras stale. Decision 0014 records why
> the answer was still to build a client rather than adopt or fork one.

**Transport.** stdio, SSE, HTTP — which are in scope, and does the client need
to survive a server that disconnects mid-call?

**Does a consumed tool run with the same permissions as a local one?** The
harness gates tools on Laravel Gates. A tool from a remote server plausibly
deserves a stricter default than one the application wrote itself, and
defaulting them the same is a decision rather than an oversight.

## First slice

The client, against one transport, with remote tools mapping onto Prism's
`Tool` — and the trust boundary documented before anything connects anywhere.
