import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyFailedStepReport, verifyFailedStepMatrix } from './failed-step-contract.mjs';

const cases = [{ id: 'sfs-0001', input: { finish: 'error' } }];
function report(language) {
  return { results: [{ id: 'sfs-0001', result: { error_code: 'model_step_failed', finish_reason: 'error', run_status: 'failed',
    model_calls: 1, tool_calls: 0, steps: 1, cost_retained: true, pending_approvals: 0, resumed_tools: 0 },
    native: { error_code: language === 'php' ? null : 'model_step_failed', reason: 'error', cost_usd: 0.04,
      package_version: { php: '0.18.0', ts: '0.8.0', py: '0.3.0' }[language] } }] };
}
test('a common unsafe outcome is refused even when every language agrees', () => {
  for (const [field, value] of [['model_calls', 2], ['tool_calls', 1], ['resumed_tools', 1], ['pending_approvals', 1],
    ['cost_retained', false], ['run_status', 'completed']]) {
    for (const language of ['php', 'ts', 'py']) {
      const unsafe = report(language);
      unsafe.results[0].result[field] = value;
      assert.throws(() => verifyFailedStepReport(language, unsafe, cases), /safety contract/);
    }
  }
});
test('missing and duplicate executions cannot become a smaller green suite', () => {
  const valid = report('ts');
  assert.throws(() => verifyFailedStepReport('ts', { results: [] }, cases), /missing/);
  assert.throws(() => verifyFailedStepReport('ts', { results: [...valid.results, ...valid.results] }, cases), /duplicate/);
  assert.throws(() => verifyFailedStepReport('ts', valid, []), /No failed-step inputs/);
});
test('PHP native vocabulary remains distinct and both ports carry the same bounded code', () => {
  for (const language of ['php', 'ts', 'py']) verifyFailedStepReport(language, report(language), cases);
  const invented = report('php'); invented.results[0].native.error_code = 'model_step_failed';
  assert.throws(() => verifyFailedStepReport('php', invented, cases));
  const invalid = report('py'); invalid.results[0].native.reason = 'provider text';
  assert.throws(() => verifyFailedStepReport('py', invalid, cases));
});
test('candidate package versions are rejected by the publication gate', () => {
  const candidate = report('ts'); candidate.results[0].native.package_version = '0.7.0';
  assert.throws(() => verifyFailedStepReport('ts', candidate, cases), /published release version/);
  verifyFailedStepReport('ts', candidate, cases, true);
});
test('replacing hostile inputs with successful controls cannot collapse the suite', () => {
  const corpus = JSON.parse(readFileSync(new URL('../suites/harness-failed-step/cases.json', import.meta.url), 'utf8'));
  verifyFailedStepMatrix(corpus.cases);
  const collapsed = structuredClone(corpus.cases);
  for (const row of collapsed) row.input = { finish: 'stop', api: 'send', guarded: false, tools: false, php_stream: null };
  assert.throws(() => verifyFailedStepMatrix(collapsed), /controls cannot replace hostile cases/);
});
