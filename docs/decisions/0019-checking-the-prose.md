# 0019 — Checking the prose

**Status:** accepted, 2026-08-26

## The gap

This ecosystem has two mechanisms and they cover the same half of the problem.
The corpus catches **drift** — two implementations disagreeing. `parity-check`
catches **existence** — a mirror that was never built. Both look only at code.

Neither reads a word of documentation, and the patterns page says why prose is
dangerous in the same breath as relying on it: *"nothing tests prose."* That was
stated as a reason to keep one copy of the model. It is also, unmodified, an
admission that a whole category of assertion in this repository has never been
checked by anything.

It was not theoretical. Every one of these was live, and every one was found by
a person reading rather than by a machine:

| | |
|---|---|
| `prism-harness` | Every README example called `PrismHarness::for($user)`. There was no facade. Anyone who copied one got a fatal error. |
| `prism` docs | The xAI page imported and instantiated `Prism\Prism\Schema\IntegerSchema`, which has never existed. |
| `prism` doc site | Two providers, Replicate and Qwen, had never rendered in the sidebar: one object literal carried three `text`/`link` pairs, and JavaScript keeps the last. |
| `prism-memory`, `prism-workspace` | READMEs opened with `composer require`, for packages that are not on Packagist. |
| `prism-parity` | Decision 0009 linked `../specs/README.md`, one level short of the file. |
| `prism-mcp` | The MCP spec page cited "decision 0009" twice; the binding decision is 0014. |

## The decision

**A statement in prose that something exists, is named a certain way, or can be
run is a CLAIM, and claims are checked mechanically.** `tools/factcheck.mjs`
extracts them and verifies each against the code.

| Claim | Verified against |
|---|---|
| `use A\B\C;` in a php block | a class under some repo's psr-4 root |
| `php artisan <ours>` | a command declaring that name |
| `composer require particle-academy/…` | the published census, or a `"type": "vcs"` block on the same page |
| `composer <script>` / `npm run <script>` | that repo's manifests |
| `decisions/NNNN-slug`, "decision NNNN" | a file in `docs/decisions/` |
| `it('…')` cited in prose | a test of that name in that repo |
| relative and site-absolute links | the filesystem, and the site's content root |
| repeated keys in a config object literal | each other |

## What makes it honest rather than decorative

**Unresolved is a third verdict, and it is counted out loud.** A claim about a
package that is not checked out is not a pass. Single-repo CI cannot be mistaken
for full coverage, because the run prints how many claims it could not resolve.

**Ambiguity warns; certainty fails.** A relative link either resolves or does
not, so it fails. A site-absolute link is rooted wherever the site's routing
says — possibly a vendored directory — so it warns. A checker that cries wolf
gets switched off, and that costs more than the links it would have caught.

**Deliberate counter-examples are supported, and cost a reason.** A page that
shows a wrong name in order to warn against it is doing its job. The
`<!-- factcheck-ignore-next: … -->` directive requires an explanation, so a
suppression stays reviewable rather than becoming a quiet way to switch the
check off. The skill file teaching *"these namespaces do not exist"* is the case
that forced this.

**Cross-repo claims are attributed, not exempted.** The shared guide documents
other repos' commands and already marks which with a trailing `# prism-ts`. The
checker honours that comment. Exempting the file would have been easier and
would have left the most-read, least-owned page unchecked.

## The part that matters most: the checker's own staleness

A fact-checker that has quietly stopped working reports green over
documentation nobody has verified. That is **worse than having no checker**,
because it manufactures confidence. So `factcheck.lock.json` records two things
per repo, and both are staleness signals:

**VERSION.** What the repo was when its claims were last reconciled. A repo that
has released since has not been re-verified against these rules, and a release
is exactly when an API moves.

**CENSUS.** How many claims of each kind were found at reconcile time. If a rule
breaks — a regex stops matching, a directory is renamed, a doc format changes —
the claim count collapses toward zero and every remaining claim passes. **A
green run over zero claims is the failure this catches, and nothing else would.**

`--reconcile` re-records both, and **refuses to run while any real finding is
outstanding.** Reconciling over a live failure would record "verified" against
documentation that is currently wrong, which is precisely the lie the lockfile
exists to prevent.

## Where it runs

In each repo's CI, with `prism-parity` checked out as `.parity`, the same way
the corpus loaders already arrive. In the envelope it discovers its siblings and
checks everything at once.

`--json` is a stable contract, so the Lab's agents can run it, read the
findings, and file a 0L when documentation and code have parted company —
[0017](0017-the-0l-report-format.md).

## The limit, stated

This checks that a named thing EXISTS. It does not check that the surrounding
sentence is true. A README can describe a method's behaviour incorrectly and
pass every rule here, because the method is real.

That limit is the same shape as the one in
[0017](0017-the-0l-report-format.md): the corpus detects disagreement, not
correctness. Knowing which half a mechanism covers is the difference between a
guard and a comfort.
