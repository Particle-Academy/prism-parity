#!/usr/bin/env node
// Run every runner and require IDENTICAL VERDICTS.
//
// Three suites that each went green on their own are three claims. This is the
// comparison. A port can be green against a corpus it never actually loaded, or
// against a stale copy of one, and its own CI cannot tell — only running the
// runners side by side and diffing their reports can.
//
//   node scripts/cross-check.mjs [--parity-root <dir>]
//
// Runners are located from parity/ledger.json. A runner declared there and
// missing on disk is a FAILURE, not a skip: "we cross-check three languages" has
// to be a job result rather than a sentence.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { execSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ledger = JSON.parse(readFileSync(join(root, 'parity', 'ledger.json'), 'utf8'));
const failures = [];

// On Windows a `php` installed via a shim (Herd, for instance) cannot be spawned
// from Node — the shim is a batch wrapper, not an executable. Resolve a real
// binary, and let PHP_BINARY override when discovery fails.
function phpBinary() {
  if (process.env.PHP_BINARY) return process.env.PHP_BINARY;

  try {
    const probe = execSync('php -r "echo PHP_BINARY;"', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (probe.trim()) return probe.trim();
  } catch {
    /* fall through */
  }

  return 'php';
}

const interpreters = {
  php: () => [phpBinary()],
  ts: () => ['node'],
  py: () => [process.env.PYTHON_BINARY ?? 'python'],
};

const reports = new Map();

for (const entry of ledger.cross_checked) {
  const runner = resolve(root, entry.runner);

  // Declared but absent is a failure. A cross-check that quietly drops a runner
  // reports agreement between however many happened to be present.
  if (!existsSync(runner)) {
    failures.push(
      `${entry.language}: parity/ledger.json declares a runner at ${entry.runner} and it is not there. ` +
        'Check it out, or remove it from cross_checked and say why in the ledger.',
    );
    continue;
  }

  const [interpreter, ...prefix] = interpreters[entry.language]();
  const result = spawnSync(interpreter, [...prefix, runner], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    cwd: dirname(runner),
  });

  if (result.error) {
    failures.push(`${entry.language}: could not spawn ${interpreter} — ${result.error.message}`);
    continue;
  }

  if (result.status === 3) {
    failures.push(`${entry.language}: runner could not start.\n${result.stderr}`);
    continue;
  }

  let documents;

  try {
    documents = JSON.parse(result.stdout);
  } catch {
    failures.push(`${entry.language}: runner did not print JSON on stdout.\n${result.stdout.slice(0, 400)}`);
    continue;
  }

  if (documents.error_code) {
    failures.push(`${entry.language}: corpus failed to load — ${documents.error_code}`);
    continue;
  }

  reports.set(entry.language, Array.isArray(documents) ? documents : [documents]);
}

// The digest a language's runner SHOULD report: its own loader tree, hashed the
// way every loader hashes it -- sorted forward-slash paths, then path, newline,
// raw bytes, newline. Kept in step with loaders/*/src by the cross-language
// suites themselves; if this drifts, every runner looks stale at once, which is
// a loud failure rather than a quiet one.
const LOADER_ROOTS = {
  php: 'loaders/php',
  ts: 'loaders/ts',
  py: 'loaders/py/src/prism_conformance',
};

function walkForDigest(base, directory) {
  const start = join(base, directory);

  if (!existsSync(start)) return [];

  const found = [];
  const stack = [directory];

  while (stack.length > 0) {
    const relative = stack.pop();

    for (const entry of readdirSync(join(base, relative))) {
      const next = `${relative}/${entry}`;

      if (statSync(join(base, next)).isDirectory()) stack.push(next);
      else found.push(next);
    }
  }

  return found;
}

function loaderDigest(language) {
  const base = join(root, LOADER_ROOTS[language] ?? '');

  if (!LOADER_ROOTS[language] || !existsSync(base)) return null;

  const paths = [];

  if (existsSync(join(base, 'VERSION'))) paths.push('VERSION');

  for (const directory of ['suites', 'probes']) paths.push(...walkForDigest(base, directory));

  if (paths.length === 0) return null;

  paths.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));

  const hash = createHash('sha256');

  for (const path of paths) {
    hash.update(Buffer.from(path, 'utf8'));
    hash.update(Buffer.from([0x0a]));
    hash.update(readFileSync(join(base, ...path.split('/'))));
    hash.update(Buffer.from([0x0a]));
  }

  return `sha256:${hash.digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Same corpus?
//
// The digest catches what the version cannot: a stale INSTALLED copy whose
// content moved while the version number did not. That is not hypothetical —
// this repository's own PHP runner reported four suites while the corpus had
// five, because composer had mirrored the loader package before the fifth suite
// existed, and every visible signal said green.
// ---------------------------------------------------------------------------
const digests = new Map([...reports].map(([language, docs]) => [language, docs[0]?.corpus_digest]));
const versions = new Map([...reports].map(([language, docs]) => [language, docs[0]?.corpus_version]));

if (new Set(digests.values()).size > 1) {
  // Naming the disagreement is not enough, and this is the second time it was
  // not: the failure above says three hashes differ and nothing about which one
  // is right or how to fix it, so it reads as a mystery and gets stepped around.
  // It stayed red for exactly that reason while two of three runners were
  // asserting against a corpus missing an entire suite.
  //
  // So: hash each language's OWN loader tree here, and tell the reader which
  // runners are not reading theirs. A runner whose reported digest matches its
  // loader tree is fine; one that does not is running an INSTALLED COPY, and
  // that is a refresh, not a debugging session.
  const stale = [];

  for (const [language, reported] of digests) {
    const expected = loaderDigest(language);

    if (expected !== null && reported !== expected) {
      stale.push({ language, reported, expected });
    }
  }

  let message =
    'runners disagree about WHICH CORPUS they ran:\n' +
    [...digests].map(([language, digest]) => `      ${language}: ${digest ?? 'not reported'}`).join('\n');

  if (stale.length > 0) {
    message +=
      '\n\n      These runners are NOT reading their own loader tree — they ran an installed copy:\n' +
      stale.map(({ language }) => `        ${language}`).join('\n') +
      '\n\n      Refresh it:\n' +
      '        php  rm -rf runners/php/vendor/particle-academy/prism-conformance && (cd runners/php && composer install)\n' +
      '             the path repository sets "symlink": false, so composer COPIES the loader\n' +
      '             and the copy goes stale on every corpus change\n' +
      '        py   python -m pip install -e loaders/py\n' +
      '             an editable install resolves to the tree and cannot go stale\n' +
      '        all  node tools/sync-corpus.mjs   first, if a suite is missing from the loaders entirely';
  }

  failures.push(message);
}

if (new Set(versions.values()).size > 1) {
  failures.push(
    'runners disagree about the corpus VERSION:\n' +
      [...versions].map(([language, version]) => `      ${language}: ${version ?? 'not reported'}`).join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Same verdicts?
//
// Verdicts are compared with plain string equality, never with the loader's own
// `compare` — using a comparator to judge its own output is circular, and a
// broken one could pass its own table.
// ---------------------------------------------------------------------------
const verdicts = new Map();

for (const [language, documents] of reports) {
  const flat = new Map();

  for (const document of documents) {
    for (const result of document.results) flat.set(`${document.suite}/${result.id}`, result.status);
  }

  verdicts.set(language, flat);
}

const languages = [...verdicts.keys()];
const allKeys = new Set(languages.flatMap((language) => [...verdicts.get(language).keys()]));

for (const key of [...allKeys].sort()) {
  const row = languages.map((language) => [language, verdicts.get(language).get(key) ?? 'absent']);
  const statuses = new Set(row.map(([, status]) => status));

  // A skip in one language and a pass in another is EXPECTED and correct — a
  // skip is per-language by design. What must never differ is pass versus fail,
  // or a case being absent from one runner's report entirely.
  const meaningful = new Set([...statuses].filter((status) => status !== 'skip'));

  if (statuses.has('absent')) {
    failures.push(`${key}: missing from a runner's report — ${row.map(([l, s]) => `${l}=${s}`).join(' ')}`);
  } else if (meaningful.size > 1) {
    failures.push(`${key}: verdicts disagree — ${row.map(([l, s]) => `${l}=${s}`).join(' ')}`);
  } else if (meaningful.has('fail')) {
    failures.push(`${key}: FAILED in ${row.filter(([, s]) => s === 'fail').map(([l]) => l).join(', ')}`);
  }
}

// Vacuity guard: agreement across an empty set is not agreement.
if (allKeys.size === 0) failures.push('no cases were compared — the cross-check asserted nothing');
if (languages.length < 2) failures.push(`only ${languages.length} runner(s) reported; a cross-check needs at least two`);

if (failures.length > 0) {
  console.error(`\nCross-check failed:\n\n  ${failures.join('\n  ')}\n`);
  process.exit(1);
}

console.error(
  `Cross-check passed: ${languages.join(', ')} agree on ${allKeys.size} cases ` +
    `(corpus ${versions.get(languages[0])}, ${digests.get(languages[0])}).`,
);
