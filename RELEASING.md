# Releasing the conformance loaders

This repository publishes **three packages from one tag**, because they are the
same corpus in three languages:

| Package | Registry | Source |
|---|---|---|
| `@particle-academy/prism-conformance` | npm | `loaders/ts` |
| `prism-conformance` | PyPI | `loaders/py` |
| `particle-academy/prism-conformance` | Packagist | `loaders/php` |

A consumer installs one of these so that its corpus test reads the rows from a
package instead of a copy committed into its own repository. That is the whole
point: a hand copy is a duplicate that nothing checks, and a published version is
a pin someone has to change deliberately.

## One-time setup — not yet done

`.github/workflows/publish.yml` exists and will refuse to publish until these are
in place. **None of them can be done from this repository**; each is an account
action on the registry.

### 1. npm Trusted Publisher

On npmjs.com, for `@particle-academy/prism-conformance`, add a trusted publisher:

- Repository: `Particle-Academy/prism-parity`
- Workflow filename: `publish.yml`

There is no npm token to create or store. The workflow authenticates with OIDC,
which is also what lets npm attach a provenance attestation to the tarball.

**The workflow filename is part of the binding.** Renaming `publish.yml` breaks
publishing until the npm entry is updated to match.

### 2. PyPI trusted publisher

On pypi.org, for `prism-conformance`, add a pending publisher:

- Owner: `Particle-Academy`
- Repository: `prism-parity`
- Workflow: `publish.yml`
- Environment: `pypi`

Then create a GitHub environment named `pypi` on this repository. The workflow's
publish job declares `environment: pypi`, so the trusted publisher will not match
without it.

As with npm, there is no API token. Do not add one.

### 3. Packagist

Submit `https://github.com/Particle-Academy/prism-parity` to Packagist once, as
`particle-academy/prism-conformance`. Packagist reads tags from GitHub, so the PHP
loader needs no workflow step — but note that it publishes the WHOLE repository at
that tag, with `loaders/php/composer.json` naming the package.

### 4. Both names are claimed permanently

npm names cannot be freely released after 72 hours and PyPI names are effectively
forever. Decide the names are right before the first tag, because the first tag is
what claims them.

## Cutting a release

1. Update `VERSION` and every loader's declaration **together**:
   - `VERSION`
   - `loaders/ts/VERSION` and `loaders/ts/package.json`
   - `loaders/py/pyproject.toml`
   - `loaders/php/VERSION`

   The guard job checks all five against the tag and fails on any mismatch. They
   are five files because three languages each want their version where their
   tooling looks for it — not because they may differ.

2. Regenerate the loader fixture copies and commit them:

   ```
   node tools/sync-corpus.mjs
   ```

3. Push to `main` and let CI finish. The guard job requires a **successful run of
   `cross-check.yml`, `loaders.yml` and `corpus.yml` for the exact commit being
   tagged**, so a release cannot be cut from a commit whose comparison never
   passed.

4. Tag, annotated, and push the tag:

   ```
   git tag -a v0.1.7 -m "Conformance loaders 0.1.7"
   git push origin v0.1.7
   ```

   A lightweight tag is refused. Nothing else triggers a publish — there is no
   manual dispatch and no publish-from-a-branch path, because both let a release
   exist that no commit here claims.

5. Watch the `verify` job. It is not decoration: a green publish job means the
   registry accepted an upload, not that it serves the version. `verify` polls
   both registries and then opens the published Python artifact to confirm
   `suites/` is actually inside it.

## What the guards are for

Each one exists because of a failure this estate has actually had, so read before
removing.

- **Tag matches every declared version.** Three artifacts claiming one version
  while carrying different rows is worse than a failed release, and no registry
  lets a version be replaced.
- **Fixtures match `suites/`** (`sync-corpus.mjs --check`). Publishing a loader
  whose generated copy has drifted would ship rows that disagree with this
  repository — the exact defect publishing is meant to remove, now versioned and
  cached by three registries.
- **The corpus workflows succeeded for this sha.** A release that assumes green is
  the failure this ecosystem keeps finding in its own work.
- **The npm package carries `src`, `suites` and `probes`.** A loader published
  without `suites/` installs and imports perfectly and then finds no rows. npm
  does not consider that an error.
- **`id-token: write` is never held by a job that runs build code.**
  `python -m build` installs a backend from PyPI; anything it runs could otherwise
  mint the token that publishes.

## Never rewrite a published tag

A tag that has been published is a tag consumers may already resolve. Fixing a bad
message or a wrong artifact means a NEW version, never a re-tag. This has been
learned here the hard way: re-tagging a published version broke source installs
for everyone who had already resolved it.
