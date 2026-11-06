import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const releases = new Map([
  ['prism-browser', ['particle-academy/prism-browser', '0.4.1']],
  ['prism-browser-ts', ['@particle-academy/prism-browser', '0.3.0']],
  ['prism-browser-py', ['prism-ai-browser', '0.2.0']],
  ['prism-human-plus', ['particle-academy/prism-human-plus', '0.6.0']],
  ['prism-human-plus-ts', ['@particle-academy/prism-human-plus', '0.5.0']],
  ['prism-human-plus-py', ['prism-ai-human-plus', '0.3.0']],
]);

export function validatePublishedRefs(refs) {
  assert.deepEqual(Object.keys(refs).sort(), ['packages', 'referenceKind']);
  assert.equal(refs.referenceKind, 'published-artifact');
  assert(Array.isArray(refs.packages));
  assert.deepEqual(refs.packages.map(row => row.repository).sort(), [...releases.keys()].sort());
  for (const row of refs.packages) {
    assert.deepEqual(Object.keys(row).sort(), ['package', 'repository', 'source', 'version']);
    assert.deepEqual([row.package, row.version], releases.get(row.repository), 'Only reviewed package releases may run');
    assert.equal(typeof row.source, 'string');
    assert(/^[a-f0-9]{40}$/.test(row.source), 'An immutable published source revision is required');
  }
  return refs;
}

export function verifyPublishedSources(sourceRoot, refs, git) {
  validatePublishedRefs(refs);
  for (const row of refs.packages) {
    const cwd = resolve(sourceRoot, row.repository);
    assert.equal(git(cwd, ['rev-parse', 'HEAD']), row.source, row.repository + ': wrong reviewed source');
    assert.equal(git(cwd, ['diff', 'HEAD', '--name-only']), '', row.repository + ': tracked source changed');
    assert.equal(git(cwd, ['ls-files', '--others', '--exclude-standard', '--', 'src', 'sidecar']), '', row.repository + ': extra runtime source');
  }
}

export function verifyRuntimeBytes(expected, installed) {
  assert(expected instanceof Map && installed instanceof Map, 'Runtime censuses must preserve every filename');
  assert(expected.size > 0 && installed.size > 0, 'A zero-file runtime cannot prove provenance');
  assert.deepEqual([...installed.keys()].sort(), [...expected.keys()].sort(), 'Runtime file census differs');
  const digest = raw => createHash('sha256').update(raw).digest('hex');
  const normalizeLF = raw => Buffer.from(raw.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');
  const normalized = [];
  for (const [name, raw] of expected) {
    const actual = installed.get(name);
    if (!raw.equals(actual)) {
      assert(/\.(?:php|py|js|mjs|cjs|ts|map)$/.test(name), 'Only source text line endings can differ');
      assert(normalizeLF(raw).equals(normalizeLF(actual)), name + ': independent runtime difference');
      normalized.push({ file: name, sourceSha256: digest(raw), installedSha256: digest(actual) });
    }
  }
  return normalized;
}
