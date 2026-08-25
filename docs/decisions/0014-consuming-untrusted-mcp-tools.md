# 0014 — Consuming tools from a server we do not own

**Status:** accepted, 2026-08-25

Recorded because `specs/prism-mcp.md` left these open and
[0008](0008-consensus-among-agents.md) says an open question is escalated, not
resolved privately. All four were escalated and answered by the maintainer.
They bind any package in this ecosystem that consumes a third-party tool
surface — which will not stay being only `prism-mcp`.

## The question behind all four

**A tool definition from a party we do not control reaches the model as
instructions.**

Not as data the model summarises. As text it follows. And unlike every other
untrusted input a Laravel application handles well, there is no escaping
step available: instruction and data are the same channel to a language model.
The MCP specification says as much — *"descriptions of tool behavior such as
annotations should be considered untrusted, unless obtained from a trusted
server"* — and then leaves every client to decide what to do about it.

Every framework in the field decided the same thing: treat connecting as
consenting. That is the decision being reversed here.

## 1 — Build a client, do not adopt one

**Decided: `prism-mcp` implements its own MCP client, built in slices, with the
manifest tracking what is not yet covered.**

The alternative was real and was weighed seriously. `laravel/mcp` v1.0.0-beta.1
ships a good client — stdio and Streamable HTTP, OAuth with dynamic client
registration and PKCE, protocol `2026-07-28`, pagination, timeouts, connections
that survive a queue job. Adopting it and shipping only the trust layer would
have been less code by a wide margin.

Three things decided against it. It is a **beta** with no stable date. Its
release line is split — `main` carries 1.0 betas while `0.x` is separately
maintained — so "which version" is not a simple question. And the ecosystem
wants to support MCP features for its own applications that are not yet
standard, which is not something to negotiate through somebody else's release
cycle.

**Forking `prism-php/relay` was considered and rejected.** It is the existing
Prism MCP client, it is 2,273 lines, and forking is exactly what was done for
`prism` itself. It does not survive the comparison:

- Its architecture is built around the pre-`2026-07-28` stateful `initialize`
  handshake. That revision removed `initialize` and made the protocol
  stateless. The transport layer would be deleted, not updated.
- Its tool mapping guesses a tool's calling convention from its parameter names
  (`isUrlBasedTool`, `isSelectorBasedTool`, `hasScriptParameter`). That is the
  core of the package and all of it has to go.
- Renaming to `Prism\Mcp\` and `particle-academy/prism-mcp` discards the git
  history that made forking `prism` worth doing.

The `prism` fork was worth it because 100k+ lines of provider mappings carried
real value. Relay's value is two ideas — cache the tool list, namespace tool
names per server — and ideas port without a fork. Both are carried forward.

**Relay is superseded via `replace`.** An aggressive claim, made deliberately:
two MCP clients installed together produce two differently-namespaced tool sets
from one server, and relay pins protocol `2024-11-05` on a transport now
formally deprecated.

**The lesson that generalises:** fork when the existing thing's *substance* is
what you need and it is merely stale. Rewrite when its *architecture* is what
changed underneath it. Relay is stale in the way that means rewrite.

## 2 — Discovery is deny-by-default, and refuses loudly

**Decided: a server with no explicit trust declaration REFUSES. Connecting is
not consent.**

Not "warn", not "allow with a log line". The refusal happens **before any
request is sent**, so a misconfigured application never even tells the server it
has an audience.

Two refusals, not one: a **missing** allowlist and an **empty** one are
different mistakes and get different sentences. The empty one is the more
dangerous, because it looks configured — the model silently receives zero tools
and the run reads as *the model choosing not to use any*. That is the
[Perplexity `withTools()` failure mode](../patterns/03-provider-contract.md)
exactly: a plausible answer with nothing indicating something was dropped.

The ad-hoc form (`PrismMcp::client($url)`) refuses identically. Exempting the
exploratory path to make trying a server out convenient would put the hole
precisely where the exploration happens.

**Definition pinning** is the corollary. A local tool changes when someone
deploys; a remote one changes whenever the third party likes, between two calls.
A digest of what was reviewed, refused loudly on mismatch, is the only rug-pull
defence that holds — because it needs to notice *change*, not recognise malice.

## 3 — Gating is a contract, with adapters, and neither is required

**Decided: ship a `ToolGate` contract with adapters for Laravel Gates and for
Fancy's FMS. Hard-depend on neither.**

The brief assumed `prism-harness` already gates tools on Laravel Gates. **It
does not** — its README lists permissions as planned and `src/` has no Gate
reference. So this became the convention rather than matching one, and
`prism-harness` implements the same contract when its permissions land.

The two mechanisms answer **different questions** and the distinction is
load-bearing:

| | Question | Right for |
|---|---|---|
| Laravel Gates | **Authorization** — may this actor perform this action? | "May this user run `delete_repository`?" |
| FMS | **Entitlement** — is this subject granted this capability? | "Which servers may this tenant reach?" |

FMS's own contract makes the distinction explicitly: it added `isEntitled()` as
a named alias *"so a call site declares which of the two questions was being
asked"*. Wiring entitlement to an authorization question means a lapsed
subscription decides whether a destructive action is permitted.

`particle-academy/laravel-fms` also requires **PHP 8.4 and Laravel 13**, against
PHP 8.2+ / Laravel 12+ everywhere else here. A hard dependency would make the
consuming package the narrowest in the ecosystem for a capability most
consumers will not reach for. Hence `suggest`.

**Two gates in sequence, not one.** Trust decides whether the model is ever
*told* a tool exists. The gate decides whether an actor may *run* it. Collapsing
them into one check loses the distinction between "this tool should not be in
the prompt at all" and "this user may not use it".

## 4 — Tool results are guarded; injection scanning is refused

**Decided: bound, frame, and expose a filter hook. Do not pattern-scan.**

The discussion around MCP treats tool *descriptions* as the injection surface.
The **result** path is worse and gets less attention: a description is read once
at discovery, while a result arrives mid-run, already framed as the trusted
output of a tool the model itself chose to call.

Judged on **stability → security → efficiency**, in that order:

- **The size cap wins on all three.** An unbounded result is a stability failure
  before it is a security one — it evicts the system prompt and the run then
  fails somewhere unrelated with an error naming a token count. It is also
  unbounded cost: a remote party choosing your token spend. It **refuses rather
  than truncates**, because a cut result reads to a model as a complete one.
- **Framing is a mitigation and is documented as one.** A per-call random nonce,
  so a server that learns the delimiter cannot close it early. It gives the
  model information it otherwise lacks. It is not a guarantee.
- **Pattern-scanning for injection is refused outright.** MCP's own maintainers
  published the argument on 2026-03-16: nothing static *"tells the model to
  ignore malicious instructions it reads"*, and a guarantee against exfiltration
  *"is a job for network controls or sandboxing, not a boolean hint."* A check
  that does not hold is worse than none, because someone will rely on it.

**The error path counts as a result path.** Prism turns a thrown tool exception
into a `ToolError` the model reads, so a guard applied only to success is not a
guard. This was a real hole in `prism-mcp`'s first draft, found by the
pre-commit security review and fixed before the first commit.

## What this costs

One line of configuration per server, and a refusal the first time someone
forgets it. That refusal will be reported as a bug. It is not one.

## What it buys

An application that installs one of these packages finds that a third party
cannot address its model without somebody on this side having said so — and that
what they said stays said, because a definition that changes underneath is
refused rather than obeyed.

Everyone else's default is the opposite. That is the differentiator, and it is
worth more than transport coverage.
