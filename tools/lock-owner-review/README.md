# Decision 0022 review experiments

These exercise filesystem primitives and unchanged published packages. They do
not implement the proposed production lock protocol.

Run `node tools/run-gate.mjs lockPrimitives -- node tools/lock-owner-review/primitives.mjs`
on each native platform. POSIX must atomically replace an empty target
directory, Windows must refuse it, and a populated target/replacement must
survive both a contender and a stale nonrecursive remover.

Run `node tools/run-gate.mjs lockIdentityRecovery -- node tools/lock-owner-review/identity-recovery.mjs`
on each native platform. A separate holder independently reads its boot/realm,
publishes an unreleased owner and stays alive until an IPC barrier. A live
owner stays held, that owned child exits without release, and its proven-dead
nonce is unlinked before nonrecursive removal and populated replacement.
Foreign-realm, foreign-released and both-unknown records remain byte-identical
without any PID lookup. Native identity setup failures fail this positive
gate; an unavailable identity is not counted as successful recovery.

Linux uses boot_id plus the PID namespace link. macOS uses kern.bootsessionuuid
plus darwin:kernel. Windows uses exact CIM LastBootUpTime UTC ticks and the
read-only, 64-bit-view ContainerType query specified in decision 0022. An absent
value establishes win32:kernel; a present value or query error is unknown.
No ordinary/nested Job membership shortcut is used for identity.

The Windows CLI executes four actual process configurations: no Job, one
ordinary Job, two nested Jobs and an inherited supervisor Job with one
additional owned Job. It launches only owned suspended children
using CREATE_BREAKAWAY_FROM_JOB, verifies initial no-Job membership, assigns
its own bounded-lifetime Jobs, verifies each membership, then resumes. The
fourth child does not request breakaway and retains the ambient chain. An
owned supervisor ensures an inherited Job also exists on an otherwise free
hosted runner. All four must establish host identity and pass recovery/foreign controls. A
supervisor that prevents breakaway makes setup fail; inherited rows still run.
The gate does not
relabel an ambient Job as the no-Job row. The exported diagnostic option
windowsJobCases(true) can measure extra ordinary/nested Jobs under such a
supervisor, but emits no gate verdict and explicitly leaves no-Job unmeasured.
No container is created; actual container-path execution remains unmeasured.

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
