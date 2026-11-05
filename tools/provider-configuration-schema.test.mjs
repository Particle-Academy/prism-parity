import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile } from '@particle-academy/fancy-schema';
import { providerConfigurationFailures } from './provider-configuration/contract.mjs';
import { observe } from './provider-configuration/ts.mjs';

const check = compile(JSON.parse(readFileSync(new URL('../schema/cases.schema.json', import.meta.url), 'utf8')));
const fixture = () => JSON.parse(readFileSync(new URL('../suites/provider-configuration/cases.json', import.meta.url), 'utf8'));

test('all native provider configuration observations fit the schema and agreement contract', () => {
  const document = fixture();
  assert.equal(check(document).valid, true);
  assert.deepEqual(providerConfigurationFailures(document), []);
});

for (const [name, mutate] of [
  ['unknown environment override', document => { document.cases[0].given.env = { NODE_OPTIONS: 'unsafe' }; }],
  ['unknown constructor option', document => { document.cases[0].given.config.transport = 'unsafe'; }],
  ['cross-provider property', document => { document.cases[0].given.property = 'apiFormat'; }],
  ['missing native result', document => { delete document.cases[0].result.php; }],
  ['missing environment isolation name', document => { document.environment_names.pop(); }],
  ['duplicate environment isolation name', document => { document.environment_names[1] = document.environment_names[0]; }],
  ['unregistered language', document => { document.cases[0].result.ruby = {}; }],
  ['two-letter case id', document => { document.cases[0].id = 'cf-0001'; }],
  ['thinking result in constructor case', document => { document.cases[0].result.ts = { thinking: null }; }],
  ['missing FIM dispatch count', document => { delete document.cases.find(row => row.given.kind === 'fim').result.py.count; }],
  ['extra data in recorded error', document => { document.cases.find(row => row.result.php.error).result.php.message = 'private'; }],
]) test(`configuration schema rejects ${name}`, () => {
  const document = fixture(); mutate(document); assert.equal(check(document).valid, false);
});

test('agreement cannot conceal a changed native observation', () => {
  const document = fixture(); document.cases[0].result.ts = { value: 'different' };
  assert.match(providerConfigurationFailures(document).join('\n'), /agreement does not match/);
});

test('case identity cannot be duplicated', () => {
  const document = fixture(); document.cases[1].id = document.cases[0].id;
  assert.match(providerConfigurationFailures(document).join('\n'), /duplicate configuration/);
});

test('a fixture cannot authorize NODE_OPTIONS before the SDK is loaded', async () => {
  const document = fixture(); document.environment_names.push('NODE_OPTIONS');
  await assert.rejects(observe(document, 'must-not-be-loaded'), /Unapproved environment isolation/);
});
