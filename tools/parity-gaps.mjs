#!/usr/bin/env node
// WHY each language is not full, which is a different question from HOW MANY.
//
// parity-check answers existence: is there a mirror at all. The suites answer
// agreement: do the implementations produce the same bytes. Neither answers the
// question somebody planning work actually has, which is *whose* gap this is.
//
// The manifest's `status` field alone cannot answer it. `partial` is recorded
// against a port that has no runner, against a port that is CORRECT while the
// reference is ambiguous, and against a row the language genuinely cannot
// express — three situations with three different owners, flattened into one
// word. Read that way, a scoreboard reports the ports as behind when several
// rows are the reference being behind ITS OWN PORTS.
//
//   node tools/parity-gaps.mjs
//   node tools/parity-gaps.mjs --report   # also print every gap, grouped
//
// Exit 1 when a non-full entry carries no `cause`, because an unclassified gap
// reads as no gap.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const suitesDir = join(root, 'suites');
const report = process.argv.includes('--report');

const CAUSES = {
  'no-runner': 'a real port gap: this language has no runner for the suite',
  'reference-limit': 'the REFERENCE cannot express, or gets wrong, what it asks of the ports',
  'language-limit': 'this language genuinely cannot express the row (0002 skip)',
  'decision-pending': 'the implementations disagree and closing it needs a decision across repos',
};

const isDir = (p) => existsSync(p) && statSync(p).isDirectory();
const suites = isDir(suitesDir) ? readdirSync(suitesDir).filter((s) => isDir(join(suitesDir, s))) : [];

// Vacuity guard, the same one parity-check carries. A sweep that examined no
// suites must fail rather than congratulate itself.
if (suites.length === 0) {
  console.error(`parity-gaps: found NO suites under ${suitesDir}. That is a failure, not a pass.`);
  process.exit(1);
}

const gaps = [];
const unclassified = [];
let entries = 0;

for (const suite of suites) {
  const manifest = JSON.parse(readFileSync(join(suitesDir, suite, 'manifest.json'), 'utf8'));

  for (const [language, entry] of Object.entries(manifest.implementations ?? {})) {
    entries += 1;

    if (entry.status === 'full') continue;

    if (!entry.cause) {
      unclassified.push(`${suite}/${language}`);
      continue;
    }

    gaps.push({ suite, language, cause: entry.cause, note: entry.cause_note ?? '' });
  }
}

const byCause = {};
for (const g of gaps) (byCause[g.cause] ??= []).push(g);

// The number worth leading with. "Ports are behind" and "the reference is
// behind its own ports" are opposite conclusions drawn from the same `partial`.
const portGaps = (byCause['no-runner'] ?? []).filter((g) => g.language !== 'php');
const referenceLimits = byCause['reference-limit'] ?? [];

console.log(`${entries} implementation entries across ${suites.length} suites; ${gaps.length} not full.\n`);

for (const [cause, description] of Object.entries(CAUSES)) {
  const rows = byCause[cause] ?? [];
  console.log(`${String(rows.length).padStart(3)}  ${cause.padEnd(18)} ${description}`);

  if (report) {
    for (const r of rows) {
      console.log(`     ${r.suite}/${r.language}`);
      if (r.note) console.log(`       ${r.note}`);
    }
  }
}

console.log('');
console.log(`Genuine PORT gaps (a port with no runner): ${portGaps.length}`);
console.log(`Rows where the REFERENCE is the limit:     ${referenceLimits.length}`);

const referenceOwn = referenceLimits.filter((g) => g.language === 'php').length;

if (referenceOwn > 0) {
  console.log('');
  console.log(`${referenceOwn} of those are the reference failing its OWN suite — it is behind its ports there,`);
  console.log('not the other way round. Read that before planning "catch the ports up".');
}

// Reported AFTER the summary on purpose: an unclassified entry is a defect in
// the classification, and you want the picture it distorts in front of you at
// the same time as the distortion.
if (unclassified.length > 0) {
  console.error('');
  console.error('These entries are not full and say nothing about WHY, so the counts above UNDERSTATE the gap:');
  for (const u of unclassified) console.error(`  ${u}`);
  console.error('');
  console.error('An unclassified gap reads as no gap. Add a `cause` from: ' + Object.keys(CAUSES).join(', '));
  process.exit(1);
}
