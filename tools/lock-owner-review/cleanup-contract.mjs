import assert from 'node:assert/strict';

export const cleanupRow = {
  id: 'cleanup-refused-by-os',
  owner: 'same-identity-proven-released',
  temporary: 'observed-nonce-release-file',
  os_errors: { ts: ['EPERM', 'EBUSY'], py: [5, 32] },
  expected_state: 'held',
  admission: {
    action: 'backoff-and-reinspect', backoff_milliseconds: 25,
    budget: 'existing-wait-budget', callback_before_clear: false,
    on_expired: 'session_locked', on_unrelated_error: 'propagate',
  },
  after_clear: { action: 'nonce-bound-reclaim', callbacks: 1 },
  required_cases: ['held-then-cleared', 'budget-exhausted', 'unrelated-error'],
};

export function requireCleanupVector(value) {
  assert.deepEqual(value, cleanupRow, 'Unknown, weakened or incomplete cleanup-refusal row');
  return value;
}

export function cleanupCaseIds(language) {
  assert(['ts', 'py'].includes(language), 'Unknown file-owner implementation');
  return [
    ...cleanupRow.os_errors[language].map(code => 'held-then-cleared/' + code),
    ...cleanupRow.os_errors[language].map(code => 'budget-exhausted/' + code),
    'unrelated-error/EIO',
  ];
}

export function requireCleanupEvidence(value) {
  assert.equal(value.format, 'file-lock-cleanup-held-evidence-v1');
  assert.equal(value.row, cleanupRow.id);
  assert.match(value.inputSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(value.reports.map(row => row.language).sort(), ['py', 'ts']);
  for (const report of value.reports) {
    assert.match(report.sourceHead, /^[a-f0-9]{40}$/);
    assert.equal(report.fixtureSemanticSha256, value.inputSha256);
    assert.match(report.sourceTestSha256, /^[a-f0-9]{64}$/);
    assert.match(report.nativeReportSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(report.tests.map(row => row.id), cleanupCaseIds(report.language));
    assert(report.tests.every(row => row.status === 'passed' && typeof row.name === 'string' && row.name.length > 0));
  }
  return true;
}
