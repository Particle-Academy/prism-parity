# prism-workspace

**Status:** specified, not built.
**Fills:** a sandboxed filesystem, code execution, reusable skill files.

Read [`docs/patterns/`](../docs/patterns/) and [`docs/decisions/`](../docs/decisions/)
first. This file says only what is particular to this package.

## What it is for

Agents that do work produce artifacts and need somewhere to put them. A coding
assistant writes files. A research agent saves a report. An analysis agent runs
code against data.

This is the place that happens — bounded, so an agent cannot reach outside it.

## What it must not do

**No UI.** No file browser.

**No changes to `prism` core.**

**It does not invent a filesystem.** Laravel's `Storage` already gives scoped
disks with drivers for local, S3 and the rest. A workspace is a scoped disk with
an agent-shaped API over it, not a reimplementation. Rebuilding what the
framework does is how a package acquires a second set of bugs for no capability.

## The shape

```php
$workspace = PrismWorkspace::for($session);

$workspace->write('report.md', $content);
$workspace->read('data.csv');
$workspace->list();

$result = $workspace->run('python analyse.py');   // if execution is in scope
```

## Decisions already taken

**The sandbox boundary is the security property, and it is the whole package.**
A path escaping its workspace is the failure that matters. `../` traversal,
absolute paths, symlinks — every one gets tested, and the tests are the
deliverable as much as the code is.

**Permissions are Laravel Gates.** The harness already decided this for tools:
*may this run* is an authorisation question and Laravel has an answer. Do not
invent a parallel permission system.

**A workspace belongs to a session.** `prism-harness` owns sessions. This
package is addressed by one rather than defining its own identity, for the same
reason memory does not own the conversation.

## Open questions — raise these, do not settle them privately

**Is code execution in scope at all, and if so how is it isolated?**
This is the largest open question in the whole ecosystem and it must not be
answered casually. Running model-generated code is a remote-code-execution
surface by construction. Options run from *not at all*, through a container
runtime, to a hosted sandbox API.

The honest first answer may be **files only, execution deferred** — a
filesystem is genuinely useful alone, and shipping execution badly is worse
than not shipping it. Do not treat that as timidity; treat a half-isolated
sandbox as the more expensive mistake.

**What is a skill file?** Mastra has reusable skill files and the phrase is
doing a lot of work. Prompt fragments? Tool definitions? Executable? Until that
is answered concretely it should not be built.

**Lifetime.** Does a workspace outlive its session, and who deletes it? A
package that accumulates unbounded artifacts on a customer's disk with no
cleanup path is a support ticket with a delay fuse.

## First slice

Scoped read/write/list against a Laravel disk, with the escape-attempt tests
written first and confirmed failing before the guard exists. Execution stays
out of the first slice unless the isolation question has a real answer.
