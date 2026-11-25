#!/usr/bin/env node
// G-285 harness-run-cancel: run every row through the PHP, TypeScript and
// Python harness runtimes and check each language against the safety contract.
//
//   node tools/run-cancel-corpus.mjs                 # published artifacts, compare to recorded goldens
//   node tools/run-cancel-corpus.mjs --record        # published artifacts, write goldens
//   node tools/run-cancel-corpus.mjs --development   # candidate source, NEVER writes
//
// --development reads candidate runtimes from:
//   PRISM_HARNESS_PHP_RUNNER  a prism-harness checkout with vendor/bin/phpunit
//   PRISM_HARNESS_AUTOLOAD    that checkout's vendor/autoload.php
//   PRISM_HARNESS_TS          a built prism-harness-ts checkout (dist/index.js)
//   PRISM_HARNESS_PY          a prism-harness-py source directory (the one holding prism_harness/)
//
// Until tools/run-cancel-contract.mjs names a published release for every
// language, only --development can run: no golden is recorded from candidate source.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Corpus } from '../loaders/ts/src/index.js';
import { verifyRunCancelReport, verifyRunCancelMatrix, runCancelDocumentFailures, PUBLISHED, LANGUAGES } from './run-cancel-contract.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const record = process.argv.includes('--record'), development = process.argv.includes('--development');
if (process.argv.slice(2).some((arg) => !['--record', '--development'].includes(arg)) || (record && development)) {
  throw Error('Use --record only with published artifacts; --development cannot record goldens.');
}
const unpublished = LANGUAGES.filter((language) => !PUBLISHED[language]);
if (!development && unpublished.length > 0) {
  throw Error(`No published harness release carries G-285 for ${unpublished.join(', ')}; run --development, which never records goldens.`);
}
const path = join(root, 'suites/harness-run-cancel/cases.json');
const document = JSON.parse(readFileSync(path, 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'suites/harness-run-cancel/manifest.json'), 'utf8'));
const cases = Corpus.open(root).suite('harness-run-cancel').cases('ts');
verifyRunCancelMatrix(cases);
assert(cases.every((row) => !row.skipped), 'Run-cancel acceptance has no skipped languages');
const work = mkdtempSync(join(tmpdir(), 'prism-run-cancel-corpus-'));
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_ALL)$/i.test(key)) env[key] = value;
}
const candidates = ['PRISM_HARNESS_TS', 'PRISM_HARNESS_AUTOLOAD', 'PRISM_HARNESS_PY'];
for (const key of candidates) {
  if (process.env[key] && !development) throw Error(`${key} points at candidate source; it is honoured only with --development.`);
  if (process.env[key]) env[key] = process.env[key];
}
env.APP_ENV = 'testing'; env.DB_CONNECTION = 'sqlite'; env.DB_DATABASE = ':memory:';
env.CACHE_STORE = 'array'; env.QUEUE_CONNECTION = 'sync'; env.PYTHONIOENCODING = 'utf-8';
env.PRISM_RUN_CANCEL_OUTPUT = join(work, 'php.jsonl');
const php = process.env.PRISM_PHP_BINARY ?? 'php';
const python = process.env.PRISM_PYTHON_BINARY ?? 'python';
const phpRoot = process.env.PRISM_HARNESS_PHP_RUNNER ?? join(root, 'runners/php');
function run(binary, args) {
  const result = spawnSync(binary, args, { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw Error(`Run-cancel runner failed (${result.status}): ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
const canonical = (result) => JSON.stringify(result);
const only = (process.env.PRISM_RUN_CANCEL_LANGUAGES ?? 'php,ts,py').split(',');
if (!development) assert.deepEqual(only, LANGUAGES, 'Published runs execute every language');
try {
  const reports = {};
  if (only.includes('php')) {
    run(php, [join(phpRoot, 'vendor/bin/phpunit'), '-c', join(root, 'tools/harness-run-cancel/phpunit.xml')]);
    reports.php = { results: readFileSync(env.PRISM_RUN_CANCEL_OUTPUT, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line)) };
  }
  if (only.includes('ts')) reports.ts = JSON.parse(run(process.execPath, ['tools/harness-run-cancel/runner.mjs']));
  if (only.includes('py')) reports.py = JSON.parse(run(python, ['tools/harness-run-cancel/runner.py']));
  const failures = [];
  for (const [language, report] of Object.entries(reports)) {
    try {
      verifyRunCancelReport(language, report, cases, development);
      if (language !== 'php') assert.equal(report.corpus_version, Corpus.open(root).version);
    } catch (error) {
      failures.push(error.message);
    }
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
  // Development evidence: printed, never written.
  let agree = 0;
  for (const [index, row] of cases.entries()) {
    const values = Object.values(reports).map((report) => canonical(report.results[index]?.result));
    const same = values.every((value) => value === values[0]);
    if (same) agree++;
    if (development) {
      console.log(`${row.id} ${same ? 'agree' : 'DISAGREE'}`);
      if (!same) for (const [language, report] of Object.entries(reports)) console.log(`  ${language}: ${canonical(report.results[index]?.result)}`);
    }
  }
  if (development) {
    for (const [language, report] of Object.entries(reports)) console.log(`native ${language}: ${JSON.stringify(report.results.map((row) => row.native))}`);
  }
  if (failures.length) throw Error(`Run-cancel safety contract failed:\n  ${failures.join('\n  ')}`);
  if (record) {
    for (const row of document.cases) row.agrees = row.result.php === row.result.ts && row.result.php === row.result.py;
    const problems = runCancelDocumentFailures(document, manifest);
    if (problems.length) throw Error(`Recorded document is inconsistent with its manifest:\n  ${problems.join('\n  ')}`);
    writeFileSync(path, JSON.stringify(document, null, 2) + '\n');
  } else if (!development) {
    for (const row of document.cases) assert.equal(row.agrees, true, `${row.id}: disagreement must remain visible`);
  }
  console.log(`Run-cancel corpus passed: ${cases.length} cases executed in ${Object.keys(reports).length} language(s) (${Object.keys(reports).join(', ')}); ${agree}/${cases.length} agree; 0 skipped; ${development ? 'development only, no goldens recorded' : 'published artifacts'}.`);
} finally {
  if (dirname(resolve(work)) !== resolve(tmpdir()) || !basename(work).startsWith('prism-run-cancel-corpus-')) throw Error('Refusing unexpected cleanup path');
  rmSync(work, { recursive: true, force: true });
}
