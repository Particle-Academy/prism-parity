import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

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
  return { platform: process.platform, empty_target: process.platform === 'win32' ? 'refused' : 'atomically-replaced', stale_remover: 'refused-replacement-intact', populated_target: 'refused-original-intact', fixture: root };
}

if (process.argv[1]?.endsWith('primitives.mjs')) {
  const proof = primitives(join(fs.mkdtempSync(join(os.tmpdir(), 'prism-lock-review-')), 'primitives'));
  console.log(JSON.stringify(proof));
  console.log('Lock directory primitives passed: 3 required rows on ' + proof.platform + '.');
}
