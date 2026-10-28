# Decision 0022 review experiments

These exercise filesystem primitives and unchanged published packages. They do
not implement the proposed production lock protocol.

Run `node tools/run-gate.mjs lockPrimitives -- node tools/lock-owner-review/primitives.mjs`
on each native platform. POSIX must atomically replace an empty target
directory, Windows must refuse it, and a populated target/replacement must
survive both a contender and a stale nonrecursive remover.

Five required primitive rows now include directory-to-regular-file rename in
Node and Python. Node/Windows replaces the file; POSIX Node and native Python
on every supported OS refuse and preserve it. This measured residual explains
the mandatory stale-legacy preflight and hard stop in decision0022. Python must
be available (or set PRISM_LOCK_PYTHON); a missing interpreter fails the gate.

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

The Windows CLI records four configurations: no Job, one ordinary owned Job,
two nested owned Jobs and an inherited supervisor Job with one additional
owned Job. The three Job cases retain the ambient chain without breakaway,
verify membership and must pass recovery/foreign controls. An owned supervisor
ensures actual inheritance also exists on an otherwise free hosted runner.

For no-Job only, an owned suspended child requests CREATE_BREAKAWAY_FROM_JOB,
then undergoes an actual membership query. If it is free, it must run all
recovery controls and pass. If membership is retained, it never runs and is
disposed; the row is unmeasured with native checked membership and this exact
reason: ambient supervisor Job cannot be left on this host
(CREATE_BREAKAWAY_FROM_JOB accepted, membership retained). This is no recovery
coverage. Any other setup error fails. A report validator rejects a no-Job pass
without verified nonmembership and refuses missing mandatory contexts.

The substitute guarantee is structural: identity lives separately in
windows-identity.mjs/.cs and may use only the ContainerType registry read and
CIM boot read. The source/import/native-symbol guard fails on Job/silo API
calls or new native imports; deliberate Job-call and fake-report mutations
prove those refusals. Future port implementations need the same guard.
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
