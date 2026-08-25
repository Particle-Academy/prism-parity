# 0013 — An exception needs a test at its boundary, not at its centre

**Status:** accepted, 2026-08-25

Found by the `prism-memory` agent while writing a paragraph it had been asked
to write. The paragraph was the whole task; discovering the hazard was a side
effect of having to state the rule precisely.

## What happened

`prism-memory` carves out a local exception to an ecosystem-wide axis. Storage
keeps absent and null apart for every metadata key, as
[0007](0007-reference-language-limits.md) requires. `Provenance` — which
interprets the reserved `source_*` keys — deliberately reads an explicit null
and an absent key as one state, because for provenance the two carry no
different meaning.

Both rules are correct. **They live at different layers, and the danger is the
crossing between them.**

A port told *"absent and null are the same for provenance"* can quite
reasonably drop null `source_*` keys **on write**. That is wrong. The store
attaches no meaning to any key and must not normalise one away — the collapse
belongs to the interpretation, not to the storage.

## Why the suite could not catch it

There was already a test named `distinguishes a metadata key that is null from
one that is absent`. It uses an **ordinary** key.

So a store that special-cases `source_*` passes it. Demonstrated rather than
assumed: with the store mutated to drop null `source_*` keys on write, **the
entire 32-test store suite passed** and only a newly written case failed.

The axis was tested. It was tested in the one place the exception did not
apply.

## The rule

**Where a package carves out a local exception to an ecosystem-wide rule, the
test that pins the rule must sit at the exception's boundary.**

Testing the rule at its centre — a case the exception does not touch — proves
the rule holds where nothing threatened it. The failure mode is not a missing
test; it is a present, passing, correctly-named test that cannot fail for the
reason you care about.

This is [0003](0003-drift-and-existence.md)'s discrimination problem in a new
place, and the same sentence applies: a table every plausible implementation
passes proves nothing. Here, a rule tested only where it cannot be violated is
a rule nothing is checking.

## Applying it

When you write an exception, write the case where the exception meets the rule:

- the reserved key carrying an explicit null, round-tripped through the layer
  that must not collapse it
- both directions of the collapse, at the layer that must
- and a check that the collapse cannot leak back — in this case, that the
  interpreting object never emits a null, so its answer cannot become storage's
  input

Then break it at the wrong layer and watch it fail. `prism-memory` ran that
mutation against the *old* suite as well, to prove the new case was not
redundant with something already there.

## Why this generalises

Any package here may need a local exception. `prism-workspace` normalises paths
where the rest of the ecosystem preserves input. `prism-mcp` will treat remote
content differently from local content.

Every one of those is a rule holding at one layer and bending at another, and
every one will have a suite that tests the rule where it does not bend.
