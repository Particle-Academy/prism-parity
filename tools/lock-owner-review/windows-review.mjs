import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const nativeSource = fs.readFileSync(new URL('./windows-native.cs', import.meta.url), 'utf8');
// Source and command are fixed checked-in code. Paths/arguments travel as JSON
// on stdin; they are never interpolated into PowerShell or a shell command.
const bootstrap = "Add-Type -TypeDefinition @'\n" + nativeSource + "\n'@\n";
const allowedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)));

function powershell(command, input, timeout = 30000) {
  const child = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'\n" + bootstrap + command], { input: JSON.stringify(input), env: allowedEnv, encoding: 'utf8', timeout, maxBuffer: 65536, windowsHide: true });
  if (child.error || child.status !== 0) throw new Error('Windows native review failed: ' + (child.error?.code ?? child.status) + '\n' + child.stderr);
  return JSON.parse(child.stdout.trim());
}

export function windowsIdentity() {
  const output = powershell("$realm = [PrismLockNativeReview]::HostRealm()\n$boot = (CimCmdlets\\Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime\nif ($null -eq $boot) { throw 'Missing LastBootUpTime' }\n@{ realm = $realm; boot_ticks = $boot.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) } | ConvertTo-Json -Compress", null);
  assert.match(output.boot_ticks, /^[1-9][0-9]{0,18}$/);
  return { platform: 'win32', boot_id: 'cim-utc-ticks:' + output.boot_ticks, pid_namespace: output.realm === 'win32:kernel' ? output.realm : null };
}

function launch(args, depth, requireNoJob, breakaway) {
  return powershell("$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json\n[PrismLockNativeReview]::Launch($inputData.exe, [string[]]$inputData.args, $inputData.cwd, [int]$inputData.depth, [bool]$inputData.require_no_job, [bool]$inputData.breakaway)", { exe: process.execPath, args, cwd: process.cwd(), depth, require_no_job: requireNoJob, breakaway }, 75000);
}

export function inheritedJobCase() {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'prism-lock-inherited-'));
  const report = join(root, 'child.json');
  const script = fileURLToPath(new URL('./identity-recovery.mjs', import.meta.url));
  // The caller is already in the owned supervisor Job made below. Do not
  // break away; inherit its chain, then add one owned ordinary Job.
  const native = launch([script, '--native-job-child', report], 1, false, false);
  assert.equal(native.initial_no_job, false);
  assert.equal(native.breakaway_requested, false);
  assert.equal(native.verified_owned_job_depth, 1);
  const proof = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(proof.identity.pid_namespace, 'win32:kernel');
  assert.equal(proof.dead.result, 'nonce-bound-reclaimed');
  return { name: 'inherited-supervisor-job', native, proof };
}

export function windowsJobCases(ambientDiagnostic = false) {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'prism-lock-jobs-'));
  const script = fileURLToPath(new URL('./identity-recovery.mjs', import.meta.url));
  const rows = [], failures = [];
  for (const [name, depth] of [['no-job', 0], ['ordinary-job', 1], ['nested-job', 2]]) {
    if (ambientDiagnostic && depth === 0) continue;
    try {
      const report = join(root, name + '.json');
      const native = launch([script, '--native-job-child', report], depth, !ambientDiagnostic, true);
      if (!ambientDiagnostic) assert.equal(native.initial_no_job, true);
      assert.equal(native.verified_owned_job_depth, depth); assert.equal(native.exit, 0);
      const proof = JSON.parse(fs.readFileSync(report, 'utf8'));
      assert.equal(proof.identity.pid_namespace, 'win32:kernel');
      assert.equal(proof.dead.result, 'nonce-bound-reclaimed');
      assert.equal(proof.held.length, 3);
      rows.push({ name, native, proof });
    } catch (error) { failures.push({ name, error: error.message }); }
  }
  // The fourth configuration always has an actual inherited supervisor Job,
  // even if the hosted runner itself has none. Locally it also inherits Genie.
  // Its controller and child both keep the ambient chain; no limits are changed.
  try {
    const report = join(root, 'inherited-controller.json');
    const supervisor = launch([script, '--inherited-job-controller', report], 1, false, false);
    const inherited = JSON.parse(fs.readFileSync(report, 'utf8'));
    rows.push({ ...inherited, supervisor });
  } catch (error) { failures.push({ name: 'inherited-supervisor-job', error: error.message }); }
  return { platform: 'win32', rows, failures, no_job: ambientDiagnostic ? 'unmeasured under ambient supervisor Job; diagnostic cannot pass required gate' : (rows.some(row => row.name === 'no-job') ? 'measured' : 'setup-failed'), container_path: 'unmeasured; no container created', fixture: root };
}
