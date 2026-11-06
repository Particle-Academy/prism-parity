#!/usr/bin/env node
// Checking never records or rewrites observations. Inputs are validated before
// importing an SDK or starting a child process.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compile } from '@particle-academy/fancy-schema';
import { satellitePolicyFailures } from './satellite-policy/contract.mjs';
import { observe } from './satellite-policy/ts.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [language, action] = process.argv.slice(2);
assert(['php', 'ts', 'py'].includes(language) && action === '--check' && process.argv.length === 4,
  'Usage: node tools/satellite-policy.mjs php|ts|py --check');
const document = JSON.parse(readFileSync(join(root, 'suites/satellite-policy/cases.json'), 'utf8'));
const check = compile(JSON.parse(readFileSync(join(root, 'schema/cases.schema.json'), 'utf8')));
assert(check(document).valid, 'Satellite policy schema rejected before SDK load');
assert.deepEqual(satellitePolicyFailures(document), [], 'Satellite evidence contract rejected');
let rows;
if (language === 'ts') rows = await observe(document, process.env.PRISM_POLICY_BROWSER_TS_DIST ?? resolve(root, '../prism-browser-ts/dist/index.js'), process.env.PRISM_POLICY_HUMAN_TS_DIST ?? resolve(root, '../prism-human-plus-ts/dist/index.js'));
else {
  const bin = language === 'php' ? process.env.PRISM_POLICY_PHP_BINARY ?? 'php' : process.env.PRISM_POLICY_PY_BINARY ?? 'python';
  const args = [...(language === 'php' ? ['-d', 'display_errors=stderr'] : []), join(root, 'tools/satellite-policy', language === 'php' ? 'php.php' : 'py.py')];
  const result = spawnSync(bin, args, { input: JSON.stringify(document), encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.status, 0, 'Native satellite observer did not complete');
  rows = JSON.parse(result.stdout);
}
assert.equal(rows.length, document.cases.length, 'Native satellite coverage changed');
for (const [index, row] of rows.entries()) {
  assert.equal(row.id, document.cases[index].id, 'Native row identity changed');
  assert.deepEqual(row.observed, document.cases[index].prediction, row.id+': independent prediction failed');
  assert.deepEqual(row.observed, document.cases[index].result[language], row.id+': native observation changed');
}
console.log('satellite-policy '+language+': '+rows.length+' executed; 0 changed; independent predictions and check passed.');
