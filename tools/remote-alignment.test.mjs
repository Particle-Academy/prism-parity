import assert from 'node:assert/strict';
import test from 'node:test';
import { auditRemote, contentsClient } from './remote-alignment.mjs';

const corpus = Buffer.from('{"suite":"example","cases":[{"id":"one"}]}\n');
const suites = [{ id: 'example', bytes: corpus, implementations: { ts: { status: 'full', runner: 'prism-ts:test/corpus.test.ts' } } }];
function fakeApi(overrides = {}) {
  return {
    head: async () => 'a'.repeat(40),
    tree: async () => [{ type: 'blob', path: 'test/fixtures/example.json' }],
    file: async (_repo, path) => path.endsWith('.ts') ? Buffer.from("readFileSync('fixtures/example.json')") : corpus,
    ...overrides,
  };
}

test('counts only checked claims and matched copies as verified', async () => {
  const result = await auditRemote(suites, fakeApi());
  assert.equal(result.ok, true);
  assert.equal(result.verifiedClaims, 1);
  assert.equal(result.missingFiles, 0);
  assert.equal(result.unreferencedFullRunners, 0);
  assert.equal(result.verifiedCopies, 1);
});

test('canonical suite sources are not counted as vendored copies', async () => {
  const local = [{ ...suites[0], implementations: { php: { status: 'full', runner: 'prism-parity:runners/test.php' } } }];
  const result = await auditRemote(local, fakeApi({
    tree: async () => [{ type: 'blob', path: 'suites/example/cases.json' }, { type: 'blob', path: 'loaders/php/suites/example/cases.json' }],
    file: async (_repo, path) => path.endsWith('.php') ? Buffer.from('example') : corpus,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.discoveredCopies, 1);
});

test('a manifest pointing at a nonexistent fixture runner fails', async () => {
  const broken = [{ ...suites[0], implementations: { ts: { status: 'full', runner: 'prism-ts:test/nonexistent.ts' } } }];
  const result = await auditRemote(broken, fakeApi({ file: async (_repo, path) => path.includes('nonexistent') ? null : corpus }));
  assert.equal(result.ok, false);
  assert.equal(result.verifiedClaims, 0);
  assert.equal(result.missingFiles, 1);
  assert.match(result.failures.join('\n'), /nonexistent/);
});

test('an existing full runner that never names its corpus fails', async () => {
  const result = await auditRemote(suites, fakeApi({ file: async (_repo, path) => path.endsWith('.ts') ? Buffer.from('assert.equal(1, 1);') : corpus }));
  assert.equal(result.ok, false);
  assert.equal(result.verifiedClaims, 0);
  assert.equal(result.unreferencedFullRunners, 1);
});

test('renamed fixture content can supply the corpus reference', async () => {
  const result = await auditRemote(suites, fakeApi({
    tree: async () => [{ type: 'blob', path: 'test/fixtures/renamed.json' }],
    file: async (_repo, path) => path.endsWith('.ts') ? Buffer.from("read('fixtures/renamed.json')") : corpus,
  }));
  assert.equal(result.ok, true);
});

test('a changed byte in a vendored copy fails even when its JSON value is equal', async () => {
  const result = await auditRemote(suites, fakeApi({ file: async (_repo, path) => path.endsWith('.ts') ? Buffer.from('example') : Buffer.from(corpus.toString().trim()) }));
  assert.equal(result.ok, false);
  assert.equal(result.verifiedCopies, 0);
  assert.equal(result.staleCopies, 1);
  assert.match(result.failures.join('\n'), /sha256/);
});

test('rate limits and network failures are unresolved, not missing or verified', async () => {
  const result = await auditRemote(suites, fakeApi({ head: async () => { throw new Error('HTTP 403: rate limit'); } }));
  assert.equal(result.ok, false);
  assert.equal(result.verifiedClaims, 0);
  assert.equal(result.missingFiles, 0);
  assert.equal(result.unresolvedClaims, 1);
});

test('failed copy discovery cannot prove that a fixture reference is absent', async () => {
  const result = await auditRemote(suites, fakeApi({
    tree: async () => { throw new Error('network unavailable'); },
    file: async () => Buffer.from("read('renamed.json')"),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.unreferencedFullRunners, 0);
  assert.equal(result.unresolvedClaims, 1);
  assert.equal(result.checkedClaims, 0);
});

test('one missing file shared by two claims is reported as one file and two affected claims', async () => {
  const repeated = [{ ...suites[0], implementations: { ts: suites[0].implementations.ts, py: suites[0].implementations.ts } }];
  const result = await auditRemote(repeated, fakeApi({ tree: async () => [], file: async () => null }));
  assert.equal(result.missingFiles, 1);
  assert.equal(result.missingClaims, 2);
  assert.equal(result.checkedClaims, 2);
});

test('all reads use one main snapshot per repo and repeated runner files are cached', async () => {
  const reads = [];
  const api = fakeApi({ file: async (repo, path, ref) => { reads.push([repo, path, ref]); return path.endsWith('.ts') ? Buffer.from('example') : corpus; } });
  const repeated = [{ ...suites[0], implementations: { ts: suites[0].implementations.ts, py: suites[0].implementations.ts } }];
  const result = await auditRemote(repeated, api);
  assert.equal(result.verifiedClaims, 2);
  assert.equal(reads.filter(([, path]) => path.endsWith('.ts')).length, 1);
  assert.ok(reads.every(([, , ref]) => ref === 'a'.repeat(40)));
});

test('Contents API rejects directories, symlinks and malformed content', async () => {
  for (const body of [{ type: 'dir' }, { type: 'symlink' }, { type: 'file', encoding: 'base64', content: '!!!' }]) {
    const client = contentsClient(async () => body);
    await assert.rejects(() => client.file('prism-ts', 'test/a.ts', 'a'.repeat(40)));
  }
});

test('truncated tree discovery fails instead of silently missing copies', async () => {
  const client = contentsClient(async () => ({ truncated: true, tree: [] }));
  await assert.rejects(() => client.tree('prism-ts', 'a'.repeat(40)), /truncated/);
});

test('a missing runner reddens through the real contents adapter', async () => {
  const endpoints = [];
  const api = contentsClient(async (endpoint) => {
    endpoints.push(endpoint);
    if (endpoint.endsWith('/commits/main')) return { sha: 'a'.repeat(40) };
    if (endpoint.includes('/git/trees/')) return { truncated: false, tree: [] };
    if (endpoint.includes('/contents/test/corpus.test.ts?ref=')) return null;
    throw new Error(`Unexpected fixture request: ${endpoint}`);
  });
  const result = await auditRemote(suites, api);
  assert.equal(result.ok, false);
  assert.equal(result.missingFiles, 1);
  assert.equal(result.verifiedClaims, 0);
  assert.ok(endpoints.includes(`repos/Particle-Academy/prism-ts/contents/test/corpus.test.ts?ref=${'a'.repeat(40)}`));
});

test('contents access refuses traversal before making a request', async () => {
  const api = contentsClient(async () => { assert.fail('Invalid paths must not reach GitHub'); });
  await assert.rejects(() => api.file('prism-ts', '../private', 'a'.repeat(40)), /Invalid/);
  await assert.rejects(() => api.file('other-owner/repo', 'test.ts', 'a'.repeat(40)), /Invalid/);
});

// --- Generic runners, derived copies, and declared in-source corpora --------
//
// These three shapes accounted for EIGHTEEN of the twenty-two failures the
// first time this audit was run against real repositories, and none of them
// was a defect. Each test below has a negative twin, because the risk in
// loosening a check is that it stops catching the thing it was built for.

const refusalCorpus = Buffer.from('{"suite":"example","cases":[{"id":"one","refusal":"escape","notes":"authoring only"}]}\n');
const refusalSuites = [{
  id: 'example',
  bytes: refusalCorpus,
  implementations: { ts: { status: 'full', runner: 'prism-ts:test/corpus.test.ts' } },
}];

test('a generic runner that opens the published corpus is evidence for every suite', async () => {
  // prism-ts:conformance/runner.mjs serves six suites by enumerating them, so
  // it can contain no suite id at all. Six failures came from this one file.
  for (const locator of ['@particle-academy/prism-conformance', 'prism_conformance', 'Corpus::open', 'Corpus.open']) {
    const result = await auditRemote(suites, fakeApi({
      tree: async () => [],
      file: async (_repo, path) => path.endsWith('.ts') ? Buffer.from(`const c = ${locator}(root);`) : corpus,
    }));
    assert.equal(result.ok, true, locator);
    assert.equal(result.verifiedClaims, 1, locator);
  }
});

test('a runner naming no suite, no copy and no loader still fails', async () => {
  // The control for the test above. Loosening the check must not make it vacuous.
  const result = await auditRemote(suites, fakeApi({
    tree: async () => [],
    file: async (_repo, path) => path.endsWith('.ts') ? Buffer.from('const c = openSomethingElse(root);') : corpus,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.unreferencedFullRunners, 1);
});

test('a derived copy is recognised by case identity and verified on shared fields', async () => {
  // prism-workspace-ts ships 134 rows as escape-corpus.json: same ids, `note`
  // for `notes`, no `since`. Byte comparison is the wrong question for it.
  const derived = Buffer.from('{"cases":[{"id":"one","refusal":"escape","note":"narrowed"}]}');
  const result = await auditRemote(refusalSuites, fakeApi({
    tree: async () => [{ type: 'blob', path: 'src/security/escape-corpus.json' }],
    file: async (_repo, path) => path.endsWith('.ts') ? Buffer.from("read('escape-corpus.json')") : derived,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.discoveredCopies, 1);
  assert.equal(result.verifiedCopies, 1);
  assert.equal(result.staleCopies, 0);
});

test('DERIVED IS NOT AN ESCAPE HATCH: a changed value in a derived copy is stale', async () => {
  // Dropping `suite` to dodge the byte comparison must buy nothing. Every
  // field the copy does carry is still compared.
  const tampered = Buffer.from('{"cases":[{"id":"one","refusal":"allowed","note":"narrowed"}]}');
  const result = await auditRemote(refusalSuites, fakeApi({
    tree: async () => [{ type: 'blob', path: 'src/security/escape-corpus.json' }],
    file: async (_repo, path) => path.endsWith('.ts') ? Buffer.from("read('escape-corpus.json')") : tampered,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.staleCopies, 1);
  assert.match(result.failures.join('\n'), /derived.*one\.refusal/s);
});

test('a copy whose case ids differ is not derived from the suite at all', async () => {
  const unrelated = Buffer.from('{"cases":[{"id":"somethingelse","refusal":"escape"}]}');
  const result = await auditRemote(refusalSuites, fakeApi({
    tree: async () => [{ type: 'blob', path: 'src/security/escape-corpus.json' }],
    file: async (_repo, path) => path.endsWith('.ts') ? Buffer.from("read('escape-corpus.json')") : unrelated,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.discoveredCopies, 0);
  assert.equal(result.unreferencedFullRunners, 1);
});

test('a declared in-source corpus satisfies the reference when it exists and is named', async () => {
  // prism-workspace embeds the rows as EscapeCorpus.php, shipped in the
  // distributed package on purpose. No JSON discovery can ever find it.
  const declared = [{
    ...suites[0],
    implementations: {
      php: { status: 'full', runner: 'prism-workspace:tests/Unit/PathGuardTest.php', references: 'prism-workspace:src/Security/EscapeCorpus.php' },
    },
  }];
  const result = await auditRemote(declared, fakeApi({
    tree: async () => [],
    file: async (_repo, path) => Buffer.from(path.endsWith('PathGuardTest.php') ? 'use EscapeCorpus; EscapeCorpus::all();' : 'final class EscapeCorpus {}'),
  }));
  assert.equal(result.ok, true);
  assert.equal(result.verifiedClaims, 1);
});

test('a declared in-source corpus that does not exist fails', async () => {
  const declared = [{
    ...suites[0],
    implementations: {
      php: { status: 'full', runner: 'prism-workspace:tests/Unit/PathGuardTest.php', references: 'prism-workspace:src/Security/Missing.php' },
    },
  }];
  const result = await auditRemote(declared, fakeApi({
    tree: async () => [],
    file: async (_repo, path) => path.endsWith('Missing.php') ? null : Buffer.from('use EscapeCorpus;'),
  }));
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /MISSING REFERENCES/);
});

test('a declared corpus the runner never names does not satisfy the reference', async () => {
  // Declaring a file is not the same as reading it.
  const declared = [{
    ...suites[0],
    implementations: {
      php: { status: 'full', runner: 'prism-workspace:tests/Unit/PathGuardTest.php', references: 'prism-workspace:src/Security/EscapeCorpus.php' },
    },
  }];
  const result = await auditRemote(declared, fakeApi({
    tree: async () => [],
    file: async () => Buffer.from('assert(true);'),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.unreferencedFullRunners, 1);
});

test('a references locator pointing at another repository is refused', async () => {
  // A runner cannot read another repository's source, so a locator that says
  // it does is a manifest error rather than evidence.
  const declared = [{
    ...suites[0],
    implementations: {
      php: { status: 'full', runner: 'prism-workspace:tests/Unit/PathGuardTest.php', references: 'prism-parity:suites/example/cases.json' },
    },
  }];
  const result = await auditRemote(declared, fakeApi({ tree: async () => [] }));
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /cannot read another repository/);
});

test('a derived copy carrying a field the suite does not have is stale', async () => {
  // The other half of the escape hatch. A copy that INVENTS a field has either
  // been hand-edited or has diverged in shape; either way the two are no longer
  // the same corpus, and reporting only changed values would miss it.
  const invented = Buffer.from('{"cases":[{"id":"one","refusal":"escape","expected":"allowed"}]}');
  const result = await auditRemote(refusalSuites, fakeApi({
    tree: async () => [{ type: 'blob', path: 'src/security/escape-corpus.json' }],
    file: async (_repo, path) => path.endsWith('.ts') ? Buffer.from("read('escape-corpus.json')") : invented,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.staleCopies, 1);
  assert.match(result.failures.join('\n'), /one\.expected is absent from the suite/);
});
