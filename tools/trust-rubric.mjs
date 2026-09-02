#!/usr/bin/env node
// Score every security corpus against the trust rubric, and FAIL when one
// regresses.
//
// Trust, security and alignment are the foundation this ecosystem is built on.
// A rubric only a human applies is a rubric that stops being applied, so the
// criteria that can be mechanised are checked here and the ones that cannot are
// marked JUDGEMENT in docs/trust-rubric.md and left to a reviewer. Nothing sits
// in between pretending to be covered.
//
// Every criterion below exists because something got through. The docs file
// names the incident for each; this file names it in one line so a failure is
// self-explaining without a second tab.
//
//   node tools/trust-rubric.mjs
//   node tools/trust-rubric.mjs --report

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const report = process.argv.includes('--report');

function directories(path) {
  return readdirSync(path).filter((entry) => statSync(join(path, entry)).isDirectory());
}

// The vocabulary an adversarial row uses when it says what it is probing.
//
// Prose, deliberately: a boolean flag on a case would be set to true by whoever
// wanted the check to pass, whereas a note has to make a claim someone can read
// back. The list is broad because the suites probe genuinely different hazards —
// a URL policy and a tool-name rule do not share words.
const ADVERSARIAL = [
  'adversarial', 'attacker', 'hostile', 'malformed', 'invalid', 'refus', 'reject',
  'bypass', 'defeat', 'escape', 'traversal', 'injection', 'spoof', 'homoglyph',
  'invisible', 'zero-width', 'padded', 'trailing', 'leading', 'overflow',
  'oversized', 'degenerate', 'unreadable', 'unknown', 'empty', 'boundary',
  'not valid', 'cannot', 'must not', 'never',
];

// What a failure MEANS, in the terms of the incident that produced the
// criterion. A failing check that only names itself sends the reader to a
// second file to find out whether it matters.
const EXPLAIN = {
  pins: '`pins` is missing or too short to have said anything. State what a CONSUMER loses when this value drifts, not what the value is — criterion 1.',
  adversarial:
    'fewer than three cases whose notes name an adversarial condition. A suite that only asks the happy path is how G-36 survived in all three languages while the Lab probe of the same property was green — criterion 2.',
  conclusion:
    'every row agrees and the manifest states no `findings`. A corpus compares LANGUAGES, so a bug all three share is invisible to it: say what you conclude from the agreement rather than letting `agrees: true` speak for itself — criterion 3.',
  scope:
    '`scope` is missing. Say what this suite does NOT cover; one that covers a single value and implies a family stops anyone looking — criterion 6.',
};

const failures = [];
const rows = [];

for (const id of directories(join(root, 'suites'))) {
  const manifestPath = join(root, 'suites', id, 'manifest.json');
  const casesPath = join(root, 'suites', id, 'cases.json');

  if (!existsSync(manifestPath) || !existsSync(casesPath)) continue;

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const document = JSON.parse(readFileSync(casesPath, 'utf8'));

  // The rubric governs the SECURITY corpora. The five golden-based kinds are
  // covered by the goldens themselves and by cross-check.mjs, and holding them
  // to criteria written for a different shape would produce noise rather than
  // signal.
  if (manifest.kind !== 'security-corpus') continue;

  const cases = document.cases ?? [];
  const scores = {};

  // 1. The suite must ask the SECURITY question, not the happy path.
  //    Caught G-21: browser-url-policy asked what the refusal CODE was, not
  //    whether a refusal happened.
  scores.pins = typeof manifest.pins === 'string' && manifest.pins.trim().length >= 200;

  // 2. The suite must carry ADVERSARIAL rows.
  //    The most important line here. human-plus-tool-admission found G-36 -- a
  //    trailing space handing the agent the human's confirmation tool in ALL
  //    THREE languages -- only because somebody wrote a row with a space in it.
  const adversarial = cases.filter((testCase) => {
    const notes = String(testCase.notes ?? '').toLowerCase();

    return ADVERSARIAL.some((word) => notes.includes(word));
  });

  scores.adversarial = adversarial.length >= 3;

  // 3. Agreement must not be mistaken for safety.
  //    A corpus compares LANGUAGES, so a bug all three share is invisible to it
  //    by construction. G-36 sat in two rows where all three agreed -- on the
  //    wrong thing. Such a suite has to state its conclusion rather than let
  //    `agrees: true` speak for itself.
  const disagreeing = cases.filter((testCase) => testCase.agrees === false);
  const statesFindings = typeof manifest.findings === 'string' && manifest.findings.trim() !== '';

  scores.conclusion = disagreeing.length > 0 || statesFindings;

  // 6. Scope must be stated, and stated narrowly.
  //    A suite that covers one value and implies a family is worse than no
  //    suite, because it stops anyone looking. This repository has had a status
  //    column read as a completeness claim before.
  scores.scope = typeof manifest.scope === 'string' && manifest.scope.trim() !== '';

  const failed = Object.entries(scores).filter(([, ok]) => !ok).map(([name]) => name);

  rows.push({ id, cases: cases.length, adversarial: adversarial.length, failed });

  for (const criterion of failed) {
    failures.push(`${id}: ${EXPLAIN[criterion]}`);
  }
}

if (rows.length === 0) {
  // A rubric that passes over an empty set is worse than no rubric: it reports
  // success for a corpus it never looked at. Same reason guard-corpus.mjs fails
  // when its discovery finds nothing.
  failures.push('found no security-corpus suites to score — a check that passes over an empty set asserts nothing');
}

if (report) {
  const width = Math.max(...rows.map((row) => row.id.length), 10);

  process.stdout.write('\nTrust rubric — docs/trust-rubric.md\n\n');
  process.stdout.write(`${'suite'.padEnd(width)}  cases  adversarial  verdict\n`);

  for (const row of rows.sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const verdict = row.failed.length === 0 ? 'pass' : `FAIL (${row.failed.join(', ')})`;
    process.stdout.write(
      `${row.id.padEnd(width)}  ${String(row.cases).padStart(5)}  ${String(row.adversarial).padStart(11)}  ${verdict}\n`,
    );
  }

  process.stdout.write('\n');
}

if (failures.length > 0) {
  process.stderr.write(`\nTrust rubric failed:\n\n  ${failures.join('\n  ')}\n\n`);
  process.stderr.write('Each criterion and the incident behind it: docs/trust-rubric.md\n');
  process.exit(1);
}

process.stdout.write(
  `Trust rubric passed: ${rows.length} security corpus/corpora, ` +
    `${rows.reduce((sum, row) => sum + row.adversarial, 0)} adversarial row(s).\n`,
);
