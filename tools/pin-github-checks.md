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

The verifier clears Node and shell startup hooks and starts in
`github.workspace` under an explicit bash shell. It uses the existing `node`
runtime; it adds no setup-node step and assumes no tool-cache layout. Existing
Node selections and matrix inputs are preserved. The checker refuses
workflow/job execution-hook variables and inherited shell defaults. It also
refuses earlier run bodies mentioning `GITHUB_ENV` or `GITHUB_PATH`, and known
environment-writing setup actions (checkout and setup-node are the explicit
trusted exceptions). The rewriter moves the shared check block before such
writers while preserving every ordinary step and its inputs. The gate uses
the verified checkout immediately after its verifier in the same job. Fetched
code cannot run in an artifact producer whose output a write-capable job consumes.

For a local repository:

```sh
node tools/pin-github-checks.mjs --check --repo .
node --test tools/pin-github-checks.test.mjs tools/scan-github-checks.test.mjs
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

The standing scan runs on every alignment invocation, using the ordinary
read-only workflow token. Every package and app repository in scope is public.
`prism.agi` is the explicitly excluded workspace envelope: it drives CI and has
no CI workflows of its own. Missing known repositories still fail as UNCHECKED.
Merge the estate's workflow pin PRs before the parity scanner PR.

The verifier deliberately uses `PIN_DIR` and bare filenames. Spelling
`third-party/check.mjs` inside the verification step would let the dependency
gate graph mistake the verifier for the dependency allowlist itself.
