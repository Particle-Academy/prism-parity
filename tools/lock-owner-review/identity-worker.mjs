import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { nativeIdentity } from './identity.mjs';

const root = fs.realpathSync(process.argv[2]);
const nonce = randomBytes(16).toString('hex');
const identity = nativeIdentity();
const owner = { version: 2, pid: process.pid, identity, nonce, released: false, expires_at: 1 };
const candidate = join(root, 'candidate-' + nonce), canonical = join(root, 'owner.lock');
assert.equal(fs.realpathSync(dirname(candidate)), root);
assert.equal(fs.realpathSync(dirname(canonical)), root);
fs.mkdirSync(candidate);
fs.writeFileSync(join(candidate, 'owner-' + nonce + '.json'), JSON.stringify(owner) + '\n', { flag: 'wx' });
fs.renameSync(candidate, canonical);
const watchdog = setTimeout(() => process.exit(2), 30000);
process.on('disconnect', () => process.exit(3));
process.once('message', message => {
  assert.equal(message, 'exit-without-release');
  clearTimeout(watchdog);
  process.exit(0);
});
process.send({ pid: process.pid, identity, nonce });
