import assert from 'node:assert/strict';

export function verifyFailedStepMatrix(cases) {
  const expected = [];
  for (const finish of ['error', 'unknown']) for (const api of ['send', 'structured'])
    for (const guarded of [false, true]) for (const tools of [false, true])
      expected.push({ finish, api, guarded, tools, php_stream: null });
  for (const api of ['send', 'structured']) expected.push({ finish: 'stop', api, guarded: false, tools: false, php_stream: null });
  expected.push({ finish: 'error', api: 'send', guarded: true, tools: true, php_stream: 'legacy_error' });
  expected.push({ finish: 'unknown', api: 'send', guarded: true, tools: true, php_stream: 'missing_usage' });
  expected.push({ finish: 'error', api: 'send', guarded: false, tools: true, php_stream: 'legacy_answered' });
  const key = input => JSON.stringify([input.finish, input.api, input.guarded, input.tools, input.php_stream]);
  assert.deepEqual(cases.map(row => key(row.input)).sort(), expected.map(key).sort(), 'The full failed-step matrix must execute; controls cannot replace hostile cases');
}

export function verifyFailedStepReport(language, report, cases, development = false) {
  assert(cases.length > 0, 'No failed-step inputs were discovered');
  assert(['php', 'ts', 'py'].includes(language), 'Unknown failed-step language');
  assert.deepEqual(report.results.map(row => row.id), cases.map(row => row.id), `${language}: missing, duplicate, or reordered execution`);
  for (const [index, row] of report.results.entries()) {
    const input = cases[index].input;
    const expected = { error_code: input.finish === 'stop' ? null : 'model_step_failed', finish_reason: input.finish,
      run_status: input.finish === 'stop' ? 'completed' : 'failed', model_calls: 1, tool_calls: 0,
      steps: 1, cost_retained: true, pending_approvals: 0, resumed_tools: 0 };
    // Authored before recording: identical unsafe results must still fail.
    assert.deepEqual(row.result, expected, `${language}/${row.id}: failed-step safety contract`);
    assert.equal(row.native.error_code, language === 'php' ? null : expected.error_code);
    assert.equal(row.native.reason, input.finish === 'stop' ? null : input.finish);
    assert.equal(typeof row.native.cost_usd, 'number');
    assert(Number.isFinite(row.native.cost_usd) && row.native.cost_usd >= 0, 'Native cost must remain finite');
    if (!development) assert.equal(row.native.package_version, { php: '0.18.0', ts: '0.8.0', py: '0.3.0' }[language], `${language}: install the published release version`);
  }
}
