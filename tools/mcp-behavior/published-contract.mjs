import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync, readdirSync, readFileSync, realpathSync} from 'node:fs';
import {join, relative, sep} from 'node:path';

function keys(value, expected) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), expected.sort());
}

export function validatePublishedRefs(refs) {
  keys(refs, ['schemaVersion', 'php', 'ts', 'py']);
  assert.equal(refs.schemaVersion, 1);
  for (const language of ['php', 'ts', 'py']) {
    const ref = refs[language];
    keys(ref, ['version', 'source', 'files', ...(language === 'ts' ? ['integrity', 'tarball'] : language === 'py' ? ['wheel'] : [])]);
    assert.match(ref.version, /^\d+\.\d+\.\d+$/);
    assert.match(ref.source, /^[a-f0-9]{40}$/);
    assert(ref.files && typeof ref.files === 'object' && !Array.isArray(ref.files));
    assert(Object.keys(ref.files).length > 0, 'Runtime census cannot be empty');
    for (const [file, digest] of Object.entries(ref.files)) {
      assert(!file.includes('\\') && !file.includes(':') && !file.includes('\0'));
      assert(file.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe runtime path');
      assert.match(digest, /^[a-f0-9]{64}$/);
    }
  }
  assert(Object.keys(refs.php.files).some(file => file.startsWith('src/')));
  assert.deepEqual(Object.keys(refs.ts.files).sort(), ['dist/index.d.ts', 'dist/index.js']);
  assert.deepEqual(Object.keys(refs.py.files).sort(), ['prism_mcp/__init__.py', 'prism_mcp/py.typed']);
  assert.match(refs.ts.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  assert.equal(refs.ts.tarball, `https://registry.npmjs.org/@particle-academy/prism-mcp/-/prism-mcp-${refs.ts.version}.tgz`);
  keys(refs.py.wheel, ['filename', 'url', 'sha256']);
  assert.equal(refs.py.wheel.filename, `prism_ai_mcp-${refs.py.version}-py3-none-any.whl`);
  assert.match(refs.py.wheel.sha256, /^[a-f0-9]{64}$/);
  const url = new URL(refs.py.wheel.url);
  assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, 'files.pythonhosted.org');
  assert.equal(url.username + url.password + url.search + url.hash, '');
  assert.equal(url.pathname.split('/').at(-1), refs.py.wheel.filename);
  return refs;
}

export function verifyPublishedFiles(directory, expected, prefix = '') {
  const root = realpathSync(directory), actual = Object.create(null);
  function walk(folder) {
    for (const name of readdirSync(folder)) {
      const file = join(folder, name), stat = lstatSync(file);
      assert(!stat.isSymbolicLink(), 'Published runtime symlinks are refused');
      if (stat.isDirectory()) walk(file);
      else {
        assert(stat.isFile(), 'Unexpected published runtime entry');
        const rel = relative(root, realpathSync(file));
        assert(rel && !rel.startsWith('..' + sep));
        actual[prefix + rel.split(sep).join('/')] = createHash('sha256').update(readFileSync(file)).digest('hex');
      }
    }
  }
  walk(root);
  assert.deepEqual({...actual}, expected, 'Published runtime census or bytes changed');
  return Object.keys(actual).length;
}
