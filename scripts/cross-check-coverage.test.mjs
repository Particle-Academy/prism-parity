import assert from 'node:assert/strict';
import test from 'node:test';
import { coverage, streamTraceFailures } from './cross-check-coverage.mjs';

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

test('property verification retains native trace divergence separately from skips', () => {
  const result = coverage(new Map([
    ['php', report([{ id: 'stream', status: 'pass', trace_comparison: { status: 'match', gap: null } }])],
    ['ts', report([{ id: 'stream', status: 'pass', trace_comparison: { status: 'known-divergence', gap: 'G-125' } }])],
  ]));
  assert.deepEqual(result.verified, ['example/stream']);
  assert.equal(result.skippedCases, 0);
  assert.deepEqual(result.traceDivergences, [{ key: 'example/stream', language: 'ts', gap: 'G-125' }]);
});

test('stream passes require actual trace evidence and independently valid properties', () => {
  const properties = { text: '', normal_completion: true, error_observable: false, terminal_events: 1, no_completed_tools: true, usage_known: false };
  const trace = { events: [{ type: 'stream_end', payload: { finish_reason: 'stop', usage: null } }], terminal: { status: 'returned' }, requests: 1 };
  const golden = JSON.stringify(trace);
  const manifests = new Map([['example', { kind: 'stream-parse' }]]);
  const fixtures = new Map([['example', { cases: [{ id: 'stream', properties, expect: { result_json: golden } }] }]]);
  const check = row => streamTraceFailures(new Map([['ts', report([row])]]), manifests, fixtures);
  const valid = { id: 'stream', status: 'pass', trace_comparison: { status: 'match', gap: null, expected: golden, actual: golden } };
  assert.deepEqual(check(valid), []);
  assert.match(check({ id: 'stream', status: 'pass' }).join(), /missing or wrong native trace/);
  const changed = structuredClone(valid);
  changed.trace_comparison.actual = JSON.stringify({ ...trace, events: [] });
  changed.trace_comparison.status = 'known-divergence';
  changed.trace_comparison.gap = 'G-125';
  assert.match(check(changed).join(), /native trace violates terminal_events/);
  changed.trace_comparison.status = 'match';
  assert.match(check(changed).join(), /false trace equality/);
  changed.trace_comparison.gap = 'G-999';
  assert.match(check(changed).join(), /unregistered/);
});

test('registered shape divergence cannot excuse Unknown finish or unclosed text', () => {
  const properties = { text: 'Hé', normal_completion: false, error_observable: true, terminal_events: 1, no_completed_tools: true, usage_known: false };
  const actual = {
    events: [
      { type: 'text_start', payload: {} },
      { type: 'text_delta', payload: { delta: 'Hé' } },
      { type: 'error', payload: { code: 'owned_error' } },
      { type: 'stream_end', payload: { finish_reason: 'unknown', usage: null } },
    ], terminal: { status: 'returned' }, requests: 1,
  };
  const golden = 'owned reference trace';
  const manifests = new Map([['example', { kind: 'stream-parse' }]]);
  const fixtures = new Map([['example', { cases: [{ id: 'stream', properties, expect: { result_json: golden } }] }]]);
  const reports = new Map([['ts', report([{ id: 'stream', status: 'pass', trace_comparison: { status: 'known-divergence', gap: 'G-125', expected: golden, actual: JSON.stringify(actual) } }])]]);
  const failures = streamTraceFailures(reports, manifests, fixtures).join();
  assert.match(failures, /text_completion/);
  assert.match(failures, /normal_completion/);
});

test('PHP native completion needs closure while ports also carry completed text', () => {
  const properties = { text: 'Hé', normal_completion: true, error_observable: false, terminal_events: 1, no_completed_tools: true, usage_known: false };
  const trace = { events: [
    { type: 'text_start', payload: { message_id: 'owned' } },
    { type: 'text_delta', payload: { message_id: 'owned', delta: 'Hé' } },
    { type: 'text_complete', payload: { message_id: 'owned' } },
    { type: 'stream_end', payload: { finish_reason: 'Stop', usage: null } },
  ], terminal: { status: 'returned' }, requests: 1 };
  const golden = JSON.stringify(trace);
  const manifests = new Map([['example', { kind: 'stream-parse' }]]);
  const fixtures = new Map([['example', { cases: [{ id: 'stream', properties, expect: { result_json: golden } }] }]]);
  const check = language => streamTraceFailures(new Map([[language, report([{ id: 'stream', status: 'pass', trace_comparison: { status: 'match', gap: null, expected: golden, actual: JSON.stringify(trace) } }])]]), manifests, fixtures);
  assert.deepEqual(check('php'), []);
  assert.match(check('ts').join(), /text_completion/);
  assert.match(check('py').join(), /text_completion/);
  trace.events.splice(2, 1);
  assert.match(check('php').join(), /text_completion/);
});
