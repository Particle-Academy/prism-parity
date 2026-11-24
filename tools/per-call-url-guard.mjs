#!/usr/bin/env node
// Execute one native implementation against the per-call-url-guard corpus, then
// compare or explicitly record its column. A generator's checkout licence;
// loaders only read shipped fixtures.
//
//   node tools/per-call-url-guard.mjs php|ts|py --check|--record
//
// PHP runs against PRISM_PHP_SRC (a prism checkout) when it is set, otherwise
// against the installed reference in runners/php. TypeScript reads
// PRISM_TS_DIST or the built sibling prism-ts/dist; Python imports PRISM_PY_SRC
// or the installed package.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { observe } from './per-call-url-guard/ts.mjs';
import { perCallUrlGuardFailures } from './per-call-url-guard/contract.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [language, action] = process.argv.slice(2);
assert(['php', 'ts', 'py'].includes(language) && ['--check', '--record'].includes(action) && process.argv.length === 4,
  'Usage: node tools/per-call-url-guard.mjs php|ts|py --check|--record');
const file = process.env.PER_CALL_URL_GUARD_CASES ?? join(root, 'suites/per-call-url-guard/cases.json');
const document = JSON.parse(readFileSync(file, 'utf8'));
let rows;
if (language === 'ts') {
  rows = await observe(document, process.env.PRISM_TS_DIST ?? resolve(root, '../prism-ts/dist'));
} else {
  const command = language === 'php' ? process.env.PRISM_PHP_BINARY ?? 'php' : process.env.PRISM_PY_BINARY ?? 'python';
  const driver = join(root, 'tools/per-call-url-guard', language === 'php' ? 'php.php' : 'py.py');
  const processResult = spawnSync(command, [driver], { input: JSON.stringify(document), encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (processResult.stderr) process.stderr.write(processResult.stderr);
  assert.equal(processResult.status, 0, 'Native per-call-url-guard observer failed.');
  rows = JSON.parse(processResult.stdout);
}
assert.equal(rows.length, document.cases.length);
const stale = [];
for (const [index, row] of rows.entries()) {
  const entry = document.cases[index];
  assert.equal(row.id, entry.id, 'Native row identity changed.');
  if (!equal(entry.result[language], row.observed)) stale.push(entry.id);
  entry.result[language] = row.observed;
}
for (const entry of document.cases) {
  entry.agrees = ['php', 'ts', 'py'].every(name => entry.result[name] !== null && equal(entry.result.php, entry.result[name]));
}
const problems = perCallUrlGuardFailures(document, { allowIncomplete: action === '--record' });
assert.equal(problems.length, 0, problems.join('\n'));
if (action === '--check') {
  assert.equal(stale.length, 0, `Stale ${language} per-call-url-guard rows: ${stale.join(', ')}`);
} else writeFileSync(file, JSON.stringify(document, null, 4) + '\n');
console.log(`per-call-url-guard ${language}: ${rows.length} executed; ${stale.length} changed; ${action.slice(2)} passed.`);

function equal(left, right) {
  try { assert.deepEqual(left, right); return true; } catch { return false; }
}
