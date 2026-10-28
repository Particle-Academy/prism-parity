import fs from 'node:fs';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { nativeIdentity } from './identity.mjs';
import { windowsJobCases, inheritedJobCase } from './windows-review.mjs';

// Deliberately a small review experiment, not a port lock implementation.
// All records and paths are generated inside this experiment's owned root.
function sameEstablishedIdentity(owner, current) {
  return ['platform', 'boot_id', 'pid_namespace'].every(key => typeof owner?.[key] === 'string' && owner[key].length > 0 && owner[key] === current[key]);
}

function liveness(pid) {
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return error.code === 'ESRCH' ? 'dead' : 'unknown'; }
}

function observe(root, current, probe) {
  const canonical = join(root, 'owner.lock');
  const entries = fs.readdirSync(canonical);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^owner-[0-9a-f]{32}\.json$/);
  const bytes = fs.readFileSync(join(canonical, entries[0]), 'utf8');
  assert(bytes.endsWith('\n'));
  const record = JSON.parse(bytes);
  assert.equal(entries[0], 'owner-' + record.nonce + '.json');
  assert.equal(record.version, 2);
  assert(Number.isInteger(record.pid) && record.pid > 0 && record.pid <= 4294967295);
  // Foreign or unavailable identity must not reach a PID lookup, even released.
  if (!sameEstablishedIdentity(record.identity, current)) return { result: 'held-unknown', probes: 0 };
  if (probe(record.pid) !== 'dead') return { result: 'held', probes: 1 };
  // Bind removal to exactly the observed owner's nonce. No recursive cleanup.
  assert.equal(fs.realpathSync(dirname(canonical)), root);
  fs.unlinkSync(join(canonical, entries[0]));
  fs.rmdirSync(canonical);
  const nonce = randomBytes(16).toString('hex'), candidate = join(root, 'replacement-' + nonce);
  assert.equal(fs.realpathSync(dirname(candidate)), root);
  fs.mkdirSync(candidate);
  const replacement = { ...record, pid: process.pid, identity: current, nonce, released: false };
  fs.writeFileSync(join(candidate, 'owner-' + nonce + '.json'), JSON.stringify(replacement) + '\n', { flag: 'wx' });
  fs.renameSync(candidate, canonical);
  assert.equal(JSON.parse(fs.readFileSync(join(canonical, 'owner-' + nonce + '.json'), 'utf8')).pid, process.pid);
  assert.notEqual(nonce, record.nonce);
  return { result: 'nonce-bound-reclaimed', probes: 1, replacement_nonce: nonce };
}

export async function identityRecovery() {
  const identity = nativeIdentity();
  assert.equal(identity.platform, process.platform);
  assert.equal(typeof identity.pid_namespace, 'string', 'Positive native identity must be established');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'prism-lock-identity-')));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)));
  const worker = fork(new URL('./identity-worker.mjs', import.meta.url), [root], { env, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let stderr = '';
  worker.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const deadline = setTimeout(() => { worker.kill(); }, 45000);
  const exited = once(worker, 'exit');
  try {
    const ready = await Promise.race([once(worker, 'message').then(([message]) => message), exited.then(([code]) => { throw new Error('Identity worker exited before publication: ' + code + ' ' + stderr); })]);
    assert.equal(ready.pid, worker.pid);
    assert.deepEqual(ready.identity, identity, 'Independent holder/prober native identity must match');
    const live = observe(root, identity, liveness);
    assert.deepEqual(live, { result: 'held', probes: 1 });
    worker.send('exit-without-release');
    const [code, signal] = await exited;
    assert.equal(code, 0, stderr); assert.equal(signal, null);
    const dead = observe(root, identity, liveness);
    assert.equal(dead.result, 'nonce-bound-reclaimed');
    assert.equal(dead.probes, 1);
    const heldRows = [];
    for (const [id, ownerIdentity, released] of [
      ['foreign-realm', { ...identity, pid_namespace: identity.pid_namespace + ':foreign' }, false],
      ['foreign-realm-released', { ...identity, pid_namespace: identity.pid_namespace + ':foreign' }, true],
      ['both-unknown', { ...identity, pid_namespace: null }, true],
    ]) {
      const rowRoot = join(root, id), canonical = join(rowRoot, 'owner.lock');
      fs.mkdirSync(rowRoot); fs.mkdirSync(canonical);
      const record = { version: 2, pid: ready.pid, identity: ownerIdentity, nonce: ready.nonce, released, expires_at: 1 };
      const file = join(canonical, 'owner-' + ready.nonce + '.json'), bytes = JSON.stringify(record) + '\n';
      fs.writeFileSync(file, bytes, { flag: 'wx' });
      const inode = fs.statSync(canonical).ino;
      const current = id === 'both-unknown' ? { ...identity, pid_namespace: null } : identity;
      const held = observe(fs.realpathSync(rowRoot), current, () => { throw new Error('Foreign/unknown realm must not query PID'); });
      assert.deepEqual(held, { result: 'held-unknown', probes: 0 });
      assert.equal(fs.readFileSync(file, 'utf8'), bytes);
      assert.equal(fs.statSync(canonical).ino, inode);
      assert.deepEqual(fs.readdirSync(canonical), ['owner-' + ready.nonce + '.json']);
      heldRows.push({ id, ...held, directory_unchanged: true });
    }
    return { platform: process.platform, identity, holder_identity: ready.identity, holder_pid: ready.pid, live, dead, held: heldRows, fixture: root };
  } finally {
    clearTimeout(deadline);
    if (worker.exitCode === null && worker.signalCode === null) worker.kill();
    await exited;
  }
}

if (process.argv[1]?.endsWith('identity-recovery.mjs')) {
  if (process.argv[2] === '--inherited-job-controller') {
    fs.writeFileSync(process.argv[3], JSON.stringify(inheritedJobCase()) + '\n', { flag: 'wx' });
    process.exit(0);
  }
  if (process.argv[2] === '--native-job-child') {
    const proof = await identityRecovery();
    fs.writeFileSync(process.argv[3], JSON.stringify(proof) + '\n', { flag: 'wx' });
    process.exit(0);
  }
  const proof = process.platform === 'win32' ? windowsJobCases() : await identityRecovery();
  console.log(JSON.stringify(proof));
  if (process.platform === 'win32') assert.deepEqual(proof.failures, [], 'Every native Job setup/recovery must execute successfully; inherited rows are retained when breakaway fails');
  const contexts = process.platform === 'win32' ? proof.rows.length : 1;
  assert.equal(contexts, process.platform === 'win32' ? 4 : 1);
  console.log('Lock identity recovery passed: 1 live owner held; 1 dead owner recovered; 3 foreign/unknown rows held; 0 foreign PID probes; ' + contexts + ' native contexts on ' + proof.platform + '.');
}
