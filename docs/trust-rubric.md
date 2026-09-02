# The trust rubric

**Trust, security and alignment are the foundation this ecosystem is built on.**
This file says what that means for a conformance suite, in criteria a machine
can check — and `tools/trust-rubric.mjs` checks them on every commit.

A rubric only a human applies is a rubric that stops being applied. So every
criterion below is either **enforced** (the checker fails the build) or
explicitly marked **judgement** (it cannot be mechanised, and the reviewer owns
it). Nothing sits in between pretending to be covered.

## Why these criteria and not others

Each one is here because it caught something real, and the entry names what.
A criterion with no incident behind it is a criterion nobody will keep.

---

## 1. A suite must ask the SECURITY question — ENFORCED

Every `security-corpus` manifest must state, in `pins`, what breaks if the value
drifts. Not what the value *is* — what a consumer loses when it moves.

**Why.** A suite that pins a happy path documents the implementation. A suite
that pins the security property documents the promise. `browser-url-policy`
found G-21 because it asked what the refusal *code* was, not whether a refusal
happened.

**Checked:** `pins` is present, non-empty, and at least 200 characters — long
enough that it had to say something.

## 2. A suite must carry ADVERSARIAL rows — ENFORCED

At least one case whose input is chosen the way an attacker would choose it, not
the way a caller would: malformed, padded, invisible, oversized, or hostile.

**Why this is the most important line in the file.** `human-plus-tool-admission`
found G-36 — a trailing space handing the agent the human's confirmation tool in
**all three languages** — only because someone wrote a row with a space in it.
The Lab's live probe of the same property was green throughout, because it asked
with a clean name.

**Checked:** at least three cases whose `notes` name an adversarial condition,
matched against a vocabulary the checker holds (hostile, malformed, attacker,
padded, invisible, homoglyph, overflow, traversal, refuse, …). Prose, but prose
that has to make a claim.

## 3. Agreement must not be mistaken for safety — ENFORCED

A suite where every language agrees must still say what it CONCLUDES from that.

**Why.** A cross-language corpus compares languages, so a bug all three share is
invisible to it by construction. G-36 sat in two rows where all three agreed —
and agreed on the wrong thing. Those rows are only useful because they say so.

**Checked:** if a suite has no disagreeing rows, its manifest must carry a
`findings` field that states the conclusion rather than leaving `agrees: true`
to speak for itself.

## 4. A refusal must be MACHINE-READABLE — JUDGEMENT

A consumer has to be able to branch on why something was refused, without
matching on an English sentence.

**Why.** G-21 (browser) and G-30 (perplexity) are both this: the reference
carries prose where the ports carry a code, so a consumer's `switch` falls
through to the default branch in one language and not another. `default` usually
means "unknown failure" rather than "this was an SSRF refusal".

**Not enforced**, because "does this package expose a code" is a question about
the package, not the corpus, and a checker that guessed would be wrong more often
than useful. The corpus records the asymmetry instead; the reviewer decides.

## 5. Every case must say WHY it exists — ENFORCED

**Why.** A case without a stated purpose gets deleted by whoever is next made
uncomfortable by it. The loaders already refuse a corpus whose cases lack
`notes`; this criterion is the reason that guard exists.

**Checked:** by the loaders, on every read. Re-stated here so the rule has a
reason attached and not just an error code.

## 6. Scope must be stated, and stated NARROWLY — ENFORCED

A manifest must say what the suite does NOT cover.

**Why.** `prism-harness`'s README once had a status column read as a
completeness claim, and `parity-check.mjs` printing "passed" has misled a reader
in this repository before. A suite that covers one value and implies a family is
worse than no suite, because it stops anyone looking.

**Checked:** `scope` is present and non-empty on every `security-corpus`
manifest.

## 7. The recording tool must not share the defect — JUDGEMENT

Whatever writes the corpus must not be subject to the bug the corpus hunts.

**Why.** `human-plus-tool-admission` first shipped its schema DECODED and
reported 17 of 18 rows agreeing. Writing the file back through PHP had replaced
`{}` with `[]` and `1.0` with `1` — so all three languages agreed, on inputs none
of them had been asked about. Carrying both as raw JSON text found two more
divergences immediately. `guard-corpus.mjs` documents the same trap for 2^53
integers, which is why it reads case files as text rather than parsing them.

**Not enforced**, because it is a property of the generator rather than of the
corpus. Ask it at review: *could the tool that wrote this row have changed it?*

---

## Running it

```
node tools/trust-rubric.mjs            # score every suite; non-zero on a failure
node tools/trust-rubric.mjs --report   # the same, with the full per-suite table
```

It runs in the `Corpus` workflow beside the guards and the parity check.

**On adding a criterion.** Only add one you can point at an incident for, and
make it enforced or mark it judgement. The failure mode for a rubric is
accumulating aspirations nobody checks — which is the thing this ecosystem keeps
finding in other people's test suites, and would deserve to be caught in its own.
