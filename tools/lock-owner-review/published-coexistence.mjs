import fs from 'node:fs';
import os from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { primitives } from './primitives.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const parent = resolve(process.env.PRISM_LOCK_WORK_PARENT ?? os.tmpdir());
fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(join(parent, 'prism-published-lock-review-'));
const python = process.env.PRISM_LOCK_PYTHON ?? 'python';
const artifacts = {
  ts: { url: 'https://registry.npmjs.org/@particle-academy/prism-harness/-/prism-harness-0.8.0.tgz', file: 'prism-harness-0.8.0.tgz', sha256: '0cbee9d7f2693fd715909640f135015195689939d96a7a30fa2d6364d87e2de5' },
  py: { url: 'https://files.pythonhosted.org/packages/10/33/fce9b664a19d3785b6a68230a7582bcd52a588191c361a6d4640e0ca9d94/prism_ai_harness-0.3.0-py3-none-any.whl', file: 'prism_ai_harness-0.3.0-py3-none-any.whl', sha256: '9c40c140d648877e5109fe6372ca74c3b0877661459ae4f8aa9c6e11f950496e' },
};
const hash = raw => createHash('sha256').update(raw).digest('hex');
function execute(command, args, env = {}) {
  const child = spawnSync(command, args, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(child.status, 0, child.stdout + '\n' + child.stderr);
  assert(!child.error, 'A fixture process must execute normally');
  return child.stdout;
}
const downloads = await Promise.allSettled(Object.values(artifacts).map(async artifact => {
  const response = await fetch(artifact.url);
  assert(response.ok, 'Published artifact download must succeed');
  const raw = Buffer.from(await response.arrayBuffer());
  assert.equal(hash(raw), artifact.sha256, 'Execute only the exact previously verified published artifact');
  fs.writeFileSync(join(root, artifact.file), raw, { flag: 'wx' });
}));
for (const item of downloads) if (item.status === 'rejected') throw item.reason;
const ts = join(root, 'ts'), py = join(root, 'py');
fs.mkdirSync(ts); fs.mkdirSync(py);
const entries = execute('tar', ['-tzf', join(root, artifacts.ts.file)]).trim().split(/\r?\n/);
assert(entries.every(entry => entry.startsWith('package/') && !entry.split('/').includes('..')), 'Archive stays inside its package directory');
execute('tar', ['-xzf', join(root, artifacts.ts.file), '-C', ts]);
execute(python, ['-c', 'import pathlib,sys,zipfile; archive=zipfile.ZipFile(sys.argv[1]); assert all(not pathlib.PurePosixPath(item.filename).is_absolute() and ".." not in pathlib.PurePosixPath(item.filename).parts and ((item.external_attr >> 16) & 0o170000) != 0o120000 for item in archive.infolist()); archive.extractall(sys.argv[2])', join(root, artifacts.py.file), py]);
assert.equal(JSON.parse(fs.readFileSync(join(ts, 'package/package.json'))).version, '0.8.0');
const env = {};
for (const [key, value] of Object.entries(process.env)) if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)) env[key] = value;
env.PYTHONIOENCODING = 'utf-8';
const rows = [];
for (const language of ['ts', 'py']) {
  for (const kind of ['populated', 'old-expiry-and-old-mtime', 'partial-owner-record', 'legacy-expired-file', 'legacy-torn-stamp']) {
    const directory = join(root, language + '-' + kind); fs.mkdirSync(directory);
    const key = 'published-lock-review', digest = hash(key).slice(0, 32), lock = join(directory, digest + '.json.lock');
    const isNew = !kind.startsWith('legacy-');
    if (isNew) {
      fs.mkdirSync(lock);
      const nonce = '0123456789abcdef0123456789abcdef';
      const body = kind === 'partial-owner-record' ? '{"version":2,"pid":' : JSON.stringify({ version: 2, pid: process.pid, identity: { platform: process.platform, boot_id: 'fixture-identity', pid_namespace: 'fixture-realm' }, nonce, released: false, expires_at: kind === 'old-expiry-and-old-mtime' ? 0 : Math.floor(Date.now() / 1000) + 60 }) + '\n';
      fs.writeFileSync(join(lock, 'owner-' + nonce + '.json'), body);
    } else fs.writeFileSync(lock, kind === 'legacy-expired-file' ? '0\n' : '123');
    if (kind !== 'populated') fs.utimesSync(lock, new Date(0), new Date(0));
    const snapshot = () => {
      const stat = fs.statSync(lock);
      return { inode: stat.ino, directory: stat.isDirectory(), files: stat.isDirectory() ? fs.readdirSync(lock).sort().map(name => [name, fs.readFileSync(join(lock, name), 'hex')]) : fs.readFileSync(lock, 'hex') };
    };
    const before = snapshot(), spec = { store: directory, key, package: language === 'ts' ? join(ts, 'package') : py };
    const specFile = join(root, language + '-' + kind + '.json'); fs.writeFileSync(specFile, JSON.stringify(spec));
    let native, operations;
    if (language === 'ts') {
      const trace = join(root, language + '-' + kind + '-trace.json');
      const child = spawnSync(process.execPath, ['--trace-event-categories', 'node.fs.async,node.fs.sync', '--trace-event-file-pattern', trace, join(here, 'published-worker.mjs'), specFile], { cwd: root, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
      assert.equal(child.status, 0, child.stdout + '\n' + child.stderr); assert(!child.error);
      native = JSON.parse(child.stdout);
      operations = JSON.parse(fs.readFileSync(trace)).traceEvents.filter(event => /unlink|rename|rmdir/i.test(event.name));
    } else {
      const child = spawnSync(python, [join(here, 'published_worker.py'), specFile], { cwd: root, env: { ...env, PYTHONPATH: py }, encoding: 'utf8', timeout: 30000, windowsHide: true });
      assert.equal(child.status, 0, child.stdout + '\n' + child.stderr); assert(!child.error);
      native = JSON.parse(child.stdout); operations = native.audit;
    }
    const expected = isNew || (language === 'py' && kind === 'legacy-torn-stamp') ? 0 : 1;
    assert.equal(native.callbacks, expected, language + '/' + kind);
    if (isNew) {
      assert.equal(operations.length, 0, 'Published worker must not attempt canonical unlink/rename/removal');
      assert.deepEqual(snapshot(), before, 'New-format directory must be untouched');
      assert.equal(native.failure?.code, 'session_locked', 'A held new-format lock must report its native contention refusal');
    } else if (expected === 1) assert(operations.length > 0, 'Positive reclaim control must prove the filesystem observer is active');
    rows.push({ language, kind, expected_callbacks: expected, callbacks: native.callbacks, mutation_attempts: operations.length, directory_unchanged: isNew ? true : null, native });
  }
}
const proof = { measured_at: new Date().toISOString(), platform: process.platform, artifacts, primitive_rows: primitives(join(root, 'primitives')), rows, published_new_directory_rows: 6, published_new_directory_callbacks: 0, published_new_directory_mutation_attempts: 0, native_torn_stamp_difference_retained: true, fixture: root };
fs.writeFileSync(join(root, 'proof.json'), JSON.stringify(proof, null, 2), { flag: 'wx' });
console.log(JSON.stringify(proof));
assert.equal(rows.filter(row => row.kind === 'legacy-expired-file' || (row.language === 'ts' && row.kind === 'legacy-torn-stamp')).filter(row => row.callbacks === 1 && row.mutation_attempts > 0).length, 3);
assert.equal(rows.filter(row => row.directory_unchanged === true && row.callbacks === 0 && row.mutation_attempts === 0).length, 6);
console.log('Published lock coexistence passed: 6 new-directory rows; 0 callbacks; 0 unlink/rename attempts; 3 active reclaim controls.');
