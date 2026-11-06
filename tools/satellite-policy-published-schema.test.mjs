import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validatePublishedRefs, verifyPublishedSources, verifyRuntimeBytes } from './satellite-policy/published-contract.mjs';

const refs = () => JSON.parse(readFileSync(new URL('./satellite-policy/published-refs.json', import.meta.url)));

test('all six exact reviewed releases are required before a published runtime can load', () => {
  assert.equal(validatePublishedRefs(refs()).packages.length, 6);
  for (const change of [
    value => { value.referenceKind = 'candidate-source'; },
    value => { value.publishedReferenceVerified = true; },
    value => { value.packages.pop(); },
    value => { value.packages[0] = { ...value.packages[1] }; },
    value => { value.packages[0].package = 'unreviewed/package'; },
    value => { value.packages[0].version = 'latest'; },
    value => { value.packages[0].version = '0.4.2'; },
    value => { value.packages[0].source = 'main'; },
    value => { value.packages[0].source += '; command'; },
    value => { value.packages[0].autoload = '../source/vendor/autoload.php'; },
  ]) {
    const value = refs();
    change(value);
    assert.throws(() => validatePublishedRefs(value));
  }
});

test('a successful claim cannot replace exact clean source identities', () => {
  const value = refs();
  const source = cwd => value.packages.find(row => cwd.endsWith(row.repository)).source;
  const clean = (cwd, args) => args[0] === 'rev-parse' ? source(cwd) : '';
  assert.doesNotThrow(() => verifyPublishedSources('/verified', value, clean));
  assert.throws(() => verifyPublishedSources('/verified', value, () => '0'.repeat(40)));
  assert.throws(() => verifyPublishedSources('/verified', value, (cwd, args) => args[0] === 'diff' ? 'src/changed.php' : clean(cwd, args)));
  assert.throws(() => verifyPublishedSources('/verified', value, (cwd, args) => args[0] === 'ls-files' ? 'src/untracked.php' : clean(cwd, args)));
});

test('runtime provenance refuses empty, missing, extra and changed files', () => {
  const expected = new Map([['index.js', Buffer.from('export const value = 1;\n')]]);
  assert.deepEqual(verifyRuntimeBytes(expected, new Map(expected)), []);
  assert.throws(() => verifyRuntimeBytes(new Map(), new Map()));
  assert.throws(() => verifyRuntimeBytes(expected, new Map()));
  assert.throws(() => verifyRuntimeBytes(expected, new Map([...expected, ['__proto__', Buffer.from('extra')]])));
  assert.throws(() => verifyRuntimeBytes(expected, new Map([['index.js', Buffer.from('export const value = 2;\n')]])));
});

test('only text CRLF differences normalize and arbitrary bytes remain distinct', () => {
  const changed = verifyRuntimeBytes(new Map([['index.py', Buffer.from('value = 1\r\n')]]), new Map([['index.py', Buffer.from('value = 1\n')]]));
  assert.equal(changed.length, 1);
  assert.equal(changed[0].file, 'index.py');
  assert.notEqual(changed[0].sourceSha256, changed[0].installedSha256);
  assert.throws(() => verifyRuntimeBytes(new Map([['asset.bin', Buffer.from([13, 10])]]), new Map([['asset.bin', Buffer.from([10])]])));
  assert.throws(() => verifyRuntimeBytes(new Map([['index.py', Buffer.from([255, 13, 10])]]), new Map([['index.py', Buffer.from([254, 10])]])));
});
