import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile } from '@particle-academy/fancy-schema';
import { perCallUrlGuardFailures } from './per-call-url-guard/contract.mjs';
import { observe } from './per-call-url-guard/ts.mjs';

const check = compile(JSON.parse(readFileSync(new URL('../schema/cases.schema.json', import.meta.url), 'utf8')));
const fixture = () => JSON.parse(readFileSync(new URL('../suites/per-call-url-guard/cases.json', import.meta.url), 'utf8'));
const perCall = document => document.cases.find(row => row.given.kind === 'per-call');
const compatible = document => document.cases.find(row => row.given.kind === 'compatible');

test('all native per-call-url-guard observations fit the schema and agreement contract', () => {
  const document = fixture();
  assert.equal(check(document).valid, true);
  assert.deepEqual(perCallUrlGuardFailures(document), []);
});

test('the corpus keeps refusal rows and dispatching controls', () => {
  const rows = fixture().cases;
  assert.ok(rows.some(row => row.result.php.refusal === 'private_address_refused'));
  assert.ok(rows.some(row => row.result.php.refusal === 'scheme_not_allowed'));
  // A guard that refuses everything passes every refusal row; the controls are
  // what make those rows mean anything.
  assert.ok(rows.filter(row => row.result.php.dispatched).length >= 3);
});

for (const [name, mutate] of [
  ['unknown environment override', document => { perCall(document).given.env = { NODE_OPTIONS: 'unsafe' }; }],
  ['unknown per-call option', document => { perCall(document).given.config.transport = 'unsafe'; }],
  ['a provider other than openai on a per-call row', document => { perCall(document).given.provider = 'groq'; }],
  ['a compatible row without an entry', document => { delete compatible(document).given.entry; }],
  ['missing native result', document => { delete perCall(document).result.php; }],
  ['missing environment isolation name', document => { document.environment_names.pop(); }],
  ['unregistered language', document => { perCall(document).result.ruby = {}; }],
  ['malformed case id', document => { perCall(document).id = 'cs-0001'; }],
  ['an unknown refusal code', document => { perCall(document).result.ts.refusal = 'refused'; }],
  ['the refusal message in an observation', document => { perCall(document).result.php.message = 'A per-call provider url may not point at 127.0.0.1'; }],
]) test(`per-call-url-guard schema rejects ${name}`, () => {
  const document = fixture(); mutate(document); assert.equal(check(document).valid, false);
});

test('an observation cannot be both dispatched and refused', () => {
  const document = fixture(); perCall(document).result.py = { dispatched: true, refusal: 'private_address_refused' };
  assert.match(perCallUrlGuardFailures(document).join('\n'), /both dispatched and refused/);
});

test('agreement cannot conceal a changed native observation', () => {
  const document = fixture(); perCall(document).result.ts = { dispatched: true, refusal: null };
  assert.match(perCallUrlGuardFailures(document).join('\n'), /agreement does not match/);
});

test('case identity cannot be duplicated', () => {
  const document = fixture(); document.cases[1].id = document.cases[0].id;
  assert.match(perCallUrlGuardFailures(document).join('\n'), /duplicate per-call-url-guard/);
});

test('a fixture cannot authorize NODE_OPTIONS before the SDK is loaded', async () => {
  const document = fixture(); document.environment_names.push('NODE_OPTIONS');
  await assert.rejects(observe(document, 'must-not-be-loaded'), /Unapproved environment isolation/);
});
