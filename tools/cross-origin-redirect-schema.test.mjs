import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile } from '@particle-academy/fancy-schema';
import { crossOriginRedirectFailures } from './cross-origin-redirect/contract.mjs';
import { execute } from './cross-origin-redirect/ts.mjs';

const check = compile(JSON.parse(readFileSync(new URL('../schema/cases.schema.json', import.meta.url), 'utf8')));
const fixture = () => JSON.parse(readFileSync(new URL('../suites/cross-origin-redirect/cases.json', import.meta.url), 'utf8'));
const hostile = document => document.cases.find(row => !row.given.target.startsWith('same-origin'));
const control = document => document.cases.find(row => row.given.target.startsWith('same-origin'));

test('all native cross-origin-redirect observations fit the schema and agreement contract', () => {
  const document = fixture();
  assert.equal(check(document).valid, true);
  assert.deepEqual(crossOriginRedirectFailures(document), []);
});

test('the corpus keeps hostile rows for every target and following controls', () => {
  const rows = fixture().cases;
  for (const target of ['other-host', 'other-port', 'protocol-relative', 'scheme']) {
    for (const provider of ['openai', 'anthropic', 'mistral']) {
      assert.ok(rows.some(row => row.given.target === target && row.given.provider === provider), `${provider} ${target}`);
    }
  }
  // A client that refused every redirect passes every hostile row; the
  // controls are what make those rows mean anything.
  assert.ok(rows.filter(row => row.result.php.endpoint_requests === 2).length >= 3);
});

test('the corpus pins the same-origin hop limit and the userinfo Location for every provider', () => {
  const rows = fixture().cases;
  for (const provider of ['openai', 'anthropic', 'mistral']) {
    for (const target of ['same-origin-loop', 'same-origin-chain-5', 'same-origin-userinfo']) {
      assert.ok(rows.some(row => row.given.target === target && row.given.provider === provider), `${provider} ${target}`);
    }
  }
  // Five hops followed, the sixth refused: six requests, in the loop and the chain alike.
  for (const row of rows.filter(row => row.given.target === 'same-origin-loop' || row.given.target === 'same-origin-chain-5')) {
    assert.equal(row.result.php.endpoint_requests, 6, row.id);
  }
});

for (const [name, mutate] of [
  ['an unknown provider', document => { hostile(document).given.provider = 'groq'; }],
  ['an unknown redirect status', document => { hostile(document).given.status = 300; }],
  ['an unknown target', document => { hostile(document).given.target = 'metadata'; }],
  ['a hand-written url in a row', document => { hostile(document).given.location = 'http://169.254.169.254/'; }],
  ['missing native result', document => { delete hostile(document).result.php; }],
  ['missing environment isolation name', document => { document.environment_names.pop(); }],
  ['unregistered language', document => { hostile(document).result.ruby = {}; }],
  ['malformed case id', document => { hostile(document).id = 'pcu-0001'; }],
  ['the error code in an observation', document => { hostile(document).result.php.refusal = 'redirect_refused'; }],
  ['a call that never reached its endpoint', document => { control(document).result.py.endpoint_requests = 0; }],
]) test(`cross-origin-redirect schema rejects ${name}`, () => {
  const document = fixture(); mutate(document); assert.equal(check(document).valid, false);
});

test('a credential cannot be seen elsewhere without anything reaching elsewhere', () => {
  const document = fixture();
  hostile(document).result.py = { endpoint_requests: 1, reached_elsewhere: false, credential_elsewhere: true };
  assert.match(crossOriginRedirectFailures(document).join('\n'), /leaked a credential without reaching/);
});

test('agreement cannot conceal a changed native observation', () => {
  const document = fixture();
  hostile(document).result.ts = { endpoint_requests: 1, reached_elsewhere: true, credential_elsewhere: true };
  assert.match(crossOriginRedirectFailures(document).join('\n'), /agreement does not match/);
});

test('case identity cannot be duplicated', () => {
  const document = fixture(); document.cases[1].id = document.cases[0].id;
  assert.match(crossOriginRedirectFailures(document).join('\n'), /duplicate cross-origin-redirect/);
});

test('a fixture cannot authorize NODE_OPTIONS before the SDK is loaded', async () => {
  const document = fixture(); document.environment_names.push('NODE_OPTIONS');
  await assert.rejects(execute(document, [], 'must-not-be-loaded'), /Unapproved environment isolation/);
});
