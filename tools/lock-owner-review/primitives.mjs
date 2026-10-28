import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function primitives(root) {
  fs.mkdirSync(root);
  const owned = fs.realpathSync(root);
  const renameOwned = (source, target) => {
    assert.equal(fs.realpathSync(dirname(source)), owned);
    assert.equal(fs.realpathSync(dirname(target)), owned);
    fs.renameSync(source, target);
  };
  const canonical = join(root, 'empty.lock'), candidate = join(root, 'candidate');
  fs.mkdirSync(canonical); fs.mkdirSync(candidate);
  fs.writeFileSync(join(candidate, 'owner-new.json'), '{"nonce":"new"}\n');
  let error = null;
  try { renameOwned(candidate, canonical); } catch (failure) { assert.equal(failure.syscall, 'rename'); error = failure.code; }
  if (process.platform === 'win32') {
    assert(error, 'Windows must refuse an existing empty directory');
    assert.deepEqual(fs.readdirSync(canonical), []);
    assert(fs.existsSync(join(candidate, 'owner-new.json')));
    // Only this known-empty, owned fixture directory is removed.
    fs.rmdirSync(canonical); renameOwned(candidate, canonical);
  } else {
    assert.equal(error, null, 'POSIX must atomically replace the empty directory');
    assert(!fs.existsSync(candidate));
  }
  let staleRemoved = false;
  try { fs.rmdirSync(canonical); staleRemoved = true; } catch (failure) { assert.equal(failure.syscall, 'rmdir'); }
  assert.equal(staleRemoved, false);
  assert.equal(fs.readFileSync(join(canonical, 'owner-new.json'), 'utf8'), '{"nonce":"new"}\n');
  const populated = join(root, 'populated.lock'), contender = join(root, 'contender');
  fs.mkdirSync(populated); fs.mkdirSync(contender);
  fs.writeFileSync(join(populated, 'owner-old.json'), 'old');
  fs.writeFileSync(join(contender, 'owner-other.json'), 'other');
  let replacedPopulated = false;
  try { renameOwned(contender, populated); replacedPopulated = true; } catch (failure) { assert.equal(failure.syscall, 'rename'); }
  assert.equal(replacedPopulated, false);
  assert.equal(fs.readFileSync(join(populated, 'owner-old.json'), 'utf8'), 'old');
  // Windows Node/libuv replaces a regular file. This is why stopping legacy
  // workers is required even with the production stale-legacy lstat preflight.
  const legacy = join(root, 'legacy.lock'), regularCandidate = join(root, 'regular-candidate');
  fs.writeFileSync(legacy, 'legacy\n'); fs.mkdirSync(regularCandidate);
  fs.writeFileSync(join(regularCandidate, 'owner-new.json'), 'new\n');
  let regularError = null;
  try { renameOwned(regularCandidate, legacy); }
  catch (failure) { assert.equal(failure.syscall, 'rename'); regularError = failure.code; }
  if (process.platform === 'win32') {
    assert.equal(regularError, null, 'Record actual Node/Windows replacement, not a refusal claim');
    assert(fs.statSync(legacy).isDirectory());
    assert.equal(fs.readFileSync(join(legacy, 'owner-new.json'), 'utf8'), 'new\n');
    assert(!fs.existsSync(regularCandidate));
  } else {
    assert(regularError, 'POSIX must refuse directory -> regular file');
    assert.equal(fs.readFileSync(legacy, 'utf8'), 'legacy\n');
    assert.equal(fs.readFileSync(join(regularCandidate, 'owner-new.json'), 'utf8'), 'new\n');
  }
  const pythonRoot = join(root, 'python-regular-file');
  assert.equal(fs.realpathSync(dirname(pythonRoot)), owned);
  const child = spawnSync(process.env.PRISM_LOCK_PYTHON ?? 'python', [
    '-I', '-X', 'utf8',
    fileURLToPath(new URL('./regular_file_rename.py', import.meta.url)), pythonRoot,
  ], { encoding: 'utf8', timeout: 15000, maxBuffer: 65536, windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  assert(!child.error, 'Native Python primitive must run');
  assert.equal(child.status, 0, child.stdout + '\n' + child.stderr);
  const python = JSON.parse(child.stdout);
  assert.equal(python.platform, process.platform);
  assert.equal(python.regular_file_target, 'refused-original-intact');
  assert(Number.isInteger(python.error?.errno), 'A native Python refusal must be observed');
  return { platform: process.platform, empty_target: process.platform === 'win32' ? 'refused' : 'atomically-replaced', stale_remover: 'refused-replacement-intact', populated_target: 'refused-original-intact', regular_file_target: process.platform === 'win32' ? 'replaced-native-residual' : 'refused-original-intact', regular_file_error: regularError, python_regular_file: python, fixture: root };
}

if (process.argv[1]?.endsWith('primitives.mjs')) {
  const proof = primitives(join(fs.mkdtempSync(join(os.tmpdir(), 'prism-lock-review-')), 'primitives'));
  console.log(JSON.stringify(proof));
  console.log('Lock directory primitives passed: 5 required rows on ' + proof.platform + '.');
}
