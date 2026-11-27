// G-393 / G-10 slice 1: the shipped fixture passes, and every rule in
// specs/bench-driver.md fails when it is broken. A checker that only ever
// sees the good transcript has not been shown to check anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkExchange, readFixture } from './bench-driver-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = () => readFixture(join(here, '..', 'specs', 'bench-driver', 'conformance.jsonl'));
const at = (lines, type, n = 0) => lines.filter((l) => l.msg.type === type)[n];

test('the shipped fixture is a valid exchange', () => {
  assert.deepEqual(checkExchange(fixture()), { toolCalls: 1, modelCalls: 2, status: 'completed' });
});

const broken = {
  'start without a cost cap': (l) => { delete at(l, 'start').msg.limits.max_cost_usd; },
  'a zero cost cap': (l) => { at(l, 'start').msg.limits.max_cost_usd = 0; },
  'a retired *-4-* model id': (l) => { at(l, 'start').msg.model.id = 'claude-haiku-4-5'; },
  'an approval policy other than auto_grant_all': (l) => { at(l, 'start').msg.approval_policy = 'ask'; },
  'a padded tool name': (l) => { at(l, 'start').msg.tools[0].name = 'bash '; },
  'a tool_result for another call': (l) => { at(l, 'tool_result').msg.call_id = 't9'; },
  'a driver line while a tool call is pending': (l) => { const i = l.indexOf(at(l, 'tool_result')); l.splice(i, 0, at(l, 'usage')); },
  'a tool_call for a tool never offered': (l) => { at(l, 'tool_call').msg.name = 'python'; },
  'reasoning tokens above output tokens': (l) => { at(l, 'usage').msg.reasoning_tokens = 999; },
  'end charging less than the usage lines': (l) => { at(l, 'end').msg.charged_usd = 0; },
  'an unknown status': (l) => { at(l, 'end').msg.status = 'solved'; },
  'a line after end': (l) => { l.push(structuredClone(at(l, 'usage'))); },
  'a wrong protocol version': (l) => { l[0].msg.v = 2; },
  'the adapter speaking first': (l) => { l.shift(); },
  'an unknown driver message': (l) => { l.splice(l.length - 1, 0, { dir: 'driver', msg: { v: 1, type: 'log', text: 'x' } }); },
};

for (const [name, mutate] of Object.entries(broken)) {
  test(`refuses ${name}`, () => {
    const lines = fixture();
    mutate(lines);
    assert.throws(() => checkExchange(lines));
  });
}
