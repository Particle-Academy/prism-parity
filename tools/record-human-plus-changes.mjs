#!/usr/bin/env node
// Record the TypeScript rows in suites/human-plus-change-feed/cases.json, by
// running prism-human-plus-ts's real SurfaceChanges.readFrom() -- the method
// changesSince() calls -- over the surface result each case carries.
//
// The result is decoded from the case's RAW TEXT and never re-encoded back into
// the file. See the PHP generator's header for why that rule exists; half the
// rows here are about a value's TYPE.
//
// The case file is edited as TEXT, replacing each `"ts": ...` string in place
// and recomputing `agrees`, so the recorder cannot reformat or retype the rows
// it records.
//
//   PRISM_HUMAN_PLUS_TS=../prism-human-plus-ts node tools/record-human-plus-changes.mjs [--check]

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = process.env.PRISM_HUMAN_PLUS_TS ?? join(root, '..', 'prism-human-plus-ts');
const humanPlus = await import(pathToFileURL(join(packageRoot, 'dist', 'index.js')).href);

const check = process.argv.includes('--check');
const path = join(root, 'suites', 'human-plus-change-feed', 'cases.json');
let raw = readFileSync(path, 'utf8');
const document = JSON.parse(raw);

/** The same conversion prism-human-plus-ts's corpus test makes. */
export function answerFor(testCase, { SurfaceChanges }) {
  const result = JSON.parse(testCase.input.result);

  return SurfaceChanges.readFrom(result, testCase.input.feed).toObject();
}

/** The offset just past the JSON string literal that starts at `quote`. */
function stringEnd(text, quote) {
  for (let i = quote + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '"') return i + 1;
  }

  throw new Error('Unterminated string in the case file.');
}

const stale = [];

for (const testCase of document.cases) {
  const produced = JSON.stringify(answerFor(testCase, humanPlus));

  if (testCase.rows.ts !== produced) stale.push(testCase.id);

  const at = raw.indexOf(`"id": "${testCase.id}"`);
  const quote = raw.indexOf('"ts": ', at) + '"ts": '.length;
  raw = raw.slice(0, quote) + JSON.stringify(produced) + raw.slice(stringEnd(raw, quote));

  const agrees = produced === testCase.rows.php && produced === testCase.rows.py;
  const valueAt = raw.indexOf('"agrees": ', at) + '"agrees": '.length;
  const valueEnd = raw.startsWith('true', valueAt) ? valueAt + 4 : valueAt + 5;
  raw = raw.slice(0, valueAt) + String(agrees) + raw.slice(valueEnd);
}

if (check) {
  if (stale.length > 0) {
    process.stderr.write(`Stale ts rows: ${stale.join(', ')}\n`);
    process.exit(1);
  }

  process.stderr.write('TypeScript rows current.\n');
  process.exit(0);
}

writeFileSync(path, raw);
process.stderr.write(`Wrote ${document.cases.length} ts answer(s); ${stale.length} changed.\n`);
