#!/usr/bin/env node
// Record the TypeScript outputs in suites/opentelemetry-media-content/cases.json,
// by running prism-opentelemetry-ts's real withoutMediaBytes(). Written into the
// case file as TEXT, replacing only the "ts" output literal.
//
//   PRISM_OTEL_TS=../prism-opentelemetry-ts node tools/record-media-content.mjs [--check]

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bridge = process.env.PRISM_OTEL_TS ?? join(root, '..', 'prism-opentelemetry-ts');
const { withoutMediaBytes } = await import(pathToFileURL(join(bridge, 'dist', 'index.js')).href);

/** Where the JSON string literal whose opening quote is at `open` ends, exclusive. */
function literalEnd(raw, open) {
  for (let i = open + 1; i < raw.length; i++) {
    if (raw[i] === '\\') {
      i++;
      continue;
    }
    if (raw[i] === '"') return i + 1;
  }
  throw new Error('Unterminated string literal.');
}

const check = process.argv.includes('--check');
const path = join(root, 'suites', 'opentelemetry-media-content', 'cases.json');
let raw = readFileSync(path, 'utf8');
const document = JSON.parse(raw);
const stale = [];

for (const testCase of document.cases) {
  const output = JSON.stringify(withoutMediaBytes(testCase.input));

  if (testCase.output.ts !== output) stale.push(testCase.id);

  const at = raw.indexOf(`"id": "${testCase.id}"`);
  const key = raw.indexOf('"ts": ', raw.indexOf('"output": {', at));
  const open = key + '"ts": '.length;
  raw = raw.slice(0, open) + JSON.stringify(output) + raw.slice(literalEnd(raw, open));
}

if (check) {
  if (stale.length > 0) {
    console.error(`Stale ts outputs: ${stale.join(', ')}`);
    process.exit(1);
  }
  console.error('TS outputs current.');
} else {
  writeFileSync(path, raw);
  console.error(`Wrote ${document.cases.length} ts output(s); ${stale.length} changed.`);
}
