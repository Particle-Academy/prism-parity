# Decision 0022 review experiments

These exercise filesystem primitives and unchanged published packages. They do
not implement the proposed production lock protocol.

Run `node tools/run-gate.mjs lockPrimitives -- node tools/lock-owner-review/primitives.mjs`
on each native platform. POSIX must atomically replace an empty target
directory, Windows must refuse it, and a populated target/replacement must
survive both a contender and a stale nonrecursive remover.

Run `node tools/run-gate.mjs publishedLockCoexistence -- node tools/lock-owner-review/published-coexistence.mjs`.
Set PRISM_LOCK_PYTHON to choose a Python executable; otherwise it uses python.
The experiment downloads exactly TS0.8.0 and Python0.3.0 from fixed registry
URLs, verifies their frozen SHA256 values before extraction and executes them
without dependency installation or package scripts. Set PRISM_LOCK_WORK_PARENT
to retain the evidence below a chosen directory; otherwise it uses a new
temporary directory.

Each published worker faces a populated owner directory, a directory with an
old expiry/mtime and a partial owner record. All must retain the directory
unchanged and report refusal with no callback or unlink/rename attempt. Node
filesystem trace events and Python's runtime audit hook observe those attempts.
Regular expired-file controls prove reclamation and its observer are active.
The native torn-stamp difference is preserved: TS reclaims an old unterminated
stamp using mtime; Python holds it.

No consumer directory, credential, database, live model or ambient authorization
is read. The experiment retains its owned directories and traces; it performs
no recursive cleanup. The production migration still requires stopping all old
workers before upgrading.
