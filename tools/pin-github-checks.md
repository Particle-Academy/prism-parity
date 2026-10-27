# Shared GitHub checks

`pin-github-checks.mjs` pins every checkout of `Particle-Academy/.github` to
the reviewed commit in `pin-github-checks.config.json`. The immediately following
verification step checks both the commit identity and the LF-normalized SHA256
of `check.mjs`, `gate-graph.mjs` and `allowlist.json` before any fetched code runs.
The existing read-only guard jobs and publishing permissions remain intact.

The tool and independent structural checker were adapted from Fancy's
`.ai/tools/pin-github-checks*` on 2026-10-27. They use only Node built-ins. Prism
also checks that the verifier's executable body matches its generated form;
matching hash declarations with a no-op or conditional verifier are refused.

The verifier clears the ordered joint Prism/Fancy set of eleven Node, shell
and dynamic-loader variables and starts in
`github.workspace` under an explicit bash shell. It uses the existing `node`
runtime; it adds no setup-node step and assumes no tool-cache layout. Existing
Node selections and matrix inputs are preserved. The checker refuses
workflow/job/step execution-hook variables case-insensitively, inherited shell
defaults, job containers, YAML merges and environment maps it cannot read
statically. PATH is protected statically rather than blanked. Every earlier run
step and every earlier action except checkout/setup-node is refused, even when
its text does not name an environment file. The block's own exact verifier is
the sole trusted run exception. The rewriter moves the shared check block before such
writers while preserving every ordinary step and its inputs. The gate uses
the verified checkout immediately after its verifier in the same job; gate-step
env/shell overrides and paths redirected by working-directory or a preceding
command are refused. Only the existing literal `tools/run-gate.mjs` and
`prism-parity/tools/run-gate.mjs` allowlist metric wrappers are accepted; cleanup after the
final gate retain their behavior. Fetched
code cannot run in an artifact producer whose output a write-capable job consumes.

For a local repository:

```sh
node tools/pin-github-checks.mjs --check --repo .
node --test tools/pin-github-checks.test.mjs tools/pin-github-checks-hijacks.test.mjs tools/scan-github-checks.test.mjs
```

For a sibling checkout tree, use `--root /path/to/repos`. Without `--check`,
the tool rewrites workflows using the configured pin. Review the diff before
committing. A new pin requires reviewing upstream changes, re-deriving the
executable input closure, and updating the configuration's commit and hashes
before re-running the rewriter. The hashes are over LF-normalized bytes, so
Windows line-ending conversion does not invalidate an otherwise identical file.

`scan-github-checks.mjs --check` enumerates the live, paginated organization
inventory, resolves each default branch to a commit and reads all workflow blobs
at that identity. It checks newly discovered `prism*` repositories even when
the configuration does not list them. Known repositories absent from the live
inventory are `UNCHECKED` and fail; API failures, truncated trees and an empty
inventory also fail. Remote workflows are parsed as data and never executed.
The config's repository list is a visibility floor, not a discovery allowlist.

Each repository must use the global pin unless `pinOverrides` lists an exact
repository name with its reviewed commit and complete input hashes. Before
accepting a different pin, the live scan resolves `.github` main and uses the
GitHub compare API to verify that the override is a newer descendant of the
global pin and is on that main snapshot. Older, diverged, unlisted and non-main
pins refuse; an API failure leaves the scan UNCHECKED. An old pin could retain
a revoked dependency approval. Output records every repository's effective pin.
Human+ alone temporarily uses the approved PSR-7 grant at `1a1fad0`; the global
pin and all other repositories remain at `b3b5e49`. Remove the override at the
next deliberate global repin. Local rewriter/check commands use one explicit
source pin; they do not select an override from workflow content.

The standing scan runs on every alignment invocation, using the ordinary
read-only workflow token. Every package and app repository in scope is public.
`prism.agi` is the explicitly excluded workspace envelope: it drives CI and has
no CI workflows of its own. Missing known repositories still fail as UNCHECKED.
Merge the estate's workflow pin PRs before the parity scanner PR.

The verifier deliberately uses `PIN_DIR` and bare filenames. Spelling
`third-party/check.mjs` inside the verification step would let the dependency
gate graph mistake the verifier for the dependency allowlist itself.
