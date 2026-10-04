import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compareClaims, checkRunner, requireVerdict, verifyCoverage, unmarkedCounts, checkWorkflowDependencies } from './alignment-contracts.mjs';
import { coverage } from '../scripts/cross-check-coverage.mjs';

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
