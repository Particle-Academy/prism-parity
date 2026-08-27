# 0017 — The 0L report format

**Status:** accepted, 2026-08-26

## What a 0L is

A **0L** is a LEARNING: something discovered during a run that matters beyond
the run it came from, written down so it survives the session that found it.

It is not a log line, a test result, or a bug report. Those describe what
happened. A 0L exists to answer a different question — *what does this mean for
the ecosystem* — and it is filed only when there is an answer.

Adopted beyond Prism: the Fancy team asked for this format for `flabs.gen`
rather than inventing a near-miss that would have to be reconciled later. It is
recorded as a decision rather than described in prose so both estates cite one
thing.

## The format

```markdown
---
id: 0L-0001
title: <one specific line>
filed_by: <the agent that filed it>
filed_at: <ISO 8601>
languages: [php, py, ts]
severity: info | notable | urgent
---

# 0L-0001 — <title>

## What was learned
## Evidence
## Why it matters to the ecosystem
## What should change      (optional)
```

`languages` says what the finding is ABOUT, not who filed it. An estate without
language mirrors can carry whatever axis it does have — the field exists to make
a finding filterable by the thing it concerns.

`severity`: **info** — true, worth keeping, nothing is on fire. **notable** —
someone should look before the next release. **urgent** — something is wrong now
and shipping over it makes it worse.

## Why the sections are these sections

**What was learned** and **Evidence** are separated deliberately. A finding
stated without the outputs that produced it cannot be re-checked, and a finding
that is only outputs has not been understood by the agent that filed it. Both,
or it is not a 0L.

**Evidence carries WHEN it was gathered.** Amended 2026-08-26, from a live
case: 0L-0001 cited a tool reporting that two ports implemented one provider
each. That was true at the moment of the call and false eleven hours later,
when a second provider landed in both. The tool was correct, nothing was
broken, and the finding still became misleading — because the reading had no
date on it.

This matters more here than in an ordinary report, and for the reason the
format exists at all: **a 0L is written precisely because it should outlive its
run.** An observation meant to be re-read months later, with no timestamp, is a
claim about the present tense of a moment nobody can identify. Timestamp the
reading, not just the filing — `filed_at` says when the agent wrote, which is
not the same as when it looked.

**Why it matters to the ecosystem is REQUIRED and enforced in code, not left to
the filer's discipline.** It is the section that makes a 0L worth reading later,
and it is the first one an agent in a hurry leaves blank. A filing without it is
refused rather than stored with an empty heading — an empty heading reads as
"nobody thought about this" and is worse than an absent file.

**What should change is optional on purpose.** A finding whose fix is not yet
known is still worth keeping, and requiring a recommendation invites an invented
one.

## Two stores, and which one wins

A 0L is written to the workspace as `.ai/learnings/0L-XXXX-<slug>.md` AND to the
application's database.

The **file is authoritative**. It is committed, greppable, and readable by every
agent and human in the workspace; the row is the feed a board renders. So the
file is written FIRST and the row only created once it is on disk — a row
pointing at a file that does not exist is worse than no row.

**The next id is derived from the FILES, not the table.** A rebuilt database
must not reissue `0L-0001` over a learning that already exists on disk.

## What earns one

File a 0L when the finding outlives its run: a cross-language disagreement, a
provider behaviour that contradicts its documentation, a gap between two packages
that only appears when they meet.

Do not file one for a routine pass, and do not file one that cannot be supported
with evidence. The value of the channel is that a 0L arriving is worth reading,
and that survives exactly as long as they stay rare.

**Check whether the gap is already declared.** Amended 2026-08-26, same case.
Absent-because-planned and absent-because-nobody-noticed look identical from a
port's source, and only the declaration separates them — in this ecosystem,
`manifest/packages.json`. 0L-0001 reported a provider missing from two ports
that are declared text-only at 0.1.0, which is the roadmap rather than a
finding. Reporting a documented boundary as a discovery spends the channel's
credit without adding anything.

**When a tool contradicts a document, suspect the document.** The same case
again, and it is the most transferable part. `describe_port` reads the
directory from disk; the manifest is typed by hand. The instrument was right
and the registry was wrong — and the manifest had been wrong for eleven hours
with nothing to catch it, because the check that existed compared one
declaration against another and never against code. Believing the measurement
over the map turns this kind of run into the better finding on the first pass.

## The blind spot this does not close

A 0L records what was noticed. It does nothing about what was not.

Cross-language conformance detects DISAGREEMENT — it is structurally blind to
every port being identically wrong, which is exactly what happens when one
implementation is ported to the others. The same shape appears one level up in
any lab that judges its own output: an agent reviewing a result it produced
grades against whatever it now believes.

The counter the Fancy team is using for `flabs.gen` is worth stating here
because it generalises: **the expectation is documented BEFORE the run**, and the
review is against that pre-set expectation rather than against the output. A
prediction written in advance can be wrong in a way a retrospective judgement
cannot.
