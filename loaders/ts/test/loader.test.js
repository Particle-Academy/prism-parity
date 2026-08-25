import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Corpus, CorpusError, compare, discoverRoot, LANGUAGES } from '../src/index.js';

// Every assertion below runs against the SHIPPED corpus, or against a copy of
// it that has been deliberately corrupted. None of them run against
// hand-written example rows.
//
// That rule has teeth. A loader can assert something the reference language
// cannot express, and no amount of green ticks will surface it — elsewhere, a
// loader unit test built on hand-written pairs enforced an integer/float
// distinction that the reference language (which has one number type) could
// never encode, and it broke a real case while its own test passed. Our
// equivalent hazard is live: PHP is our reference and has ONE absent value,
// while JavaScript has null AND undefined. A guard invented here could easily
// demand a distinction no PHP-authored golden can state.

function corruptedCorpus(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'prism-parity-'));
  cpSync(discoverRoot(), dir, { recursive: true, filter: (src) => !src.includes('node_modules') });

  const casesPath = join(dir, 'suites', 'openai-text-request', 'cases.json');
  const document = JSON.parse(readFileSync(casesPath, 'utf8'));
  mutate(document);
  writeFileSync(casesPath, JSON.stringify(document, null, 4));

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A byte-for-byte copy, with nothing re-serialized. corruptedCorpus() rewrites
// cases.json through JSON.stringify even when the mutation is a no-op, and that
// rewrite changes the bytes — which the digest correctly notices.
function plainCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'prism-parity-copy-'));
  cpSync(discoverRoot(), dir, { recursive: true, filter: (src) => !src.includes('node_modules') });

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function expectLoadError(code, mutate) {
  const { dir, cleanup } = corruptedCorpus(mutate);

  try {
    assert.throws(
      () => Corpus.open(dir).suite('openai-text-request'),
      (error) => error instanceof CorpusError && error.code === code,
      `expected load to fail with code ${code}`,
    );
  } finally {
    cleanup();
  }
}

test('the shipped corpus loads and every suite passes its own guards', () => {
  const corpus = Corpus.open();

  assert.match(corpus.version, /^\d+\.\d+\.\d+$/);
  assert.ok(corpus.suiteIds().length > 0);

  for (const id of corpus.suiteIds()) {
    const suite = corpus.suite(id);
    assert.equal(suite.manifest.id, id);
    assert.ok(suite.cases('ts').length > 0);
  }
});

test('a duplicate case id is a load error', () => {
  expectLoadError('duplicate_case_id', (document) => {
    document.cases.push({ ...document.cases[0] });
  });
});

test('case ids must ascend, so a new case goes at the end', () => {
  expectLoadError('unsorted_case_ids', (document) => {
    [document.cases[0], document.cases[1]] = [document.cases[1], document.cases[0]];
  });
});

test('a case without notes is a load error', () => {
  expectLoadError('missing_case_notes', (document) => {
    document.cases[0].notes = '   ';
  });
});

test('a case that does not say which version it arrived in is a load error', () => {
  expectLoadError('missing_case_since', (document) => {
    delete document.cases[0].since;
  });
});

// The skip guard, pinned from BOTH directions. The failure it prevents is one
// where a loader reads the skip as truthy: that skips the row in every language
// at once AND makes the blank-reason guard unreachable, because a non-empty
// object is never blank. Both effects are silent.
test('a scalar skip is a load error', () => {
  expectLoadError('skip_must_be_a_map', (document) => {
    document.cases[0].skip = true;
  });
});

test('an array skip is a load error', () => {
  expectLoadError('skip_must_be_a_map', (document) => {
    document.cases[0].skip = ['php'];
  });
});

test('a blank skip reason is a load error', () => {
  expectLoadError('blank_skip_reason', (document) => {
    document.cases[0].skip = { php: '' };
  });
});

test('a skip for an unknown language is a load error', () => {
  expectLoadError('unknown_skip_language', (document) => {
    document.cases[0].skip = { rust: 'no rust port exists yet' };
  });
});

test('a skip applies to its own language only', () => {
  const corpus = Corpus.open();
  const suite = corpus.suite('openai-text-request');

  // trq-0025 is skipped for Python and nothing else. If a loader read the skip
  // map as a truthy scalar, this row would report skipped everywhere.
  const inPython = suite.cases('py').find((testCase) => testCase.id === 'trq-0025');
  const inTypeScript = suite.cases('ts').find((testCase) => testCase.id === 'trq-0025');
  const inPhp = suite.cases('php').find((testCase) => testCase.id === 'trq-0025');

  assert.equal(inPython.skipped, true);
  assert.ok(inPython.skipReason.length > 0);
  assert.equal(inTypeScript.skipped, false);
  assert.equal(inTypeScript.skipReason, null);
  assert.equal(inPhp.skipped, false);
});

test('skipped rows are returned rather than filtered away', () => {
  const suite = Corpus.open().suite('openai-text-request');

  assert.equal(suite.cases('py').length, suite.cases('ts').length);
  assert.ok(suite.skippedIds('py').includes('trq-0025'));
  assert.ok(!suite.skippedIds('ts').includes('trq-0025'));
});

test('an unknown language is rejected', () => {
  assert.throws(
    () => Corpus.open().suite('openai-text-request').cases('rust'),
    (error) => error instanceof CorpusError && error.code === 'unknown_language',
  );
});

test('a root with no VERSION file reports corpus_not_installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prism-parity-empty-'));

  try {
    assert.throws(
      () => Corpus.open(dir),
      (error) => error instanceof CorpusError && error.code === 'corpus_not_installed',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The comparator, exercised against every golden the corpus actually ships
// rather than against invented pairs — so it can never enforce a distinction the
// reference language could not have encoded.
test('the comparator accepts each shipped golden and rejects any byte change', () => {
  const corpus = Corpus.open();
  let checked = 0;

  for (const suiteId of corpus.suiteIds()) {
    const suite = corpus.suite(suiteId);

    for (const testCase of suite.cases('ts')) {
      const golden = Object.values(testCase.expect).find((value) => typeof value === 'string');
      if (golden === undefined) continue;

      assert.equal(compare(golden, golden, testCase.tolerance), true, `${testCase.id} should match itself`);
      assert.equal(compare(golden, `${golden} `, testCase.tolerance), false, `${testCase.id} should reject a byte change`);
      checked += 1;
    }
  }

  assert.ok(checked >= 40, `expected the corpus to carry goldens, checked ${checked}`);
});

test('no shipped case declares a tolerance, so every comparison is exact', () => {
  const corpus = Corpus.open();

  for (const suiteId of corpus.suiteIds()) {
    for (const testCase of corpus.suite(suiteId).cases('ts')) {
      assert.equal(
        testCase.tolerance,
        undefined,
        `${testCase.id} declares a tolerance; if that is deliberate, TEST the justification before relying on it`,
      );
    }
  }
});

test('every language the corpus knows about is one a loader can be asked for', () => {
  const corpus = Corpus.open();

  for (const language of LANGUAGES) {
    assert.ok(Array.isArray(corpus.suite('openai-text-request').cases(language)));
  }
});

test('probe expectations subtract the cases a language skips', () => {
  const corpus = Corpus.open();

  const forPython = corpus.expectedProbeFailures('omit-null-keys', 'py');
  const forTypeScript = corpus.expectedProbeFailures('omit-null-keys', 'ts');

  // trq-0025 is in the probe's declared set and is skipped for Python, so it
  // cannot be among Python's expected failures — a skipped row cannot fail.
  assert.ok(forTypeScript['openai-text-request'].includes('trq-0025'));
  assert.ok(!forPython['openai-text-request'].includes('trq-0025'));
});

// The digest exists because a VERSION number cannot tell you whether two
// runners are reading the same bytes. It is compared across languages by
// scripts/cross-check.mjs, so it is pinned here from three directions: stable,
// sensitive to a single byte, and refusing to hash nothing.
test('the digest of the shipped corpus is stable and well formed', () => {
  const corpus = Corpus.open();

  assert.match(corpus.digest(), /^sha256:[0-9a-f]{64}$/);
  assert.equal(corpus.digest(), corpus.digest());
  assert.equal(Corpus.open().digest(), corpus.digest());
});

test('changing one byte of one case file changes the digest', () => {
  const before = Corpus.open().digest();
  const { dir, cleanup } = corruptedCorpus((document) => {
    document.cases[0].title += '.';
  });

  try {
    const after = Corpus.open(dir).digest();

    // Judged with plain string equality, never with the loader's own compare —
    // using a comparator to judge its own inputs is circular.
    assert.notEqual(after, before);
    assert.match(after, /^sha256:[0-9a-f]{64}$/);
  } finally {
    cleanup();
  }
});

test('a byte-for-byte copy of the corpus digests identically', () => {
  const { dir, cleanup } = plainCopy();

  try {
    assert.equal(Corpus.open(dir).digest(), Corpus.open().digest());
  } finally {
    cleanup();
  }
});

test('digesting an empty corpus fails rather than hashing nothing', () => {
  const { dir, cleanup } = plainCopy();

  try {
    // Opened while the fixtures are still present, then emptied: the digest is
    // lazy, so this exercises the vacuity guard rather than the open guard.
    const corpus = Corpus.open(dir);

    rmSync(join(dir, 'suites'), { recursive: true, force: true });
    rmSync(join(dir, 'probes'), { recursive: true, force: true });
    rmSync(join(dir, 'VERSION'), { force: true });

    assert.equal(existsSync(join(dir, 'suites')), false);
    assert.throws(
      () => corpus.digest(),
      (error) => error instanceof CorpusError && error.code === 'corpus_not_installed',
    );
  } finally {
    cleanup();
  }
});

test('every probe names only suites and cases that exist', () => {
  const corpus = Corpus.open();
  const { probes } = corpus.probes();

  assert.ok(probes.some((probe) => probe.kind === 'control'), 'the corpus must ship a control probe');

  for (const probe of probes) {
    for (const [suiteId, ids] of Object.entries(probe.must_fail ?? {})) {
      const known = new Set(corpus.suite(suiteId).cases('ts').map((testCase) => testCase.id));

      for (const id of ids) {
        assert.ok(known.has(id), `probe ${probe.id} names ${id}, which is not in ${suiteId}`);
      }
    }
  }
});
