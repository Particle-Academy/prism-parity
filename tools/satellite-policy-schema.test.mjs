import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile } from '@particle-academy/fancy-schema';
import { satellitePolicyFailures } from './satellite-policy/contract.mjs';
import { gates } from './gate-contracts.mjs';
import { requireVerdict } from './alignment-contracts.mjs';
import { validateCandidateRefs, verifyCandidateTrees } from './satellite-policy/candidate-contract.mjs';

const refs = () => JSON.parse(readFileSync(new URL('./satellite-policy/candidate-refs.json', import.meta.url)));
test('candidate source identity requires all packages and refuses counterfeit trees', () => {
  const original = refs();
  assert.doesNotThrow(() => validateCandidateRefs(original));
  for (const mutate of [r => r.packages.pop(), r => { r.packages[0] = r.packages[1]; }, r => { r.packages[0].repository = '../foreign'; }, r => { r.packages[0].source = 'main'; }, r => { r.referenceKind = 'published'; }, r => { r.packages[0].NODE_OPTIONS = 'unsafe'; }]) {
    const changed = refs(); mutate(changed); assert.throws(() => validateCandidateRefs(changed));
  }
  const clean = (cwd, args) => args[0] === 'rev-parse' ? original.packages.find(row => cwd.replaceAll('\\', '/').endsWith('/'+row.repository)).source : '';
  assert.doesNotThrow(() => verifyCandidateTrees('/scratch/prism-parity', original, clean));
  for (const [label, command, value] of [['wrong checkout', 'rev-parse', '0'.repeat(40)], ['dirty source', 'diff', 'src/unreviewed'], ['extra runtime', 'ls-files', 'src/foreign']]) {
    assert.throws(() => verifyCandidateTrees('/scratch/prism-parity', original, (cwd, args) => args[0] === command ? value : clean(cwd, args)), label);
  }
});

const check = compile(JSON.parse(readFileSync(new URL('../schema/cases.schema.json', import.meta.url), 'utf8')));
const fixture = () => JSON.parse(readFileSync(new URL('../suites/satellite-policy/cases.json', import.meta.url), 'utf8'));
test('native satellite corpus satisfies the closed schema and predictions', () => {
  assert.equal(check(fixture()).valid, true);
  assert.deepEqual(satellitePolicyFailures(fixture()), []);
});
for (const [name, mutate] of [
  ['empty coverage', d => { d.cases = []; }],
  ['missing reference', d => { delete d.cases[0].result.php; }],
  ['foreign language', d => { d.cases[0].result.ruby = {}; }],
  ['unknown operation', d => { d.cases[0].given.kind = 'execute'; }],
  ['environment override', d => { d.cases[0].given.NODE_OPTIONS = 'unsafe'; }],
  ['wrong observation', d => { d.cases[0].result.ts.message = 'remote'; }],
  ['unbounded DNS records', d => { d.cases.find(c => c.given.kind === 'relay-dns').given.answers = [Array(100000).fill('8.8.8.8')]; }],
  ['malformed native status', d => { d.cases.find(c => c.given.kind === 'relay-native').given.postStatus = 0; }],
  ['malformed identity', d => { d.cases[0].id = 's-0001'; }],
]) test('satellite schema rejects '+name, () => {
  const document = fixture(); mutate(document); assert.equal(check(document).valid, false);
});
for (const [name, mutate, message] of [
  ['forged agreement', d => { d.cases[0].result.py.engineCalls = 1; }, /agreement differs/],
  ['all languages wrong together', d => { for (const value of Object.values(d.cases[0].result)) value.engineCalls = 1; }, /independent prediction failed/],
  ['duplicate row', d => { d.cases[1].id = d.cases[0].id; }, /duplicate/],
  ['skipped family', d => { d.cases = d.cases.filter(c => c.given.kind !== 'relay-native'); }, /incomplete native coverage/],
  ['missing native observation', d => { d.cases[0].result.php = null; }, /all native observations/],
]) test('satellite contract rejects '+name, () => {
  const document = fixture(); mutate(document); assert.match(satellitePolicyFailures(document).join('\n'), message);
});
test('satellite gate refuses zero work, drift, counterfeit verdicts and failed exits', () => {
  const valid = 'satellite-policy php: 232 executed; 0 changed; independent predictions and check passed.';
  assert.doesNotThrow(() => requireVerdict('satellitePolicy', { status: 0, stdout: valid }, gates.satellitePolicy));
  for (const stdout of ['', valid.replace('232 executed', '0 executed'), valid.replace('0 changed', '1 changed'), valid.replace('independent predictions and ', '')]) assert.throws(() => requireVerdict('satellitePolicy', { status: 0, stdout }, gates.satellitePolicy), /missing.*verdict/);
  assert.throws(() => requireVerdict('satellitePolicy', { status: 1, stdout: valid }, gates.satellitePolicy), /exit/);
});
