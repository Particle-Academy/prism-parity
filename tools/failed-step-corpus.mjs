#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Corpus } from '../loaders/ts/src/index.js';
import { verifyFailedStepReport, verifyFailedStepMatrix } from './failed-step-contract.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const record = process.argv.includes('--record'), development = process.argv.includes('--development');
if (process.argv.slice(2).some(arg => !['--record', '--development'].includes(arg)) || (record && development)) {
  throw Error('Use --record only with published artifacts; --development cannot record goldens.');
}
const path = join(root, 'suites/harness-failed-step/cases.json');
const document = JSON.parse(readFileSync(path, 'utf8'));
const cases = Corpus.open(root).suite('harness-failed-step').cases('ts');
verifyFailedStepMatrix(cases);
assert(cases.every(row => !row.skipped), 'Failed-step acceptance has no skipped languages');
const work = mkdtempSync(join(tmpdir(), 'prism-failed-corpus-'));
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_ALL)$/i.test(key)) env[key] = value;
}
for (const key of ['PRISM_HARNESS_TS', 'PRISM_HARNESS_AUTOLOAD']) if (process.env[key]) env[key] = process.env[key];
env.APP_ENV = 'testing'; env.DB_CONNECTION = 'sqlite'; env.DB_DATABASE = ':memory:';
env.CACHE_STORE = 'array'; env.QUEUE_CONNECTION = 'sync'; env.PRISM_FAILED_STEP_OUTPUT = join(work, 'php.jsonl');
const php = process.env.PRISM_PHP_BINARY ?? 'php';
const python = process.env.PRISM_PYTHON_BINARY ?? 'python';
const phpRoot = process.env.PRISM_HARNESS_PHP_RUNNER ?? join(root, 'runners/php');
function run(binary, args) {
  const result = spawnSync(binary, args, { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw Error(`Failed-step runner failed (${result.status}): ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
function canonical(result) { return JSON.stringify(result); }
try {
  run(php, [join(phpRoot, 'vendor/bin/phpunit'), '-c', join(root, 'tools/harness-failed-step/phpunit.xml')]);
  const phpResults = readFileSync(env.PRISM_FAILED_STEP_OUTPUT, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const reports = { php: { results: phpResults }, ts: JSON.parse(run(process.execPath, ['tools/harness-failed-step/runner.mjs'])),
    py: JSON.parse(run(python, ['tools/harness-failed-step/runner.py'])) };
  for (const [language, report] of Object.entries(reports)) {
    verifyFailedStepReport(language, report, cases, development);
    if (language !== 'php') assert.equal(report.corpus_version, Corpus.open(root).version);
    for (const [index, row] of report.results.entries()) {
      if (record) {
        document.cases[index].result[language] = canonical(row.result);
        document.cases[index].native[language] = row.native;
      } else if (!development) {
        assert.equal(canonical(row.result), document.cases[index].result[language], `${language}/${row.id}: recorded result drift`);
        assert.deepEqual(row.native, document.cases[index].native[language], `${language}/${row.id}: native evidence drift`);
      }
    }
  }
  for (const row of document.cases) {
    if (record) row.agrees = row.result.php === row.result.ts && row.result.php === row.result.py;
    if (!development) assert.equal(row.agrees, true, `${row.id}: disagreement must remain visible`);
  }
  if (record) writeFileSync(path, JSON.stringify(document, null, 2) + '\n');
  console.log(`Failed-step corpus passed: ${cases.length} cases executed in all 3 languages; 0 skipped; ${development ? 'development only, no goldens recorded' : 'published artifacts'}.`);
} finally {
  if (dirname(resolve(work)) !== resolve(tmpdir()) || !basename(work).startsWith('prism-failed-corpus-')) throw Error('Refusing unexpected cleanup path');
  rmSync(work, { recursive: true, force: true });
}
