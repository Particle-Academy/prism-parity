# 0022 — Local file locks require owner proof

Date: 2026-10-28

Status: Proposed. Maintainer acceptance is required before either port changes
its lock protocol. This decision amends the file-lock ruling in
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
{"version":2,"pid":1234,"nonce":"0123456789abcdef0123456789abcdef","released":false,"expires_at":1793214122}
```

`pid` is a positive integer, `released` is a boolean, and `expires_at` is an
integer Unix timestamp in seconds in both ports. Booleans do not count as
integers. Unknown fields, inconsistent nonce/path values, malformed or partial
records and unexpected directory entries do not confer ownership or recovery
authority. The timestamp is a compatibility hint; passing it never authorizes
stealing a live holder's lock.

The lock directory, like the data directory, is host-owned storage. This is
concurrency control among trusted processes, not an authorization boundary
against an actor who can rewrite another process's lock metadata.

## Reclaim only a proven inactive owner

A contender may reclaim a valid record only when its PID is positively dead,
or when the owner has atomically published `released:true` after its callback
finished. Alive, unknown, permission-denied and malformed states remain held.
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
nonce checks. Recovery may clean a dead owner's known release temporary; an
unknown entry or uncertain empty directory requires refusal or explicit operator
maintenance. Cleanup failures must remain observable and must never modify a
replacement owner's record.

## Migration

Timestamp-only legacy lockfiles have no owner proof. New workers must not steal
them merely because their TTL elapsed. Old workers encounter a directory they
cannot acquire or parse and must remain excluded. Stop old writers before the
upgrade, then explicitly inspect and archive stale legacy lockfiles as operator
maintenance. The library must not infer that an unknown file is abandoned.

No consumer store is inspected or migrated as part of the package's tests.
Existing data-file bytes and default provider requests remain unchanged.

## Evidence required before release

- Real TS/TS, Python/Python and mixed-language processes exclude a contender
  while the original holder remains alive past its old TTL.
- Terminating an owned holder permits recovery; two concurrent reclaimers
  still admit only one callback.
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
