// The prism-parity conformance corpus and its JavaScript/TypeScript loader.
//
// Deliberately the same API shape as the PHP and Python loaders. Three loaders
// that drifted into three shapes would be three contracts, and the point of
// publishing a loader at all is that consumers stop writing their own — four of
// them elsewhere did, and two of those copies shared a silent bug.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const LANGUAGES = ['php', 'ts', 'py'];

const NEWLINE = Buffer.from([0x0a]);

/**
 * Every load-time guard throws this, and every guard has a CODE.
 *
 * The code is the contract; the sentence is not. The three loaders word these
 * differently on purpose — a test that pins the prose holds every
 * implementation to a translation and goes red on a wording improvement that
 * changed nothing.
 */
export class CorpusError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CorpusError';
    this.code = code;
  }
}

/**
 * The corpus has exactly one comparison mode: the canonical JSON string.
 *
 * There is deliberately no global float epsilon. A global tolerance is
 * invisible — nobody reading a fixture can tell whether it asserts a value or a
 * neighbourhood — and an invisible one lets two implementations that computed
 * DIFFERENT values pass as equal, in the package whose product is catching
 * exactly that. A row that genuinely needs slack declares `tolerance` on itself,
 * where a reader can see it. No row in the corpus needs one today.
 */
export function compare(expected, actual, tolerance) {
  if (tolerance === undefined) {
    return expected === actual;
  }

  return withinTolerance(safeParse(expected), safeParse(actual), tolerance);
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function withinTolerance(expected, actual, tolerance) {
  if (typeof expected === 'number' && typeof actual === 'number') {
    return Math.abs(expected - actual) <= tolerance;
  }

  if (Array.isArray(expected) && Array.isArray(actual)) {
    return (
      expected.length === actual.length &&
      expected.every((item, index) => withinTolerance(item, actual[index], tolerance))
    );
  }

  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    const a = Object.keys(expected);
    const b = Object.keys(actual);

    // Key ORDER is part of what the corpus pins, so it is compared even on the
    // tolerance path.
    return (
      a.length === b.length &&
      a.every((key, index) => key === b[index] && withinTolerance(expected[key], actual[key], tolerance))
    );
  }

  return expected === actual;
}

/**
 * Walk UP from `from` until a directory containing `suites/` is found.
 *
 * Never a fixed `../..` and never a sibling checkout: a hard-coded relative path
 * works in exactly one directory layout and silently no-ops in every other,
 * including CI, which checks out one repo. Because the fixtures ship inside this
 * package, the walk lands on the package root when installed and on the repo
 * root when developing here.
 */
export function discoverRoot(from = dirname(fileURLToPath(import.meta.url))) {
  let dir = from;

  for (;;) {
    if (existsSync(join(dir, 'suites'))) return dir;

    const parent = dirname(dir);
    if (parent === dir) {
      throw new CorpusError(
        'corpus_not_installed',
        'Walked to the filesystem root without finding a directory containing suites/.',
      );
    }

    dir = parent;
  }
}

export class Suite {
  constructor(id, manifest, cases) {
    this.id = id;
    this.manifest = manifest;
    this._cases = cases;
  }

  /**
   * Rows for one language, each annotated with whether it is skipped and why.
   *
   * Skipped rows are RETURNED rather than filtered out, so a runner reports them
   * and a skip stays visible instead of quietly shrinking the suite.
   */
  cases(language) {
    if (!LANGUAGES.includes(language)) {
      throw new CorpusError('unknown_language', `Unknown language ${language}.`);
    }

    return this._cases.map((testCase) => {
      const reason = testCase.skip?.[language];

      return { ...testCase, skipped: typeof reason === 'string', skipReason: reason ?? null };
    });
  }

  skippedIds(language) {
    return this.cases(language)
      .filter((testCase) => testCase.skipped)
      .map((testCase) => testCase.id);
  }
}

function guardCases(suiteId, cases) {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new CorpusError('empty_suite', `Suite ${suiteId} has no cases.`);
  }

  const seen = new Set();
  let previous = null;

  for (const testCase of cases) {
    const id = testCase?.id;

    if (typeof id !== 'string' || id === '') {
      throw new CorpusError('missing_case_id', `A case in ${suiteId} has no id.`);
    }

    if (seen.has(id)) {
      throw new CorpusError('duplicate_case_id', `Case id ${id} appears more than once in ${suiteId}.`);
    }

    seen.add(id);

    // Ids are unique AND sorted. That is what makes "a new case goes at the END
    // of the file" a rule a machine enforces rather than a habit: file order is
    // not chronology, and inserting between two existing rows would renumber ids
    // that other repos' skip lists point at.
    if (previous !== null && id <= previous) {
      throw new CorpusError(
        'unsorted_case_ids',
        `Case id ${id} follows ${previous} in ${suiteId}; ids must ascend. New cases go at the end.`,
      );
    }

    previous = id;

    if (typeof testCase.notes !== 'string' || testCase.notes.trim() === '') {
      throw new CorpusError(
        'missing_case_notes',
        `Case ${id} has no notes. A case without a stated purpose gets deleted by someone later.`,
      );
    }

    if (typeof testCase.since !== 'string' || testCase.since.trim() === '') {
      throw new CorpusError('missing_case_since', `Case ${id} does not say which corpus version it was added in.`);
    }

    guardSkip(id, testCase.skip);
  }
}

function guardSkip(caseId, skip) {
  if (skip === undefined || skip === null) return;

  // Pinned from BOTH directions. A loader that reads this as truthy skips the
  // row for every language at once AND makes the blank-reason guard below
  // unreachable, because a non-empty object is never blank. Both effects are
  // silent, and both builds stay green.
  if (typeof skip !== 'object' || Array.isArray(skip)) {
    throw new CorpusError(
      'skip_must_be_a_map',
      `Case ${caseId} has a non-map skip. A skip is keyed by language; a scalar skips every language at once.`,
    );
  }

  for (const [language, reason] of Object.entries(skip)) {
    if (!LANGUAGES.includes(language)) {
      throw new CorpusError('unknown_skip_language', `Case ${caseId} is skipped for unknown language ${language}.`);
    }

    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new CorpusError(
        'blank_skip_reason',
        `Case ${caseId} skips ${language} with no reason. A skip that does not say why becomes permanent silently.`,
      );
    }
  }
}

function walk(root, relative) {
  const full = join(root, ...relative.split('/'));

  if (!existsSync(full)) return [];
  if (statSync(full).isFile()) return [relative];

  return readdirSync(full).flatMap((entry) => walk(root, `${relative}/${entry}`));
}

export class Corpus {
  constructor(root, version) {
    this.root = root;
    this.version = version;
    this._suites = new Map();
    this._digest = null;
  }

  /**
   * The root is discovered by default and still an EXPLICIT parameter, so the
   * guards are exercised through this same code against a temporary root rather
   * than re-implemented inside a test — which would assert nothing at all.
   */
  static open(root) {
    const resolved = root ?? discoverRoot();
    const versionFile = join(resolved, 'VERSION');

    if (!existsSync(versionFile)) {
      throw new CorpusError(
        'corpus_not_installed',
        `No VERSION file at ${resolved}. The corpus ships inside this package; if it is missing, the package was assembled without running the sync step.`,
      );
    }

    return new Corpus(resolved, readFileSync(versionFile, 'utf8').trim());
  }

  suiteIds() {
    const base = join(this.root, 'suites');

    return readdirSync(base)
      .filter((entry) => statSync(join(base, entry)).isDirectory() && existsSync(join(base, entry, 'cases.json')))
      .sort();
  }

  suite(id) {
    if (this._suites.has(id)) return this._suites.get(id);

    const dir = join(this.root, 'suites', id);

    for (const file of ['manifest.json', 'cases.json']) {
      if (!existsSync(join(dir, file))) {
        throw new CorpusError('corpus_not_installed', `${file} is missing for suite ${id}.`);
      }
    }

    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const document = JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8'));

    if (document.suite !== id) {
      throw new CorpusError('suite_id_mismatch', `cases.json for ${id} declares suite ${document.suite}.`);
    }

    guardCases(id, document.cases);

    const suite = new Suite(id, manifest, document.cases);
    this._suites.set(id, suite);

    return suite;
  }

  /**
   * A content hash of every fixture this corpus ships.
   *
   * The VERSION number answers "which release is this?". It does not answer "are
   * we all running the same bytes?", and those come apart: an installed copy
   * mirrored before a suite was added reported one suite fewer and looked
   * perfectly green, with the version unchanged because the CONTENT moved
   * without the number moving. The digest is what cross-check.mjs compares so a
   * stale artifact is a failure rather than a smaller pass.
   *
   * Files are read as RAW BYTES. Line endings are deliberately not normalised:
   * if a checkout mangles them the digest SHOULD differ, because the files
   * really are different.
   */
  digest() {
    if (this._digest !== null) return this._digest;

    const paths = [];
    const versionFile = join(this.root, 'VERSION');

    if (existsSync(versionFile) && statSync(versionFile).isFile()) paths.push('VERSION');

    for (const directory of ['suites', 'probes']) {
      paths.push(...walk(this.root, directory));
    }

    // Vacuity guard. A discovery check that silently succeeds over an empty set
    // is worse than no check: it reports agreement it never looked for.
    if (paths.length === 0) {
      throw new CorpusError(
        'corpus_not_installed',
        `Found no fixture files under ${this.root}, so there is nothing to digest.`,
      );
    }

    // Byte-wise ascending, with forward slashes on every platform. A digest that
    // differs by path separator between a Windows checkout and a Linux CI runner
    // is worse than no digest.
    paths.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));

    const hash = createHash('sha256');

    for (const path of paths) {
      hash.update(Buffer.from(path, 'utf8'));
      hash.update(NEWLINE);
      hash.update(readFileSync(join(this.root, ...path.split('/'))));
      hash.update(NEWLINE);
    }

    this._digest = `sha256:${hash.digest('hex')}`;

    return this._digest;
  }

  probes() {
    const path = join(this.root, 'probes', 'probes.json');

    if (!existsSync(path)) {
      throw new CorpusError('corpus_not_installed', 'probes/probes.json is missing from the corpus.');
    }

    return JSON.parse(readFileSync(path, 'utf8'));
  }

  /**
   * The exact set of case ids a probe must fail in one language: the probe's
   * declared set MINUS whatever that language skips. A skipped row cannot fail,
   * so counting it would make the expectation unsatisfiable.
   */
  expectedProbeFailures(probeId, language) {
    const probe = this.probes().probes.find((candidate) => candidate.id === probeId);

    if (!probe) throw new CorpusError('unknown_probe', `No probe named ${probeId}.`);

    const expected = {};

    for (const [suiteId, ids] of Object.entries(probe.must_fail ?? {})) {
      const skipped = new Set(this.suite(suiteId).skippedIds(language));
      expected[suiteId] = ids.filter((id) => !skipped.has(id));
    }

    return expected;
  }
}
