import assert from 'node:assert/strict';
import test from 'node:test';
import { coverage } from './cross-check-coverage.mjs';

const report = (results) => [{ suite: 'example', results }];

test('only cases passed in every language count as verified', () => {
  const result = coverage(new Map([
    ['php', report([{ id: 'all', status: 'pass' }, { id: 'partial', status: 'pass' }])],
    ['ts', report([{ id: 'all', status: 'pass' }, { id: 'partial', status: 'skip', reason: 'No runner.' }])],
  ]));

  assert.deepEqual(result.verified, ['example/all']);
  assert.equal(result.skippedCases, 1);
  assert.deepEqual(result.skips, [{ key: 'example/partial', language: 'ts', reason: 'No runner.' }]);
});

test('an all-skipped suite contributes zero verified cases and retains each reason', () => {
  const result = coverage(new Map([
    ['php', report([{ id: 'one', status: 'skip', reason: 'Package runner.' }])],
    ['py', report([{ id: 'one', status: 'skip', reason: 'Unimplemented.' }])],
  ]));

  assert.deepEqual(result.verified, []);
  assert.equal(result.skippedCases, 1);
  assert.deepEqual(result.skips, [
    { key: 'example/one', language: 'php', reason: 'Package runner.' },
    { key: 'example/one', language: 'py', reason: 'Unimplemented.' },
  ]);
});

test('absent or failed verdicts never count as verified', () => {
  const result = coverage(new Map([
    ['php', report([{ id: 'absent', status: 'pass' }, { id: 'failed', status: 'pass' }])],
    ['ts', report([{ id: 'failed', status: 'fail' }])],
  ]));

  assert.deepEqual(result.verified, []);
  assert.deepEqual(result.skips, []);
});
