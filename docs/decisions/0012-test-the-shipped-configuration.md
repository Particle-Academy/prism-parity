# 0012 — A test that supplies its own configuration never tests the shipped one

**Status:** accepted, 2026-08-25

## Three occurrences, one mechanism

**`prism-harness`.** Its ephemeral store defaulted to Redis. Every test in the
suite set `harness.stores` explicitly, so none of them ever exercised what a
consumer actually gets. The package was broken on install for any machine
without Redis — and shipped green.

**`prism-workspace`.** Renaming its config key from `workspace` to
`prism-workspace`, every test set the key it expected. A manager reading a
*different* key would have fallen through to its own defaults — `local`,
`workspaces` — and behaved identically. **The entire suite would have stayed
green with the rename half-applied.**

**`fancy-conformance`,** reported by the Fancy team. Its `AGENTS.md` claimed
four required CI jobs while `ci.yml` had three; a loader and its 27 tests ran
nowhere. A claim about coverage, in the repository whose argument is that such
a claim must be a test result rather than a sentence.

The mechanism never varies. **A test that writes the configuration it reads is
a closed loop.** It proves the code honours a value. It proves nothing about
which value ships, or whether the published key is the one being read.

And the failure is invisible in exactly the way that matters: the suite is
green, the coverage looks complete, and the defect reaches the first consumer
who installs the package without a config file of their own.

## The rule

**Every package has at least one test that reads its SHIPPED configuration and
proves the value reaches behaviour.**

Not a test that asserts a default equals a literal — that is another closed
loop, and it passes if the key is wrong. The test must:

1. read the published config, not one the test wrote
2. assert the merge landed under the **published key**, and that nothing was
   left behind under an older one
3. change a value there and prove the change reaches the thing it configures

Step three is what distinguishes it from a spelling check.

## And watch it fail

Revert the code to the old key, or to the old default, and watch the test go
red before keeping it. An assertion nobody has seen fail is the same hypothesis
as a guard nobody has seen fail — see the same discipline throughout
`docs/decisions/`.

`prism-workspace` did this and reported it: the green suite was lying, and the
proof that it had stopped lying was watching it fail on purpose.

## Why this is not obvious

Overriding config in tests is correct practice. It isolates cases, avoids
environment coupling, and every framework encourages it.

The trap is that doing it *everywhere* removes the only place the shipped
default is exercised — and nothing announces that, because the tests that
override are all passing for real reasons.
