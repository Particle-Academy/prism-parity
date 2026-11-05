import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile } from '@particle-academy/fancy-schema';
import { mcpBehaviorFailures } from './mcp-behavior/contract.mjs';
import { gates } from './gate-contracts.mjs';
import { requireVerdict } from './alignment-contracts.mjs';

const check = compile(JSON.parse(readFileSync(new URL('../schema/cases.schema.json', import.meta.url), 'utf8')));
const fixture = () => JSON.parse(readFileSync(new URL('../suites/mcp-behavior/cases.json', import.meta.url), 'utf8'));
test('MCP gate rejects zero work, drift, missing predictions and failed exits', () => {
  const valid = 'mcp-behavior php: 42 executed; 0 changed; independent predictions and check passed.';
  assert.doesNotThrow(() => requireVerdict('mcpBehavior', { status: 0, stdout: valid }, gates.mcpBehavior));
  for (const stdout of ['', valid.replace('42 executed', '0 executed'), valid.replace('0 changed', '1 changed'), valid.replace('independent predictions and ', '')]) {
    assert.throws(() => requireVerdict('mcpBehavior', { status: 0, stdout }, gates.mcpBehavior), /missing.*verdict/);
  }
  assert.throws(() => requireVerdict('mcpBehavior', { status: 1, stdout: valid }, gates.mcpBehavior), /exit/);
});
test('native MCP observations satisfy the schema and independent predictions', () => {
  assert.equal(check(fixture()).valid, true);
  assert.deepEqual(mcpBehaviorFailures(fixture()), []);
});

for (const [name, mutate] of [
  ['no cases', d => { d.cases = []; }],
  ['missing PHP observation', d => { delete d.cases[0].result.php; }],
  ['foreign language', d => { d.cases[0].result.ruby = {}; }],
  ['remote text added to flags', d => { d.cases[0].result.ts.message = 'private'; }],
  ['unknown operation', d => { d.cases[0].given.kind = 'execute'; }],
  ['environment override', d => { d.cases[0].given.NODE_OPTIONS = 'unsafe'; }],
  ['malformed case identity', d => { d.cases[0].id = 'mc-0001'; }],
  ['malformed byte limit', d => { d.cases.find(c => c.given.kind === 'cap').given.maxBytes = '0'; }],
  ['unbounded amplification', d => { d.cases.find(c => c.given.kind === 'cap').given.repeat = 1000000000; }],
  ['wrong observation shape', d => { d.cases.find(c => c.given.kind === 'content').result.py = { isError: false }; }],
]) test(`MCP schema refuses ${name}`, () => {
  const document = fixture(); mutate(document); assert.equal(check(document).valid, false);
});

test('forged agreement cannot hide native drift', () => {
  const document = fixture(); document.cases[0].result.py.isError = true;
  assert.match(mcpBehaviorFailures(document).join('\n'), /agreement differs/);
});
test('three implementations agreeing on the wrong result fail the prediction', () => {
  const document = fixture(); for (const value of Object.values(document.cases[0].result)) value.isError = true;
  assert.match(mcpBehaviorFailures(document).join('\n'), /independent prediction failed/);
});
test('duplicate case identity fails the semantic gate', () => {
  const document = fixture(); document.cases[1].id = document.cases[0].id;
  assert.match(mcpBehaviorFailures(document).join('\n'), /duplicate MCP/);
});
test('missing native observation fails without a vacuous agreement', () => {
  const document = fixture(); document.cases[0].result.php = null;
  assert.match(mcpBehaviorFailures(document).join('\n'), /all native observations/);
});
