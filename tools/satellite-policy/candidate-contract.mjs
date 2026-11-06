import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const required = ['prism-browser', 'prism-browser-ts', 'prism-browser-py', 'prism-human-plus', 'prism-human-plus-ts', 'prism-human-plus-py'].sort();

export function validateCandidateRefs(refs) {
  assert.deepEqual(Object.keys(refs).sort(), ['packages', 'referenceKind']);
  assert.equal(refs.referenceKind, 'candidate-source');
  assert(Array.isArray(refs.packages));
  assert.deepEqual(refs.packages.map(row => row.repository).sort(), required, 'Every candidate package is required exactly once');
  for (const row of refs.packages) {
    assert.deepEqual(Object.keys(row).sort(), ['repository', 'source']);
    assert(/^[a-f0-9]{40}$/.test(row.source), 'Immutable source revision required');
  }
  return refs;
}

export function verifyCandidateTrees(root, refs, git) {
  validateCandidateRefs(refs);
  for (const row of refs.packages) {
    const cwd = resolve(root, '..', row.repository);
    assert.equal(git(cwd, ['rev-parse', 'HEAD']), row.source, row.repository+': wrong candidate checkout');
    assert.equal(git(cwd, ['diff', 'HEAD', '--name-only']), '', row.repository+': candidate tracked bytes changed');
    assert.equal(git(cwd, ['ls-files', '--others', '--exclude-standard', '--', 'src', 'sidecar']), '', row.repository+': unexpected runtime source');
  }
}
