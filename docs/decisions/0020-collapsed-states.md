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
