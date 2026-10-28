import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

export function windowsIdentity() {
  const source = fs.readFileSync(new URL('./windows-identity.cs', import.meta.url), 'utf8');
  const command = "$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n" + source + "\n'@\n$realm = [PrismLockIdentityReview]::HostRealm()\n$boot = (CimCmdlets\\Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime\nif ($null -eq $boot) { throw 'Missing LastBootUpTime' }\n@{ realm = $realm; boot_ticks = $boot.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) } | ConvertTo-Json -Compress";
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)));
  const child = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { env, encoding: 'utf8', timeout: 30000, maxBuffer: 65536, windowsHide: true });
  if (child.error || child.status !== 0) throw new Error('Windows identity query failed: ' + (child.error?.code ?? child.status));
  const output = JSON.parse(child.stdout.trim());
  assert.match(output.boot_ticks, /^[1-9][0-9]{0,18}$/);
  return { platform: 'win32', boot_id: 'cim-utc-ticks:' + output.boot_ticks, pid_namespace: output.realm === 'win32:kernel' ? output.realm : null };
}
