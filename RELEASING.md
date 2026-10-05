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

### 0. The npm bootstrap publish — do this FIRST or step 1 cannot be done

**A Trusted Publisher is configured PER PACKAGE, so the package has to exist on npm
before there is anything to attach one to.** `@particle-academy/prism-conformance` has
never been published, so the first publish cannot come from this workflow: it has to be
a throwaway manual publish from a machine with an npm login, after which the Trusted
Publisher is configured and every later release comes from CI.

Publish a `0.0.0` placeholder for that purpose — not the real version, so no consumer
can resolve a release that CI did not build:

```
cd loaders/ts
npm version 0.0.0 --no-git-tag-version   # do NOT commit this
npm publish --access public
git checkout package.json                # restore the real version
```

Then do step 1, and only then cut a real tag.

**Provenance of this step, since it shapes what you do:** reported by the Fancy estate,
which hit exactly this when publishing `@particle-academy/fancy-schema` — npm cannot
claim a scoped name through OIDC alone. It is not verified here, because verifying it
means attempting the publish. If npm has since changed and step 1 works without it, skip
this and say so, and this section should be deleted rather than left as folklore.

**PyPI does NOT need this.** Its trusted publishers support a *pending* publisher for a
project that does not exist yet, which is why step 2 below says "pending publisher" —
that path is deliberate and correct there.

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
   git tag -a v0.1.7 -m "Conformance loaders 0.1.7

   No breaking changes."
   git push origin v0.1.7
   ```

   A lightweight tag is refused. Nothing else triggers a publish — there is no
   manual dispatch and no publish-from-a-branch path, because both let a release
   exist that no commit here claims.

   **The annotation must declare its breaking status**, which is why the example
   above carries that second line. The annotation is the only changelog these
   packages have — the release is created from it verbatim — so silence there is
   the answer a consumer gets rather than a neutral default, and the guard
   refuses it the same way it refuses a lightweight tag. Write one of:

   ```
   BREAKING CHANGE: <what breaks, and what the consumer must do about it>
   ```

   ```
   No breaking changes.
   ```

   A `## Breaking changes` heading with content under it also counts, but only if
   you tag with `--cleanup=verbatim` or `-F`: under git's default cleanup every
   `#` line in a tag message is treated as a comment and **deleted**, so a
   heading passed to `-m` is published silently missing. The two forms above have
   no `#` to lose.

   The guard runs before both uploads, so refusing prevents the publish outright.
   You can see the same verdict before tagging:

   ```
   sh tools/check-release-notes.sh --tag v0.1.7
   ```

   Use `--tag`, not a pipe from `git tag -l --format='%(contents)'`: on a
   lightweight tag that format yields the *commit* message instead, so the check
   would read text the release will never publish and approve it.

   This was asked for in prose elsewhere before it was checked, and asking did
   not work: of the twenty most recent annotations across ten of these
   repositories, EIGHTEEN never used the word "breaking" at all. The example this
   file gave above would itself have been refused.

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
