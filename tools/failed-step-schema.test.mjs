import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile } from '@particle-academy/fancy-schema';

const check = compile(JSON.parse(readFileSync(new URL('../schema/cases.schema.json', import.meta.url), 'utf8')));
function schemaFixture() {
  const document = JSON.parse(readFileSync(new URL('../suites/harness-failed-step/cases.json', import.meta.url), 'utf8'));
  // Schema-only data, never written into the execution corpus as goldens.
  for (const row of document.cases) {
    row.result = { php: '{}', ts: '{}', py: '{}' };
    row.native = Object.fromEntries(['php', 'ts', 'py'].map(language => [language, {
      error_code: language === 'php' ? null : 'model_step_failed', reason: 'error', cost_usd: 0.04,
      settlement_outcome: language === 'php' ? 'failed' : null, package_version: '0.1.0',
    }]));
    row.agrees = true;
  }
  return document;
}
test('the failed-step document shape is accepted by the real cases schema', () => {
  assert.equal(check(schemaFixture()).valid, true);
});
for (const [name, mutate] of [
  ['unbounded finish reason', row => { row.input.finish = 'provider text'; }],
  ['unbounded native reason', row => { row.native.ts.reason = 'provider text'; }],
  ['invented native error code', row => { row.native.py.error_code = 'other'; }],
  ['unrecorded language result', row => { row.result.php = null; }],
  ['missing native cost', row => { delete row.native.php.cost_usd; }],
  ['skipped failed-step execution', row => { row.skip = { ts: 'unsupported' }; }],
]) {
  test(`the schema rejects ${name}`, () => {
    const document = schemaFixture(); mutate(document.cases[0]);
    assert.equal(check(document).valid, false);
  });
}
