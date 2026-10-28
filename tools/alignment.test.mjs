import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compareClaims, checkRunner, requireVerdict, verifyCoverage, unmarkedCounts, checkWorkflowDependencies } from './alignment-contracts.mjs';
import { coverage } from '../scripts/cross-check-coverage.mjs';
import { gates } from './gate-contracts.mjs';
import { validateWindowsContexts, NO_JOB_UNMEASURED } from './lock-owner-review/windows-context-contract.mjs';

test('native recovery evidence requires actual work and explicit verified or unmeasured Windows baseline', () => {
  const prefix = 'Lock identity recovery passed: 1 live owner held; 1 dead owner recovered; 3 foreign/unknown rows held; 0 foreign PID probes; ';
  const suffixes = ['1 native contexts on linux.', '1 native contexts on darwin.', '3 measured Windows contexts; no-job unmeasured-with-membership-evidence on win32.', '4 measured Windows contexts; no-job verified-absent on win32.'];
  for (const suffix of suffixes) {
    assert.doesNotThrow(() => requireVerdict('lockIdentityRecovery', { status: 0, stdout: prefix + suffix }, gates.lockIdentityRecovery));
  }
  const valid = prefix + suffixes[2];
  for (const stdout of ['', valid.replace('3 measured', '0 measured'), valid.replace('3 measured', '2 measured'), valid.replace('3 measured', '4 measured'), valid.replace('unmeasured-with-membership-evidence', 'passed'), valid.replace('1 dead owner', '0 dead owner'), valid.replace('3 foreign/unknown', '0 foreign/unknown'), valid.replace('0 foreign PID', '1 foreign PID')]) {
    assert.throws(() => requireVerdict('lockIdentityRecovery', { status: 0, stdout }, gates.lockIdentityRecovery), /missing.*verdict/);
  }
  assert.throws(() => requireVerdict('lockIdentityRecovery', { status: 1, stdout: valid }, gates.lockIdentityRecovery), /exit/);
});

test('Windows realm identity boundary cannot import or invoke Job or silo APIs', () => {
  const js = readFileSync(new URL('./lock-owner-review/windows-identity.mjs', import.meta.url), 'utf8');
  const cs = readFileSync(new URL('./lock-owner-review/windows-identity.cs', import.meta.url), 'utf8');
  const validate = (javascript, native) => {
    assert.doesNotMatch(javascript + native, /\b(?:\w*Job\w*|\w*Silo\w*|ProcessMembershipInformation)\b/i, 'Identity must ignore Job/silo APIs');
    assert.deepEqual([...javascript.matchAll(/^import\s+(?:[^'"\n]*from\s+)?['"]([^'"]+)['"];?$/gm)].map(match => match[1]).sort(), ['node:assert/strict', 'node:child_process', 'node:fs']);
    const imports = [...native.matchAll(/\[DllImport\("([^"]+)"[^\]]*\)\]\s*static extern \w+ (\w+)\(/g)].map(match => [match[1], match[2]]);
    assert.deepEqual(imports, [['advapi32.dll', 'RegOpenKeyEx'], ['advapi32.dll', 'RegQueryValueEx'], ['advapi32.dll', 'RegCloseKey']]);
    assert.match(javascript, /Get-CimInstance -ClassName Win32_OperatingSystem/);
    assert.match(native, /"ContainerType"/);
  };
  validate(js, cs);
  assert.throws(() => validate(js + '\nIsProcessInJob();', cs), /Identity must ignore/);
  assert.throws(() => validate(js, cs + '\nQueryInformationJobObject();'), /Identity must ignore/);
  assert.throws(() => validate(js + "\nimport './windows-review.mjs';", cs));
  assert.throws(() => validate(js + "\nimport x from 'another-native-boundary';", cs));
  assert.doesNotMatch(readFileSync(new URL('./lock-owner-review/identity.mjs', import.meta.url), 'utf8'), /windows-review|Job|Silo/);
});

test('Windows no-Job claims require measured membership and cannot replace mandatory recovery rows', () => {
  const identity = { platform: 'win32', boot_id: 'cim-utc-ticks:123', pid_namespace: 'win32:kernel' };
  const proof = { identity, holder_identity: identity, live: { result: 'held', probes: 1 }, dead: { result: 'nonce-bound-reclaimed', probes: 1 }, held: ['foreign-realm', 'foreign-realm-released', 'both-unknown'].map(id => ({ id, result: 'held-unknown', probes: 0, directory_unchanged: true })) };
  const report = { failures: [], rows: [{ name: 'no-job', status: 'unmeasured', reason: NO_JOB_UNMEASURED, native: { status: 'unmeasured', membership_checked: true, initial_no_job: false, breakaway_requested: true, child_ran: false } }, ...['ordinary-job', 'nested-job', 'inherited-supervisor-job'].map(name => ({ name, status: 'passed', native: { status: 'passed', membership_checked: true, exit: 0, initial_no_job: false, breakaway_requested: false, verified_owned_job_depth: name === 'nested-job' ? 2 : 1 }, proof }))] };
  assert.deepEqual(validateWindowsContexts(report), { measured_contexts: 3, no_job: 'unmeasured-with-membership-evidence' });
  const measured = structuredClone(report);
  measured.rows[0] = { name: 'no-job', status: 'passed', native: { status: 'passed', membership_checked: true, initial_no_job: true, breakaway_requested: true, exit: 0, verified_owned_job_depth: 0 }, proof };
  assert.deepEqual(validateWindowsContexts(measured), { measured_contexts: 4, no_job: 'verified-absent' });
  for (const mutate of [
    copy => { copy.rows[0].native.initial_no_job = false; },
    copy => { copy.rows[0].native.membership_checked = false; },
    copy => { copy.rows.pop(); },
    copy => { copy.rows[1].status = 'unmeasured'; },
    copy => { copy.rows[2].proof.dead.result = 'held'; },
    copy => { copy.rows[3].proof.held[0].probes = 1; },
  ]) { const copy = structuredClone(measured); mutate(copy); assert.throws(() => validateWindowsContexts(copy)); }
  const fabricated = structuredClone(report); fabricated.rows[0].reason = 'a generic setup error';
  assert.throws(() => validateWindowsContexts(fabricated));
});

test('lock primitive evidence requires native work and rejects empty or unsupported reports', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.doesNotThrow(() => requireVerdict('lockPrimitives', { status: 0, stdout: 'Lock directory primitives passed: 5 required rows on ' + platform + '.' }, gates.lockPrimitives));
  }
  for (const stdout of ['', 'Lock directory primitives passed: 0 required rows on win32.', 'Lock directory primitives passed: 3 required rows on win32.', 'Lock directory primitives passed: 5 required rows on unknown.']) {
    assert.throws(() => requireVerdict('lockPrimitives', { status: 0, stdout }, gates.lockPrimitives), /missing.*verdict/);
  }
});

test('published lock evidence refuses callbacks, missing observation controls and vacuous rows', () => {
  const valid = 'Published lock coexistence passed: 6 new-directory rows; 0 callbacks; 0 unlink/rename attempts; 3 active reclaim controls.';
  assert.doesNotThrow(() => requireVerdict('publishedLockCoexistence', { status: 0, stdout: valid }, gates.publishedLockCoexistence));
  for (const stdout of ['', valid.replace('6 new-directory', '0 new-directory'), valid.replace('0 callbacks', '1 callbacks'), valid.replace('0 unlink', '1 unlink'), valid.replace('3 active', '0 active')]) {
    assert.throws(() => requireVerdict('publishedLockCoexistence', { status: 0, stdout }, gates.publishedLockCoexistence), /missing.*verdict/);
  }
  assert.throws(() => requireVerdict('publishedLockCoexistence', { status: 1, stdout: valid }, gates.publishedLockCoexistence), /exit/);
});

test('a deliberately misstated published number fails with its file, line and diff', () => {
  assert.deepEqual(compareClaims('README.md', 'Title\n<!-- metric:security.corpora -->15<!-- /metric --> corpora', { 'security.corpora': 16 }), [
    'README.md:2: metric security.corpora\n- 15\n+ 16',
  ]);
  assert.deepEqual(compareClaims('README.md', '<!-- metric:security.corpora -->16<!-- /metric -->', { 'security.corpora': 16 }), []);
});

test('unknown and malformed metric claims cannot silently drop out of checking', () => {
  assert.match(compareClaims('docs/a.md', '<!-- metric:typo -->16<!-- /metric -->', {})[0], /unknown metric/);
  assert.match(compareClaims('docs/a.md', '<!-- metric:security.corpora -->16', { 'security.corpora': 16 })[0], /unterminated/);
  assert.match(compareClaims('docs/a.md', '<!-- metric:security.corpora -->undefined<!-- /metric -->', { 'security.corpora': undefined })[0], /no usable value/);
});

test('new unmarked inventory and coverage totals cannot bypass regeneration', () => {
  assert.match(unmarkedCounts('README.md', 'There are 15 security corpora.')[0], /README.md:1.*unmarked/);
  assert.match(unmarkedCounts('AGENTS.md', 'We verified 76 cases.')[0], /unmarked/);
  assert.deepEqual(unmarkedCounts('docs/trust-rubric.md', 'At least three cases are required.'), []);
  assert.deepEqual(unmarkedCounts('README.md', '<!-- metric:security.corpora -->16<!-- /metric --> security corpora.'), []);
});

test('each non-full implementation needs both cause and gap', () => {
  assert.match(checkRunner('.', 'suite/ts', { status: 'partial', gap: 'Missing runner' }).failures.join('\n'), /cause/);
  assert.match(checkRunner('.', 'suite/ts', { status: 'partial', cause: 'no-runner', gap: ' ' }).failures.join('\n'), /gap/);
});

test('local claimed runners must be files; external runners are visibly unverified', () => {
  const root = mkdtempSync(join(tmpdir(), 'prism-alignment-'));
  try {
    mkdirSync(join(root, 'runners'));
    writeFileSync(join(root, 'runners/test.mjs'), '');
    assert.deepEqual(checkRunner(root, 'suite/ts', { status: 'full', runner: 'prism-parity:runners/test.mjs' }), { failures: [], unchecked: [] });
    assert.match(checkRunner(root, 'suite/ts', { status: 'full', runner: 'prism-parity:missing' }).failures.join('\n'), /missing/);
    assert.match(checkRunner(root, 'suite/ts', { status: 'full', runner: 'prism-parity:runners' }).failures.join('\n'), /file/);
    assert.match(checkRunner(root, 'suite/ts', { status: 'full', runner: 'prism-parity:../escape' }).failures.join('\n'), /outside/);
    assert.deepEqual(checkRunner(root, 'suite/php', { status: 'full', runner: 'prism:tests/External.php' }).unchecked,
      ['suite/php: prism:tests/External.php (external checkout required)']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an exit-zero gate without its own verdict fails, as does a crash after printing success', () => {
  const rule = { verdict: /^Corpus guards passed \(([1-9]\d*) files scanned\)\.$/m };
  assert.throws(() => requireVerdict('guard', { status: 0, stdout: '', stderr: '' }, rule), /missing.*verdict/);
  assert.throws(() => requireVerdict('guard', { status: 0, stdout: 'Corpus guards passed (0 files scanned).', stderr: '' }, rule), /missing.*verdict/);
  assert.throws(() => requireVerdict('guard', { status: 1, stdout: 'Corpus guards passed (3 files scanned).', stderr: '' }, rule), /exit/);
  assert.doesNotThrow(() => requireVerdict('guard', { status: 0, stdout: '', stderr: 'Corpus guards passed (3 files scanned).' }, rule));
});

test('skip accounting rejects invented agreement and retains language-specific reasons', () => {
  const reports = new Map([
    ['php', [{ suite: 's', results: [{ id: 'control', status: 'pass' }, { id: 'missing', status: 'pass' }] }]],
    ['ts', [{ suite: 's', results: [{ id: 'control', status: 'pass' }, { id: 'missing', status: 'skip', reason: 'No runner.' }] }]],
  ]);
  assert.deepEqual(verifyCoverage(reports, coverage(reports)), []);
  assert.match(verifyCoverage(reports, { ...coverage(reports), verified: ['s/control', 's/missing'] }).join('\n'), /unrun/);
  assert.match(verifyCoverage(reports, { ...coverage(reports), skips: [] }).join('\n'), /skip/);
});

test('a wholly skipped suite fails even beside another suite that passes', () => {
  const reports = new Map(['php', 'ts'].map((language) => [language, [
    { suite: 'working', results: [{ id: 'ok', status: 'pass' }] },
    { suite: 'unrun', results: [{ id: 'never', status: 'skip', reason: 'No runner.' }] },
  ]]));
  assert.match(verifyCoverage(reports, coverage(reports)).join('\n'), /unrun.*every language/);
});

test('empty suites, duplicate verdicts and unexplained skips are not evidence', () => {
  const empty = new Map([['php', [{ suite: 'empty', results: [] }]]]);
  assert.match(verifyCoverage(empty, coverage(empty)).join('\n'), /empty.*no rows/);
  const duplicate = new Map([['php', [{ suite: 's', results: [{ id: 'a', status: 'pass' }, { id: 'a', status: 'pass' }] }]]]);
  assert.match(verifyCoverage(duplicate, coverage(duplicate)).join('\n'), /duplicate/);
  const unexplained = new Map([['php', [{ suite: 's', results: [{ id: 'a', status: 'skip', reason: '' }] }]]]);
  assert.match(verifyCoverage(unexplained, coverage(unexplained)).join('\n'), /reason/);
});

test('the executable wrapper rejects a zero-exit no-op and a missing command', () => {
  const wrapper = fileURLToPath(new URL('./run-gate.mjs', import.meta.url));
  for (const args of [['guards', '--', process.execPath, '-e', ''], ['guards', '--', 'prism-does-not-exist']]) {
    const result = spawnSync(process.execPath, [wrapper, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /Gate evidence confirmed/);
  }
  const result = spawnSync(process.execPath, [wrapper, 'guards', '--', process.execPath, '-e', 'console.log("Corpus guards passed (2 files scanned).")'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('ordinary CI jobs cannot start before the coordinating alignment job', () => {
  const good = 'jobs:\n  alignment:\n    steps:\n      - run: node tools/alignment.mjs\n      - run: node tools/run-gate.mjs remote -- node tools/remote-alignment.mjs\n  checks:\n    needs: alignment\n    runs-on: ubuntu-latest\n';
  assert.deepEqual(checkWorkflowDependencies('alignment.yml', good), []);
  assert.match(checkWorkflowDependencies('alignment.yml', good.replace('    needs: alignment\n', ''))[0], /checks.*needs/);
  assert.match(checkWorkflowDependencies('alignment.yml', 'jobs:\n  checks:\n    runs-on: ubuntu-latest\n').join('\n'), /alignment/);
  assert.match(checkWorkflowDependencies('alignment.yml', good + '    steps:\n      - run: node tools/guard-corpus.mjs\n').join('\n'), /wrapper/);
  assert.match(checkWorkflowDependencies('alignment.yml', good + '  "hidden":\n    runs-on: ubuntu-latest\n').join('\n'), /unsupported/);
  const leaf = 'on:\n  workflow_call:\njobs:\n  checks:\n    steps:\n      - run: node tools/run-gate.mjs guards -- node tools/guard-corpus.mjs\n';
  assert.deepEqual(checkWorkflowDependencies('corpus.yml', leaf), []);
  assert.match(checkWorkflowDependencies('corpus.yml', leaf.replace('workflow_call:', 'push:')).join('\n'), /workflow_call/);
});

test('the coordinator watches both parity pushes and daily external changes', () => {
  const workflow = readFileSync(new URL('../.github/workflows/alignment.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^  push:\s*$/m);
  assert.match(workflow, /^  schedule:\s*\n    - cron: "\d+ \d+ \* \* \*"/m);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /contents: write|pull_request_target/);
});

// The publish exemption is the one permissive default in the coordinator
// contract, so its NARROWNESS is asserted rather than left to the comment that
// explains it. Every entry in gates-pointed-at-nothing.md that began as an
// exemption began as an unchecked one.
test('the coordinator exemption covers publish only, and does not excuse it from verdicts', () => {
  const ownsTrigger = 'name: X\non:\n  push:\n    tags:\n      - "v*"\n\njobs:\n  publish:\n    runs-on: ubuntu-latest\n';

  // publish.yml may own its trigger: a release must come from a tag and from
  // nothing else, which the coordinator cannot express.
  assert.deepEqual(checkWorkflowDependencies('.github/workflows/publish.yml', ownsTrigger), []);

  // Any OTHER workflow owning a trigger still fails. If this ever passes, the
  // exemption has stopped being narrow and the arrangement is unenforced.
  assert.match(
    checkWorkflowDependencies('.github/workflows/corpus.yml', ownsTrigger).join('\n'),
    /only workflow_call is allowed/,
  );

  // And the exemption buys publish.yml nothing on evidence: a gate it runs
  // without the wrapper is still a failure.
  assert.match(
    checkWorkflowDependencies(
      '.github/workflows/publish.yml',
      ownsTrigger + '    steps:\n      - run: node tools/guard-corpus.mjs\n',
    ).join('\n'),
    /gate invocation lacks verdict wrapper/,
  );

  // The wrapped form is accepted, so the rule is satisfiable rather than
  // merely strict.
  assert.deepEqual(
    checkWorkflowDependencies(
      '.github/workflows/publish.yml',
      ownsTrigger + '    steps:\n      - run: node tools/run-gate.mjs guards -- node tools/guard-corpus.mjs\n',
    ),
    [],
  );
});

// --- the all-skip rule, and what it must keep catching --------------------
//
// This rule landed red in 6a691d9 against a corpus state that had existed
// since September, and was invisible for three days because the coordinator's
// first job failed before the job carrying it ever ran. Relaxing it is only
// safe if the cases it was right about still fail.

const allSkipped = () => new Map(['php', 'ts', 'py'].map((language) => [language, [
  { suite: 'working', results: [{ id: 'ok', status: 'pass' }] },
  { suite: 'declared', results: [{ id: 'never', status: 'skip', reason: 'No runner.' }] },
]]));

test('an all-skip suite verified by a PACKAGE-SPECIFIC runner is not vacuous', () => {
  // cache-stability-hints: executed by prism:tests/CacheStabilityCorpusTest.php
  // while both ports carry G-64. Skip-with-reason exists so a language can
  // decline a row; all three declining is expressible, not broken.
  const manifests = new Map([['declared', {
    implementations: {
      php: { status: 'full', runner: 'prism:tests/CacheStabilityCorpusTest.php' },
      ts: { status: 'partial', cause: 'no-runner', gap: 'G-64' },
      py: { status: 'partial', cause: 'no-runner', gap: 'G-64' },
    },
  }]]);
  const reports = allSkipped();
  assert.deepEqual(verifyCoverage(reports, coverage(reports), manifests), []);
});

test('THE FLOOR: an all-skip suite nothing verifies anywhere still fails', () => {
  const manifests = new Map([['declared', {
    implementations: {
      php: { status: 'partial', cause: 'no-runner', gap: 'G-64' },
      ts: { status: 'partial', cause: 'no-runner', gap: 'G-64' },
      py: { status: 'partial', cause: 'no-runner', gap: 'G-64' },
    },
  }]]);
  const reports = allSkipped();
  assert.match(verifyCoverage(reports, coverage(reports), manifests).join('\n'), /declared.*every language/);
});

test('a suite claiming full against the GENERIC runner and skipping every row fails', () => {
  // The case the rule was written for: a runner reporting agreement it never
  // measured. prism-parity's own runner is the generic one, so declaring it
  // cannot excuse skipping every row.
  const manifests = new Map([['declared', {
    implementations: {
      php: { status: 'full', runner: 'prism-parity:runners/php/runner.php' },
      ts: { status: 'full', runner: 'prism-parity:runners/php/runner.php' },
      py: { status: 'full', runner: 'prism-parity:runners/php/runner.php' },
    },
  }]]);
  const reports = allSkipped();
  assert.match(verifyCoverage(reports, coverage(reports), manifests).join('\n'), /declared.*every language/);
});

test('with no manifests supplied the all-skip rule stays strict', () => {
  const reports = allSkipped();
  assert.match(verifyCoverage(reports, coverage(reports)).join('\n'), /declared.*every language/);
});

test('a PARTIAL implementation with a package-specific runner does not excuse an all-skip suite', () => {
  // A runner that exists is not a declaration that the suite is verified. Only
  // `full` says that, and without this the status check is dead weight: the
  // floor test above passes on the absent `runner` alone.
  const manifests = new Map([['declared', {
    implementations: {
      php: { status: 'partial', cause: 'reference-limit', gap: 'G-64', runner: 'prism:tests/PartialTest.php' },
      ts: { status: 'partial', cause: 'no-runner', gap: 'G-64' },
      py: { status: 'partial', cause: 'no-runner', gap: 'G-64' },
    },
  }]]);
  const reports = allSkipped();
  assert.match(verifyCoverage(reports, coverage(reports), manifests).join('\n'), /declared.*every language/);
});
