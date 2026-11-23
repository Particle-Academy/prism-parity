import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile } from '@particle-academy/fancy-schema';
import { credentialScopeFailures } from './credential-scope/contract.mjs';
import { observe } from './credential-scope/ts.mjs';

const check = compile(JSON.parse(readFileSync(new URL('../schema/cases.schema.json', import.meta.url), 'utf8')));
const fixture = () => JSON.parse(readFileSync(new URL('../suites/credential-scope/cases.json', import.meta.url), 'utf8'));
const endpoint = document => document.cases.find(row => row.given.kind === 'endpoint');
const register = document => document.cases.find(row => row.given.kind === 'register');

test('all native credential-scope observations fit the schema and agreement contract', () => {
  const document = fixture();
  assert.equal(check(document).valid, true);
  assert.deepEqual(credentialScopeFailures(document), []);
});

for (const [name, mutate] of [
  ['unknown environment override', document => { endpoint(document).given.env = { NODE_OPTIONS: 'unsafe' }; }],
  ['unknown provider option', document => { endpoint(document).given.config.transport = 'unsafe'; }],
  ['unshipped provider', document => { endpoint(document).given.provider = 'groq'; }],
  ['missing native result', document => { delete endpoint(document).result.php; }],
  ['missing environment isolation name', document => { document.environment_names.pop(); }],
  ['unregistered language', document => { endpoint(document).result.ruby = {}; }],
  ['malformed case id', document => { endpoint(document).id = 'cfg-0001'; }],
  ['credential value in place of a classification', document => { endpoint(document).result.ts.credential = 'sk-test-fixture'; }],
  ['extra data in an endpoint observation', document => { endpoint(document).result.php.header = 'Authorization'; }],
  ['endpoint observation on a registration row', document => { register(document).result.py = { dispatched: true, credential: 'none', account: 'none' }; }],
]) test(`credential-scope schema rejects ${name}`, () => {
  const document = fixture(); mutate(document); assert.equal(check(document).valid, false);
});

test('an observation can never carry a fixture credential', () => {
  const document = fixture(); register(document).result.ts.note = 'sk-test-explicit';
  assert.match(credentialScopeFailures(document).join('\n'), /carries a credential value/);
});

test('agreement cannot conceal a changed native observation', () => {
  const document = fixture(); endpoint(document).result.ts = { dispatched: true, credential: 'both', account: 'none' };
  assert.match(credentialScopeFailures(document).join('\n'), /agreement does not match/);
});

test('case identity cannot be duplicated', () => {
  const document = fixture(); document.cases[1].id = document.cases[0].id;
  assert.match(credentialScopeFailures(document).join('\n'), /duplicate credential-scope/);
});

test('a fixture cannot authorize NODE_OPTIONS before the SDK is loaded', async () => {
  const document = fixture(); document.environment_names.push('NODE_OPTIONS');
  await assert.rejects(observe(document, 'must-not-be-loaded'), /Unapproved environment isolation/);
});
