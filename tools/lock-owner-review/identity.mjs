import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { windowsIdentity } from './windows-review.mjs';

function query(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 65536, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Native identity query failed: ' + command);
  return result.stdout.trim();
}

function uuid(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid native boot UUID');
  return value.toLowerCase();
}

// Review experiment only. Identity setup errors must fail a positive CI row.
export function nativeIdentity() {
  if (process.platform === 'linux') {
    const realm = fs.readlinkSync('/proc/self/ns/pid');
    if (!/^pid:\[[0-9]+\]$/.test(realm)) throw new Error('Invalid Linux PID namespace');
    return { platform: 'linux', boot_id: uuid(fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()), pid_namespace: realm };
  }
  if (process.platform === 'darwin') {
    return { platform: 'darwin', boot_id: uuid(query('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'])), pid_namespace: 'darwin:kernel' };
  }
  if (process.platform === 'win32') return windowsIdentity();
  throw new Error('Native review identity is not implemented for ' + process.platform);
}
