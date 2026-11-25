import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile } from '@particle-academy/fancy-schema';

const check = compile(JSON.parse(readFileSync(new URL('../schema/cases.schema.json', import.meta.url), 'utf8')));
const committed = () => JSON.parse(readFileSync(new URL('../suites/harness-run-cancel/cases.json', import.meta.url), 'utf8'));
const native = { event_names: ['RunCancelRequested'], projected_from: 0, park_stored_status: null, error: 'RunNotPermitted',
  decisions: null, resumes: null, run_id_shape: 'run_x', package_version: '0.1.0' };
// Schema-only data, never written into the execution corpus as goldens.
function recorded() {
  const document = committed();
  for (const row of document.cases) {
    row.result = { php: '{}', ts: '{}', py: '{}' };
    row.native = { php: { ...native }, ts: { ...native }, py: { ...native } };
    row.agrees = true;
  }
  return document;
}

test('the committed, unrecorded run-cancel document is accepted by the real cases schema', () => {
  assert.equal(check(committed()).valid, true);
});
test('a fully recorded run-cancel document shape is accepted', () => {
  assert.equal(check(recorded()).valid, true);
});
for (const [name, mutate] of [
  ['an unknown cancel point', (row) => { row.input.cancel_at = 'whenever'; }],
  ['an unknown id form', (row) => { row.input.cancels = [{ by: 'same', id: 'anything' }]; }],
  ['an unknown session', (row) => { row.input.cancels = [{ by: 'admin', id: 'current' }]; }],
  ['a tool outside the script', (row) => { row.input.script = [{ calls: ['shell'] }]; }],
  ['an empty recorded result', (row) => { row.result.php = ''; }],
  ['a missing native field', (row) => { delete row.native.ts.projected_from; }],
  ['an invented native field', (row) => { row.native.py.verdict = 'safe'; }],
  ['a skipped run-cancel execution', (row) => { row.skip = { ts: 'unsupported' }; }],
  ['a hand-authored expectation column', (row) => { row.expected = { php: '{}' }; }],
]) {
  test(`the schema rejects ${name}`, () => {
    const document = recorded(); mutate(document.cases[0]);
    assert.equal(check(document).valid, false);
  });
}
