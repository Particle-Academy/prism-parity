import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cleanupCaseIds, requireCleanupEvidence, requireCleanupVector } from './cleanup-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = process.env.PRISM_COEXIST_WORK;
assert(work && fs.statSync(work).isDirectory(), 'Explicit fresh evidence directory required');
const vectors = JSON.parse(fs.readFileSync(join(root, 'docs/decisions/0022-local-file-lock-vectors.json'), 'utf8'));
assert.equal(vectors.cleanup.length, 1);
const vector = requireCleanupVector(vectors.cleanup[0]);
const digest = value => createHash('sha256').update(value).digest('hex');
const inputSha256 = digest(JSON.stringify(vector));
const locations = {
  ts: process.env.PRISM_CLEANUP_TS,
  py: process.env.PRISM_CLEANUP_PY,
};
const refs = JSON.parse(fs.readFileSync(join(root, 'tools/lock-owner-review/cleanup-refs.json'), 'utf8'));
assert.deepEqual(Object.keys(refs).sort(), ['py', 'ts']);
const python = process.env.PRISM_PYTHON_BINARY;
assert(python && locations.ts && locations.py, 'Explicit reviewed runtime paths required');
const reports = [];

function run(language, executable, args, cwd, extra = {}) {
  const log = join(work, language + '.log');
  const fd = fs.openSync(log, 'wx');
  const result = spawnSync(executable, args, {
    cwd, env: { ...process.env, ...extra }, stdio: ['ignore', fd, fd], windowsHide: true,
    shell: false, timeout: 120000,
  });
  fs.closeSync(fd);
  assert(!result.error && result.status === 0, 'Cleanup controls failed: ' + log);
}

for (const language of ['ts', 'py']) {
  const cwd = locations[language];
  assert.equal(refs[language].repository, 'Particle-Academy/prism-harness-' + language);
  assert.equal(refs[language].path, '.cleanup-runtimes/' + language);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(head.status, 0); assert.equal(head.stdout.trim(), refs[language].head, 'Wrong cleanup source head');
  const clean = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(clean.status, 0); assert.equal(clean.stdout.trim(), '', 'Dirty cleanup source');
  const testFile = language === 'ts' ? 'test/file-owner-cleanup-blocked.test.ts' : 'tests/test_file_owner_vectors.py';
  const fixtureFile = language === 'ts' ? 'test/fixtures/file-lock-cleanup-os-refusal.json' : 'tests/fixtures/file-lock-cleanup-os-refusal.json';
  const productionFile = language === 'ts' ? 'src/stores/file-owner-lock.ts' : 'src/prism_harness/stores/_file_owner_lock.py';
  const fixture = JSON.parse(fs.readFileSync(join(cwd, fixtureFile), 'utf8'));
  requireCleanupVector(fixture);
  assert.deepEqual(fixture, vector, 'Port fixture differs from canonical row');
  const before = Object.fromEntries([testFile, fixtureFile, productionFile].map(file => [file, digest(fs.readFileSync(join(cwd, file)))]));
  let results, nativeReport;
  if (language === 'ts') {
    nativeReport = join(work, 'ts-vitest.json');
    run('ts', process.execPath, [join(cwd, 'node_modules/vitest/vitest.mjs'), 'run', testFile, '--reporter=json', '--outputFile=' + nativeReport], cwd);
    const report = JSON.parse(fs.readFileSync(nativeReport, 'utf8'));
    assert.equal(report.numTotalTests, 5);
    assert.equal(report.numPassedTests, 5);
    assert.equal(report.numFailedTests, 0);
    assert.equal(report.numPendingTests, 0);
    results = report.testResults.flatMap(file => file.assertionResults).map(row => ({ name: row.title, status: row.status }));
  } else {
    const xml = join(work, 'py-junit.xml');
    run('py', python, ['-m', 'pytest', testFile, '-k', 'release_temporary', '-q', '--junitxml=' + xml], cwd, { PYTHONPATH: join(cwd, 'src') });
    nativeReport = join(work, 'py-cases.json');
    const code = 'import json,sys,xml.etree.ElementTree as E; rows=[{"name":x.attrib["name"],"status":"passed" if not any(x.find(n) is not None for n in ("failure","error","skipped")) else "not-passed"} for x in E.parse(sys.argv[1]).iter("testcase")]; print(json.dumps(rows))';
    const fd = fs.openSync(nativeReport, 'wx');
    const parsed = spawnSync(python, ['-I', '-S', '-c', code, xml], { stdio: ['ignore', fd, fd], windowsHide: true, timeout: 10000 });
    fs.closeSync(fd);
    assert(!parsed.error && parsed.status === 0, 'Cannot read native pytest cases');
    results = JSON.parse(fs.readFileSync(nativeReport, 'utf8'));
  }
  const codes = vector.os_errors[language];
  const names = language === 'ts' ? [
    ...codes.map(code => 'waits and re-inspects when temporary cleanup is blocked by ' + code),
    ...codes.map(code => 'refuses within the existing exhausted wait budget for ' + code),
    'propagates unrelated cleanup I/O errors without granting entry',
  ] : [
    ...codes.map(code => 'test_release_temporary_waits_for_windows_handle_before_reinspection[' + code + ']'),
    ...codes.map(code => 'test_release_temporary_refuses_at_existing_wait_budget_without_taking[' + code + ']'),
    'test_release_temporary_unrelated_io_error_remains_fatal',
  ];
  assert.equal(results.length, 5);
  assert.deepEqual(results.map(row => row.name).sort(), [...names].sort(), 'Missing, duplicated or unknown cleanup control');
  assert(results.every(row => row.status === 'passed'), 'Skipped or failed control');
  for (const [file, expected] of Object.entries(before)) assert.equal(digest(fs.readFileSync(join(cwd, file))), expected, 'Control mutated reviewed source');
  reports.push({
    language, sourceHead: head.stdout.trim(), fixtureSemanticSha256: digest(JSON.stringify(fixture)), sourceTestSha256: before[testFile],
    nativeReportSha256: digest(fs.readFileSync(nativeReport)), productionSha256: before[productionFile],
    tests: cleanupCaseIds(language).map((id, index) => ({ id, name: names[index], status: results.find(row => row.name === names[index]).status })),
  });
}
const report = { format: 'file-lock-cleanup-held-evidence-v1', row: vector.id, inputSha256, reports };
requireCleanupEvidence(report);
fs.writeFileSync(join(work, 'cleanup-evidence.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report));
