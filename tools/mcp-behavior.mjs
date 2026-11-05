#!/usr/bin/env node
// Read and check shipped observations. Recording a reference column is a
// separate, release-bound generation operation, never a side effect of checks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compile } from '@particle-academy/fancy-schema';
import { mcpBehaviorFailures } from './mcp-behavior/contract.mjs';
import { observe } from './mcp-behavior/ts.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [language, action] = process.argv.slice(2);
assert(['php', 'ts', 'py'].includes(language) && action === '--check' && process.argv.length === 4,
  'Usage: node tools/mcp-behavior.mjs php|ts|py --check');
const document = JSON.parse(readFileSync(join(root, 'suites/mcp-behavior/cases.json'), 'utf8'));
const check = compile(JSON.parse(readFileSync(join(root, 'schema/cases.schema.json'), 'utf8')));
assert(check(document).valid, 'MCP behavior input schema rejected; no SDK was loaded');
assert.deepEqual(mcpBehaviorFailures(document), [], 'MCP behavior evidence contract rejected');
let rows;
if (language === 'ts') rows = await observe(document, process.env.PRISM_MCP_TS_DIST ?? resolve(root, '../prism-mcp-ts/dist/index.js'));
else {
  const bin = language === 'php' ? process.env.PRISM_MCP_PHP_BINARY ?? 'php' : process.env.PRISM_MCP_PY_BINARY ?? 'python';
  const result = spawnSync(bin, [join(root, 'tools/mcp-behavior', language === 'php' ? 'php.php' : 'py.py')],
    { input: JSON.stringify(document), encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.status, 0, 'Native MCP observer did not complete');
  rows = JSON.parse(result.stdout);
}
assert.equal(rows.length, document.cases.length, 'Native MCP coverage changed');
for (const [index, row] of rows.entries()) {
  assert.equal(row.id, document.cases[index].id, 'Native MCP row identity changed');
  assert.deepEqual(row.observed, document.cases[index].prediction, `${row.id}: independent prediction failed`);
  assert.deepEqual(row.observed, document.cases[index].result[language], `${row.id}: native MCP observation changed`);
}
console.log(`mcp-behavior ${language}: ${rows.length} executed; 0 changed; independent predictions and check passed.`);
