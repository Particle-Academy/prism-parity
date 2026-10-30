import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile } from '@particle-academy/fancy-schema';
const check = compile(JSON.parse(readFileSync(new URL('../schema/cases.schema.json', import.meta.url), 'utf8')));
function fixture() {
  // Schema-test data only, never written as native observations.
  const document = JSON.parse(readFileSync(new URL('../suites/embedding-decoding/cases.json', import.meta.url), 'utf8'));
  for (const row of document.cases) for (const language of ['ts', 'py']) row.expected[language] = row.expected.php.exception ? { exception: 'PrismError', code: 'invalid_embedding' } : structuredClone(row.expected.php);
  return document;
}
test('actual native embedding identities fit the canonical schema', () => {
  assert.equal(check(fixture()).valid, true);
});
for (const language of ['ts', 'py']) for (const [name, mutate] of [
  ['missing code', row => { delete row.expected[language].code; }],
  ['unrelated code', row => { row.expected[language].code = 'provider_response_error'; }],
  ['PHP class projection', row => { row.expected[language].exception = 'Prism\\Prism\\Exceptions\\PrismException'; }],
  ['partial vector in error', row => { row.expected[language].embedding = []; }],
]) test(`${language} schema rejects ${name}`, () => {
  const document = fixture(); mutate(document.cases[2]); assert.equal(check(document).valid, false);
});
