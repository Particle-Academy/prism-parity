import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {validatePublishedRefs, verifyPublishedFiles} from './mcp-behavior/published-contract.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const original = JSON.parse(readFileSync(join(root, 'tools/mcp-behavior/published-refs.json')));
const digest = text => createHash('sha256').update(text).digest('hex');

test('release references bind all three normal registries and nonempty runtime censuses', () => {
  assert.equal(validatePublishedRefs(structuredClone(original)).schemaVersion, 1);
});

test('foreign URLs, credentials, unsafe paths and executable extra configuration fail closed', () => {
  for (const change of [
    r => {r.ts.tarball = 'https://example.invalid/foreign.tgz';},
    r => {r.py.wheel.url = r.py.wheel.url.replace('https://', 'https://owner:secret@');},
    r => {r.php.files['../escape'] = digest('escape');},
    r => {r.php.files['C:/escape'] = digest('escape');},
    r => {r.php.command = 'run arbitrary code';},
    r => {r.ts.source = 'main';},
    r => {r.py.files = {};},
  ]) {
    const ref = structuredClone(original); change(ref);
    assert.throws(() => validatePublishedRefs(ref));
  }
});

function fixture(t) {
  const parent = realpathSync(tmpdir());
  const directory = mkdtempSync(join(parent, 'prism-mcp-published-'));
  t.after(() => {
    const actual = realpathSync(directory);
    assert(actual.startsWith(parent + sep + 'prism-mcp-published-'));
    rmSync(actual, {recursive:true, force:true});
  });
  writeFileSync(join(directory, 'entry.js'), 'trusted runtime');
  return directory;
}

test('a changed runtime byte is refused before any SDK load', t => {
  const dir = fixture(t), expected = {'entry.js':digest('trusted runtime')};
  assert.equal(verifyPublishedFiles(dir, expected), 1);
  writeFileSync(join(dir, 'entry.js'), 'counterfeit runtime');
  assert.throws(() => verifyPublishedFiles(dir, expected), /census or bytes changed/);
});

test('an added file cannot escape the reviewed runtime census', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'extra.js'), 'unexpected capability');
  assert.throws(() => verifyPublishedFiles(dir, {'entry.js':digest('trusted runtime')}), /census or bytes changed/);
});

test('a prototype-named extra file cannot disappear from the runtime census', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, '__proto__'), 'unexpected file');
  assert.throws(() => verifyPublishedFiles(dir, {'entry.js':digest('trusted runtime')}), /census or bytes changed/);
});

test('missing runtime files and an empty-work forgery are refused', t => {
  const dir = fixture(t);
  assert.throws(() => verifyPublishedFiles(dir, {'entry.js':digest('trusted runtime'), 'missing.js':digest('missing')}));
  assert.throws(() => verifyPublishedFiles(dir, {}));
});

test('source override refuses before an install or new evidence directory', () => {
  const directory = join(root, '.mcp-published'), before = existsSync(directory);
  const result = spawnSync(process.execPath, [join(root, 'tools/mcp-behavior/published.mjs')], {
    cwd:root, env:{...process.env,PRISM_MCP_AUTOLOAD:'synthetic-source-override'}, encoding:'utf8', timeout:10000, windowsHide:true,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PRISM_MCP_AUTOLOAD cannot override a published consumer/);
  assert.equal(existsSync(directory), before);
});
