# 0022 — Local file locks require owner proof

Date: 2026-10-28

Status: Proposed, revised after maintainer review 2026-10-28. Acceptance is
required before either port changes its lock protocol. This decision amends the file-lock ruling in
[agent task lists](../../specs/agent-task-lists.md#the-references-rulings).

## Why

A terminated expiry distinguishes a complete timestamp from a torn write. It
does not prove that the holder stopped running. A real TypeScript worker and a
real Python worker each held a lock past its one-second TTL while awaiting a
release barrier. In both cases a contender entered while the original process
was still alive. Ordinary contention and mixed-language tests had passed.

An address index cannot rely on a lock that expires while its writer is still
publishing pages. The G154 index has one pending append and a logical commit
point in its small head, but concurrent writers can still corrupt it if both
believe they hold the lock. Waiting on an uncertain owner is an availability
cost; admitting a second writer is a correctness failure.

## Scope must match the data

Indexed stores declare both their data sharing scope and their lock scope:
`process < host < distributed`. Missing declarations or a lock narrower than
the protected data produce `index_lock_scope_unsupported` before a resource
write. A session spanning slots uses a lock that covers both slots.

Process-local memory and its process lock are compatible. A local file store
requires a host lock. File stores support one host and local filesystems only;
SMB, NFS and other cross-host filesystems are unsupported and must be stated
as such in each port's public documentation. They are not distributed locks.
The existing refusal of volatile storage in the durable slot remains binding.

This decision changes the shipped TS/Python FileSessionStore protocol. PHP's
shipped SQL and Redis stores have different primitives and are not assigned a
file backend or a new expiry rule by this decision.

## Owner publication

Keep the existing hashed data-key filenames. The corresponding `.lock` path
becomes a directory. A contender creates a private candidate directory, writes
and closes its complete owner record, then atomically renames the populated
candidate to the canonical path. An active owner is never published as an empty
directory. Failure to publish means the callback has not acquired the lock.

The directory contains `owner-<nonce>.json`. The nonce is 32 lowercase hexadecimal
characters. The record is a closed UTF-8 JSON object, terminated by a newline:

```json
{"version":2,"pid":1234,"identity":{"platform":"linux","boot_id":"fixture-boot-identity","pid_namespace":"pid:[4026531836]"},"nonce":"0123456789abcdef0123456789abcdef","released":false,"expires_at":1793214122}
```

`pid` is an integer in 1..4294967295, `released` is a boolean, and `expires_at` is an
integer Unix timestamp in seconds in both ports. Booleans do not count as
integers. Unknown fields, inconsistent nonce/path values, malformed or partial
records and unexpected directory entries do not confer ownership or recovery
authority. The timestamp is a compatibility hint; passing it never authorizes
stealing a live holder's lock.

The identity object has exactly platform, boot_id and pid_namespace. Platform
and boot id are bounded nonempty UTF-8 strings (at most 256 bytes each); the PID
namespace is a bounded nonempty string or null when it cannot be established.
Unknown or unavailable identity is not evidence of death.

A bare PID is meaningful only in its operating-system instance, boot and PID
realm. Linux reads its boot identity from
[/proc/sys/kernel/random/boot_id](https://www.kernel.org/doc/html/v6.6/admin-guide/sysctl/kernel.html#random)
and its PID namespace from
[/proc/self/ns/pid](https://man7.org/linux/man-pages/man7/namespaces.7.html).
[PID namespaces](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)
allow distinct processes to use the same PID. Windows needs an OS boot-session
identity or canonical system boot time, plus an established PID realm where
isolated realms exist; for example the OS exposes
[LastBootUpTime](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-operatingsystem).
Canonical serialization and equal identity across both ports are required
vectors before implementation is accepted; an uptime estimate is insufficient.

Before any PID probe, compare the entire owner identity with the prober's own
established identity. Different boot ids, PID namespaces or platforms are
UNKNOWN and stay held, even if a PID lookup in the prober's realm says missing.
Missing or unreadable identity also stays held. This covers containers sharing
a local volume and WSL/Windows sharing a directory. Matching null/unknown values
do not establish identity and must not authorize a PID probe or reclamation.
A foreign identity does not become reclaimable merely by carrying released:true.
This decision does not
adopt the optional same-machine/different-boot shortcut: it needs separate
machine-identity proof and review before it could authorize reclamation.

The lock directory, like the data directory, is host-owned storage. This is
concurrency control among trusted processes, not an authorization boundary
against an actor who can rewrite another process's lock metadata.

## Reclaim only a proven inactive owner

A contender may reclaim a valid record with matching established identity only
when its PID is positively dead, or when the owner has atomically published
`released:true` after its callback finished. An unreleased live owner, unknown,
permission-denied and malformed states remain held.
Acquisition keeps its bounded wait and returns the existing `session_locked`
refusal when it cannot establish exclusion. PID reuse may conservatively delay
recovery; it must never admit a concurrent holder.

PID probes must be read-only. Node documents signal zero as an existence check
in [process.kill](https://nodejs.org/docs/latest-v24.x/api/process.html#processkillpid-signal).
On Windows, Python's [os.kill](https://docs.python.org/3/library/os.html#os.kill)
uses TerminateProcess for non-control signals: never use `os.kill(pid, 0)` to
probe liveness. Query with OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION),
[GetExitCodeProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getexitcodeprocess)
and CloseHandle. Ambiguous status, including a possible STILL_ACTIVE value,
remains held. POSIX signal-zero errors other than a positively missing PID are
also uncertainty, not permission to reclaim.

Cleanup is bound to the exact observed nonce. Unlink only that owner's filename,
and attempt nonrecursive directory removal only if that unlink succeeded.
An observer whose old filename is already missing must not remove the canonical
directory: it may now belong to a replacement owner. A populated replacement
directory also prevents a stale remover from deleting it. Never recursively
delete a canonical lock directory or rename it away to make reclamation easier.

After its callback finishes, the holder writes a complete `released:true`
record to a temporary filename bound to the same nonce, closes it, and atomically
replaces its owner record. It then performs bounded cleanup using the same
nonce checks. The recognized release temporary is `owner-<nonce>.release.tmp`.
Recovery may clean a dead owner's known release temporary; an unknown entry
requires refusal or explicit operator maintenance. Cleanup failures must remain
observable and must never modify a replacement owner's record.

### Empty canonical directories have platform-specific acquisition semantics

On POSIX, renaming a populated candidate onto an existing empty canonical
directory atomically replaces that directory:
[rename(2)](https://man7.org/linux/man-pages/man2/rename.2.html). That empty
directory has no owner record and can be safely acquired by this operation.
An old remover's later nonrecursive rmdir then fails on the populated
replacement. Do not add an emptiness check followed by a separate deletion.

Windows reports an error when the rename target is an existing directory:
[MoveFileEx](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexa).
Python also documents these differing
[rename semantics](https://docs.python.org/3/library/os.html#os.rename).
The failed Windows rename does not acquire the lock; bounded contention ends
in session_locked, with operator maintenance for a persistent empty directory.
A populated existing directory stays held on both platforms. Tests must cover
POSIX replacement, Windows refusal and the stale-remover interleaving as
separate required rows, rather than making one platform's behavior accidental.

## Migration

Timestamp-only legacy lockfiles have no owner proof. New workers must not steal
them merely because their TTL elapsed. Keep session_locked as the refusal, with
stable operator detail legacy_lock_requires_maintenance naming the canonical
legacy path and the action stop_old_workers_then_inspect_and_archive. It must
not look like unexplained ordinary contention forever.

Release notes must state: **Stop all old workers before upgrading.** Then inspect
and archive stale legacy lockfiles explicitly as operator maintenance. No
automatic TTL cleanup or rolling-upgrade compatibility is promised. The
protocol changes a shipped TS/Python lock format and requires minor releases.
The library must not infer that an unknown file is abandoned.

Published TS0.8.0 and Python0.3.0 workers must be executed against new-format
directories, with old expiry hints and torn/partial metadata, and must neither
enter nor unlink/rename the lock. Include regular legacy-file reclaim controls
to prove those old paths are active. Record native outcomes and attempted
filesystem operations. If coexistence fails, the hard stop remains mandatory,
the failure stays visible and new code detects legacy contenders where possible.
Until this artifact experiment runs, exclusion of old workers is a requirement,
not a verified claim.

No consumer store is inspected or migrated as part of the package's tests.
Existing data-file bytes and default provider requests remain unchanged.

## Evidence required before release

The proposed [review vectors](0022-local-file-lock-vectors.json) distinguish
identity requirements from measured filesystem behavior. Portable experiments
live in [lock-owner-review](../../tools/lock-owner-review/README.md); future
production implementations must still execute every applicable identity and
recovery vector. A primitive experiment is not proof of the complete lock.

- Real TS/TS, Python/Python and mixed-language processes exclude a contender
  while the original holder remains alive past its old TTL.
- Terminating an owned holder permits recovery; two concurrent reclaimers
  still admit only one callback.
- Different boot identities, platforms, or PID namespaces, missing identity and
  unavailable identity probes stay held without consulting an unrelated PID
  space. Same-identity live/dead controls are required in both ports.
- POSIX empty-directory rename acquisition and Windows existing-directory
  refusal are executed on their native operating systems. A stale remover must
  fail to remove the populated replacement.
- Exact published TS0.8.0/Python0.3.0 artifacts exercise new-format populated,
  old-expiry and torn-record directories with zero callback/unlink/rename.
  Legacy expired-file and torn-stamp controls retain their native differences.
- A legacy file yields session_locked plus the stable legacy maintenance detail;
  it is never silently reclaimed, including when its old timestamp expired.
- A deterministic stale-reader/new-owner interleaving proves that a reaper
  cannot delete or release the replacement owner's lock.
- Real writer/reader round trips cover both ports, released-owner cleanup,
  partial and malformed records, unknown entries, legacy files and unknown
  liveness. Unsafe controls fail even if both languages agree.
- Named memory-state/file-durable sessions use the host lock across actual
  processes. Custom stores with missing or narrower declarations refuse.
- Native gates and published-default stored-byte/provider-request comparisons
  pass. Shared format vectors retain the original failure evidence.

This does not authorize erasure. A future erasure planner must recover an index's
pending append or refuse; a pending head is not a complete ownership census.
