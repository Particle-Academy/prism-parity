import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile } from '@particle-academy/fancy-schema';
import { approvalPairingFailures } from './approval-pairing/contract.mjs';

const check = compile(JSON.parse(readFileSync(new URL('../schema/cases.schema.json', import.meta.url), 'utf8')));
const fixture = () => JSON.parse(readFileSync(new URL('../suites/harness-approval-pairing/cases.json', import.meta.url), 'utf8'));
const first = (document) => document.cases[0];
const laterRow = (document) => document.cases.find((row) => row.later);

test('harness-approval-pairing contract rejects a row with no rounds unless it is altered_copy_after_approval', () => {
  const document = fixture();
  first(document).rounds = [];
  assert.equal(check(document).valid, true);
  assert.ok(approvalPairingFailures(document).some((failure) => failure.includes('at least one round')));
});

test('the harness-approval-pairing corpus fits the schema and its contract', () => {
  const document = fixture();
  assert.equal(check(document).valid, true);
  assert.deepEqual(approvalPairingFailures(document), []);
});

for (const [name, mutate] of [
  ['an unknown tool', (document) => { first(document).calls[0].name = 'shell'; }],
  ['a call without an id', (document) => { delete first(document).calls[0].id; }],
  ['a non-integer ran entry', (document) => { first(document).expected.ran = ['2']; }],
  ['a missing native result', (document) => { delete first(document).result.py; }],
  ['an unregistered language', (document) => { first(document).result.ruby = first(document).expected; }],
  ['extra data in an outcome', (document) => { first(document).result.php.asked = []; }],
  ['a decision that is not a pair', (document) => { first(document).rounds[0][0] = [0]; }],
  ['an empty round', (document) => { first(document).rounds.push([]); }],
  ['a later step without calls', (document) => { laterRow(document).later.calls = []; }],
  ['extra data in a later result', (document) => { laterRow(document).later.result.run_id = 'run_x'; }],
  ['a negative resume count', (document) => { laterRow(document).later.resumes = -1; }],
]) test(`harness-approval-pairing schema rejects ${name}`, () => {
  const document = fixture(); mutate(document); assert.equal(check(document).valid, false);
});

for (const [name, mutate, pattern] of [
  ['a reversed decision pair', (document) => { first(document).rounds[0][0] = [false, 0]; }, /not an \[index, approved\] pair/],
  ['an index past the issued approvals', (document) => { first(document).rounds[0][1] = [2, true]; }, /first step issued 2/],
  ['one approval decided twice in a round', (document) => { first(document).rounds[0][1] = [0, true]; }, /twice/],
  ['an unsorted ran list', (document) => { first(document).result.ts.ran = [2, 1]; }, /ts\.ran is not sorted/],
  ['agreement that hides a changed outcome', (document) => { first(document).result.ts = { approvals: 2, free: 0, ran: [1, 2] }; }, /agreement does not match/],
  ['a later round past the later approvals', (document) => { laterRow(document).later.rounds = [[[1, true]]]; }, /later step issued 1/],
  ['a later result approving an approval never issued', (document) => { laterRow(document).later.result.approved = [3]; }, /later\.result approves 3/],
]) test(`harness-approval-pairing contract rejects ${name}`, () => {
  const document = fixture(); mutate(document); assert.match(approvalPairingFailures(document).join('\n'), pattern);
});
