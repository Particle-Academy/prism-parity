# 0020 — Collapsed states

**Status:** accepted, 2026-08-26

## The shape

**An operation with several distinct failure modes that reports a single value.**

The states are lost at the function. The harm is wherever that single value is
interpreted — usually somewhere else, by someone who cannot see what was
discarded.

It is not a style complaint. A caller that cannot tell *deliberately skipped,
never retry* from *failed, please retry* will eventually choose wrong, and a
retry on a mutation that may already have run is strictly worse than no retry
at all.

## Why this is a decision and not a lint rule

Five instances surfaced in a single day across two estates, each found by a
person noticing rather than by anything looking:

| | |
|---|---|
| an unresolvable expression path yielding `''` | indistinguishable from a legitimately empty field |
| `??` collapsing "absent" with "null" | shipped identically across four runtimes |
| three broker states through one boolean | a live session with a bad token, a dead session, and missing credentials all arriving as `401 invalid_token` — so a client with correct credentials against a closed page was told its credentials were wrong |
| `XpAwarder::award()` returning `bool` for five outcomes | four meaning never-retry, one meaning retry |
| the same broker fix, re-broken inside itself | keyed on whether a correlation map was populated rather than on whether a client had identified itself |

The last one is the reason this is written down. **The shape reappeared inside
its own repair, in the hands of the person who had spent the afternoon hunting
it, and only a test stood between that and shipping.** That is not a lesson
about care. It is a reason to assume it will reappear and to keep something
looking.

## What is mechanically findable, and what is not

**Operations, yes. Values, no.**

*"This function has several failure modes and reports one bit"* is structural: a
machine can see it. *"This `??` is over something where null is legal"* depends
on what the variable **means**. The clearest demonstration is a name that means
the runtime payload in one file and the declared input list in another —
identical text, opposite semantics, no regex between them.

This is the same wall as
[0019](0019-checking-the-prose.md), reached from the other side: that decision
ends by stating the fact-checker verifies a named thing EXISTS and cannot verify
that the surrounding sentence is TRUE. Structure is checkable; meaning is not.
Two estates, opposite directions, one boundary.

So `tools/collapse-hunt.mjs` covers the findable third and is honest that it is
a third. The half that is not findable still depends on somebody noticing.

## Three rules for using it, all earned

**Run it on the file you just fixed, not as an estate-wide sweep.** The first
run of the Fancy team's version found four real hits in one file — the file
they had been working in an hour earlier. The rule found them; proximity made
them dense. The shape clusters where someone was recently thinking.

**Exclude predicates by name.** For a yes/no question a bool IS the whole
answer, and seven ways to say "no" is not a collapse. This one change took that
first run from 10 candidates to 4, all real. Without it the tool cries wolf and
gets switched off.

**A hit that looks harmless is not dismissed until its callers are read.**
`XpAwarder::award()` was judged theoretical until someone read its one caller:

```php
$ok ? $this->awarded++ : $this->skip('already awarded');
```

A backfill against an unseeded taxonomy counted every **failure** as a duplicate
and reported itself clean. The caller that most needed to tell the states apart
was the one asserting they were the same.

## The calibrating false positive

`BackfillGamification::award()` matches the shape — a `bool` with several
`return false` paths — and is correct as written. Every one of them is preceded
by `$this->skip('<specific reason>')`, so **the states are not lost, they are
reported**, and the bool serves the single caller that only asks whether the
award landed.

The rule cannot see that, because it reads returns and not the lines above them.
Keep this example: it is what "read the callers" looks like in the direction
nobody expects, and a tool whose only documented outcome is a real bug teaches
its reader that every hit is one.

## A rule going quiet looks exactly like code getting better

Refining a rule is where this class bites its own tooling, and the Fancy team
hit it first.

They added the announce-discount, ran it over four repos, and Rule A went from
four candidates to **zero**. Every instinct read that as the discount working.
It was not: they had already *fixed* those four functions, so the run could not
distinguish "the discount works" from "the discount does nothing" from "the
discount broke everything". **Three states, one observation** — the shape this
decision is about, arriving in the measurement rather than the code.

Synthetic fixtures are what separated them, and they caught a real defect: the
discount matched the two-line form and missed
`{ $this->skip('x'); return false; }` on a single line, which is the more
idiomatic one in PHP.

Ours then repeated the lesson within a minute. The first fixture run printed
*"No candidates"* — because it had walked **nothing**, the fixture directory
having neither `src/` nor `app/`. That reads identically to the rule working,
and only the scanned-file count gave it away. Which is why the tool prints that
count at all: a hunter that silently scanned less than you think is the failure
it hunts.

So: **never judge a change to a rule by whether a real repository got quieter.**
`node tools/collapse-hunt.mjs --self-check` runs three fixtures that do not
move — one that collapses, one that announces every state (in both the two-line
and single-line forms), one that announces some and hides three. It must report
exactly the first and the third.

This is a stronger guard than the claim census in
[0019](0019-checking-the-prose.md), and worth noting as an improvement on it. A
census tells you the count moved; it cannot tell you whether the rule or the
world changed. A fixture tells you the rule still fires **regardless** of what
the world is doing.

## Verify a guard by sabotage, not by passing

**A self-check that has never been seen to fail asserts nothing** — the same
principle as a regression test that also passes against the unfixed code.

So each guard is broken deliberately and watched to fail:

| sabotage | expected |
|---|---|
| raise the threshold `3 → 4` | `collapses()` and `partiallyAnnounces()` stop firing |
| remove the announce-discount | `announces()` starts firing |
| delete the fixtures directory | fails, naming zero files scanned |
| fixtures directory present but empty | the same |

That took two minutes and found a real defect in ours. The first two sabotages
reported cleanly. **The last two CRASHED** — `readdirSync` threw on a missing
directory, so the process died before reaching the `scanned > 0` assertion.

Which means the guard written specifically for the zero-file trap **had never
been able to fire.** It exited non-zero, so it looked correct; it was exiting
non-zero because it was broken, not because it had detected anything. A guard
that crashes rather than reports produces a red that reads as a tooling fault,
and those get ignored — which is how a guard stops guarding while still
appearing present.

## Read the message, not the exit status

A sabotage is only evidence if the observation channel is trustworthy, and it
usually is not.

```
A deliberately BROKEN rule, observed three ways:
   bare .............. exit=1   (truth)
   piped, $?  ........ exit=0   <-- LIES
   piped, PIPESTATUS . exit=1   (truth)
```

`tool --self-check | tail -1` reports **`tail`'s** status. A correctly failing
check reads as a pass, and the finding you write up is an artefact of how you
looked rather than anything about the tool. The Fancy team hit this and nearly
reported their own guard broken; ours was true only because the run happened to
use `PIPESTATUS` — the buggy form had been written into a helper in the same
command and went uncalled. Avoided by not using it, which is luck.

And a status is thin evidence even when it is real: a crash exits non-zero too.
**Passing the sabotage and failing for the wrong reason are indistinguishable
from an exit code** — which is exactly how the zero-file guard above looked
correct while being incapable of running.

So: run a verification bare, or redirect to a file, or read no status at all —
and judge every failure by its **message**.

## After adding an exception, test that the exception did not eat the rule

The generalisation of the `partiallyAnnounces()` fixture, and the more useful
half of it.

When a rule gains a discount or an exception it has **three** behaviours, not
two, and the interesting one is neither extreme. The obvious fixture proves the
exception works. The one worth writing proves the exception did not swallow the
rule — that a function announcing *some* states while hiding three is still
reported.

Without it, a discount silently becomes "does it ever announce?" and nothing
says so. Only the second test can fail interestingly.

Worth recording how that fixture actually arrived: not from foresight. It came
from having just been burned by one end of the case and needing to be sure the
discount had not become a blanket excuse.

## Why the tool is the least-tested code

Everything a checker examines gets examined. The checker is the one thing in the
loop with **nothing pointed at it** — it is the observer, so by construction it
sits outside its own field of view.

That makes it predictable rather than ironic, and therefore budgetable: whatever
effort goes into a checker, some fixed fraction belongs to checking the checker,
and that fraction is normally zero. In one day the instrumentation carried the
shape it was built to hunt three times — a corpus that moved underneath a rule,
a guard that could not run, and an observation channel that reported the wrong
status. None of them was carelessness. Each was someone standing in the one
place they were not looking.

## Census and fixture: neither subsumes the other

A **census** measures the tool against the world. When its number moves it
cannot say which side changed — the tool or the code. That is the same
three-states-one-observation shape as everything above, one level up in the
instrumentation.

A **fixture** measures the tool against something that does not move, which is
the only reason it can answer *did the rule change?* independently of *did the
code change?*

Fixtures are primary. But the census still catches what a fixture cannot: a rule
that narrows across a whole estate while still firing correctly on its fixture.
Keep both, and know which question each answers.

## What to do with a real one

Name the outcomes. An enum, a result object, distinct exceptions — the form
matters less than that the distinction is in the **return value** rather than in
a side effect.

**Do not pin a side effect with a test.** `award()`'s retry semantics were
carried by whether a cooldown cache key got written. A test asserting that
behaviour would have made the invisibility permanent and added a reason never to
fix it. Make the outcome explicit and let the tests assert *which* outcome — a
test that can only be written by reproducing the whole path is describing a
contract no reader can see.

## The general form

**A missing signal costs silence. A wrong one costs more, because it is
followed.**

An error naming the wrong subsystem sends someone to debug a path that was never
the problem. That is worse than no error, and it is what every instance above
produced.
