import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXPECTED, PUBLISHED, LANGUAGES, verifyRunCancelReport, verifyRunCancelMatrix, runCancelDocumentFailures } from './run-cancel-contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const document = JSON.parse(readFileSync(new URL('../suites/harness-run-cancel/cases.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../suites/harness-run-cancel/manifest.json', import.meta.url), 'utf8'));
const cases = document.cases;

// A SAFE report built from the authored expectations, with the fields they
// leave open filled the way the PHP reference fills them. Test data only:
// never written into the corpus, which records execution output alone.
const OPEN = { ended_as: null, refused_tools: ['search', 'weather'] };
function safe(id) {
  return { ...OPEN, ...structuredClone(EXPECTED[id]) };
}
function nativeFor(id, result) {
  return { event_names: result.events.map((name) => `native.${name}`), projected_from: 0,
    park_stored_status: id === 'hrc-0004' ? 'running' : null,
    error: result.error_code === null ? null : 'NativeError', decisions: null, resumes: null, run_id_shape: 'x', package_version: 'dev' };
}
function report(language) {
  return { results: cases.map((row) => {
    const result = safe(row.id);
    return { id: row.id, result, native: nativeFor(row.id, result) };
  }) };
}
const row = (id) => cases.findIndex((entry) => entry.id === id);

test('a safe report passes in every language, in development', () => {
  for (const language of LANGUAGES) verifyRunCancelReport(language, report(language), cases, true);
});

// The discrimination proof: each mutation is an UNSAFE result. It is applied to
// all three languages at once, so the languages would AGREE, and the contract
// must still refuse it.
const UNSAFE = [
  ['a tool ran after the cancel', 'hrc-0001', (r) => { r.tools_run = ['search', 'weather']; r.refused_tools = []; }],
  ['the next tool was not refused', 'hrc-0001', (r) => { r.refused_tools = []; }],
  ['a model call after the cancel', 'hrc-0001', (r) => { r.model_calls = 2; }],
  ['a tool ran when the cancel landed in the model call', 'hrc-0002', (r) => { r.tools_run = ['search']; }],
  ['the race read completed after ok', 'hrc-0003', (r) => { r.run_status = 'completed'; }],
  ['the race was cancelled only in the overlay', 'hrc-0003', (r) => { r.stored_status = 'completed'; }],
  ['finished beside cancelled', 'hrc-0001', (r) => { r.events = ['cancel_requested', 'finished', 'cancelled']; }],
  ['two request events for a double cancel', 'hrc-0010', (r) => { r.events = ['cancel_requested', 'cancel_requested', 'cancelled']; r.request_states = ['running', 'running']; }],
  ['a parked approval still pending', 'hrc-0004', (r) => { r.approval_status_after = 'pending'; }],
  ['a decision accepted after the cancel', 'hrc-0004', (r) => { r.decide_refused = false; }],
  ['a resume accepted after the cancel', 'hrc-0004', (r) => { r.resume_refused = false; }],
  ['the gated tool ran after the cancel', 'hrc-0004', (r) => { r.tools_run = ['search', 'weather']; }],
  ['a parked run read as running after the cancel', 'hrc-0004', (r) => { r.run_status = 'running'; }],
  ['a parked run ended finished instead of cancelled', 'hrc-0004', (r) => { r.events = ['cancel_requested', 'finished']; }],
  ['a model call after a parked cancel', 'hrc-0004', (r) => { r.model_calls = 2; }],
  ['another session cancelled the run', 'hrc-0005', (r) => { r.outcomes = ['ok']; }],
  ['a forged id cancelled the run', 'hrc-0006', (r) => { r.outcomes = ['ok']; r.run_status = 'cancelled'; }],
  ['a padded id accepted', 'hrc-0007', (r) => { r.outcomes[6] = 'ok'; }],
  ['a session with no run answered refused instead of no-turn', 'hrc-0008', (r) => { r.outcomes = ['refused', 'no-turn']; }],
  ['a finished run rewritten as cancelled', 'hrc-0009', (r) => { r.run_status = 'cancelled'; }],
  ['the control refused its tools', 'hrc-0011', (r) => { r.tools_run = ['search']; r.refused_tools = ['weather']; }],
  ['events carry the wrong run', 'hrc-0001', (r) => { r.events_tagged = false; }],
];
for (const [name, id, mutate] of UNSAFE) {
  test(`the contract refuses an unsafe result all three languages share: ${name}`, () => {
    for (const language of LANGUAGES) {
      const unsafe = report(language);
      mutate(unsafe.results[row(id)].result);
      assert.throws(() => verifyRunCancelReport(language, unsafe, cases, true), /run-cancel safety contract|request event|cancelled event|never/, `${language}/${id}`);
    }
  });
}

test('missing and duplicate executions cannot become a smaller green suite', () => {
  const valid = report('ts');
  assert.throws(() => verifyRunCancelReport('ts', { results: [] }, cases, true), /missing/);
  assert.throws(() => verifyRunCancelReport('ts', { results: [...valid.results, ...valid.results] }, cases, true), /duplicate/);
  assert.throws(() => verifyRunCancelReport('ts', valid, [], true), /No run-cancel inputs/);
});

test('replacing hostile inputs with controls cannot collapse the suite', () => {
  verifyRunCancelMatrix(cases);
  const collapsed = structuredClone(cases);
  for (const entry of collapsed) Object.assign(entry.input, { cancel_at: null, cancels: [], after: [], settle: false });
  assert.throws(() => verifyRunCancelMatrix(collapsed), /controls cannot replace hostile cases/);
  assert.throws(() => verifyRunCancelMatrix(collapsed.slice(1)), /All eleven/);
});

test('no published release is claimed, so only development can run', () => {
  assert.deepEqual(PUBLISHED, { php: null, ts: null, py: null }, 'Naming a release is a release step, reviewed with its goldens');
  assert.throws(() => verifyRunCancelReport('php', report('php'), cases, false), /no published harness release/);
  const refused = spawnSync(process.execPath, ['tools/run-cancel-corpus.mjs', '--record'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /No published harness release carries G-285/);
  const mixed = spawnSync(process.execPath, ['tools/run-cancel-corpus.mjs', '--record', '--development'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(mixed.status, 0);
  assert.match(mixed.stderr, /--development cannot record goldens/);
});

test('the committed document claims nothing: no golden, no agreement, consistent with the manifest', () => {
  assert.deepEqual(runCancelDocumentFailures(document, manifest), []);
  for (const entry of cases) {
    for (const language of LANGUAGES) assert.equal(entry.result[language], null, `${entry.id}/${language}: goldens come only from published artifacts`);
    assert.equal(Object.hasOwn(entry, 'agrees'), false, `${entry.id}: an unrecorded row carries no agreement claim`);
  }
});

test('a golden smuggled in beside a partial manifest is refused', () => {
  const forged = structuredClone(document);
  forged.cases[0].result.php = JSON.stringify(safe('hrc-0001'));
  forged.cases[0].native.php = { event_names: [], projected_from: 0, park_stored_status: null, error: null, decisions: null, resumes: null, run_id_shape: null, package_version: '9.9.9' };
  assert.match(runCancelDocumentFailures(forged, manifest).join('\n'), /needs a full implementation/);
  const claimed = structuredClone(document);
  claimed.cases[0].agrees = true;
  assert.match(runCancelDocumentFailures(claimed, manifest).join('\n'), /unrecorded rows claim nothing/);
  const fullNoResult = structuredClone(manifest);
  fullNoResult.implementations.ts.status = 'full';
  assert.match(runCancelDocumentFailures(document, fullNoResult).join('\n'), /needs a recorded result/);
});

test('an unsafe recorded golden is refused even with a full manifest', () => {
  const full = structuredClone(manifest);
  for (const language of LANGUAGES) full.implementations[language].status = 'full';
  const recorded = structuredClone(document);
  for (const entry of recorded.cases) {
    for (const language of LANGUAGES) {
      recorded.cases[row(entry.id)].result[language] = JSON.stringify(safe(entry.id));
      recorded.cases[row(entry.id)].native[language] = { event_names: [], projected_from: 0, park_stored_status: null, error: null, decisions: null, resumes: null, run_id_shape: null, package_version: '1.0.0' };
    }
    entry.agrees = true;
  }
  assert.deepEqual(runCancelDocumentFailures(recorded, full), []);
  const unsafe = safe('hrc-0001'); unsafe.tools_run = ['search', 'weather'];
  for (const language of LANGUAGES) recorded.cases[0].result[language] = JSON.stringify(unsafe);
  assert.match(runCancelDocumentFailures(recorded, full).join('\n'), /breaks the safety contract/);
});

test('the native column must account for every event before the projection', () => {
  const shifted = report('php');
  shifted.results[0].native.projected_from = 1;
  assert.throws(() => verifyRunCancelReport('php', shifted, cases, true), /every projected event/);
  const hidden = report('ts');
  hidden.results[row('hrc-0004')].native.park_stored_status = null;
  assert.throws(() => verifyRunCancelReport('ts', hidden, cases, true), /recorded natively/);
});
