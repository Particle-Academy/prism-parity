# 0010 — Config keys, table prefixes and ability names

**Status:** accepted, 2026-08-25

Raised by the `prism-workspace` agent, which chose sibling-consistency over
safety and flagged the choice rather than burying it. It was right to ask.

## The problem

A satellite package publishes a config file, migrates tables, and defines
authorization abilities. Each of those lands in a namespace the **consuming
application** owns, and a name generic enough to read nicely is generic enough
to collide.

`prism-harness` shipped `config/harness.php`. `prism-workspace` followed it and
would have shipped `config/workspace.php` — a name an application is entirely
likely to want for itself.

## Decisions

### Config files are prefixed: `config/prism-<package>.php`

`prism-memory.php`, `prism-workspace.php`, `prism-mcp.php`, `prism-rag.php`.

A published config file is a filename in someone else's `config/` directory.
`workspace.php` is a name an application may already have; `prism-workspace.php`
is not. The consistency worth having is with the ecosystem's prefix, not with
one sibling's early mistake.

**`prism-harness` is inconsistent with this and will be corrected** in its next
release, reading the old key as a fallback so nothing breaks. Recorded here
rather than quietly left, because a reader comparing the two packages will
otherwise conclude the convention is whatever the last agent did.

### Table prefixes match the package: `<package>_*`

`harness_threads`, `memory_observations`, `workspace_*`. Already the de facto
convention and confirmed. Tables are less collision-prone than config keys and
the shorter form reads better in queries.

### Ability names are `<package>.<verb>`

`workspace.read`, `workspace.write`, `workspace.delete`, `workspace.list`.

The verbs belong to the package that defines them. Where two packages need the
same verb they use the same word — a `read` is a `read` — but they do not share
a namespace, because an application granting `workspace.read` has said nothing
about memory.

Prefixes stay configurable, as `prism-workspace` already made them, so an
application with its own `workspace.read` can move ours out of the way.

## What this is not

Not a shared base package. [0008](0008-consensus-among-agents.md) rejects that:
a common parent makes every package wait on a release of the parent. These are
conventions each package implements for itself, and the manifest is what makes
a deviation visible.
