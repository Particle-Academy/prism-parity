// Source evidence only. This job never supplies a published-reference verdict.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateCandidateRefs, verifyCandidateTrees } from './candidate-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const refs = validateCandidateRefs(JSON.parse(readFileSync(join(root, 'tools/satellite-policy/candidate-refs.json'))));
const directory = join(root, '.satellite-candidate');
assert(!existsSync(directory), 'Existing candidate evidence cannot be reused');
const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, 'Candidate source identity could not be checked');
  return result.stdout.trim();
};
verifyCandidateTrees(root, refs, git);
mkdirSync(directory);
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
env.PRISM_POLICY_BROWSER_AUTOLOAD = resolve(root, '../prism-browser/vendor/autoload.php');
env.PRISM_POLICY_HUMAN_AUTOLOAD = resolve(root, '../prism-human-plus/vendor/autoload.php');
env.PRISM_POLICY_BROWSER_TS_DIST = resolve(root, '../prism-browser-ts/dist/index.js');
env.PRISM_POLICY_HUMAN_TS_DIST = resolve(root, '../prism-human-plus-ts/dist/index.js');
env.PRISM_POLICY_BROWSER_PY_SRC = resolve(root, '../prism-browser-py/src');
env.PRISM_POLICY_HUMAN_PY_SRC = resolve(root, '../prism-human-plus-py/src');
const rows = [];
for (const language of ['php', 'ts', 'py']) {
  const result = spawnSync(process.execPath, [join(root, 'tools/run-gate.mjs'), 'satellitePolicy', '--', process.execPath, join(root, 'tools/satellite-policy.mjs'), language, '--check'], { cwd: root, env, encoding: 'utf8', timeout: 120000, maxBuffer: 8*1024*1024, windowsHide: true });
  writeFileSync(join(directory, language+'.stdout.log'), result.stdout ?? '', { flag: 'wx' });
  writeFileSync(join(directory, language+'.stderr.log'), result.stderr ?? '', { flag: 'wx' });
  assert.equal(result.status, 0, 'Inspect candidate '+language+' logs');
  assert.match(result.stdout, new RegExp('satellite-policy '+language+': 232 executed; 0 changed; independent predictions and check passed\\.'));
  const digest = value => createHash('sha256').update(value ?? '').digest('hex');
  rows.push({ language, exit: result.status, stdoutSha256: digest(result.stdout), stderrSha256: digest(result.stderr) });
  process.stdout.write(result.stdout);
}
writeFileSync(join(directory, 'report.json'), JSON.stringify({ referenceKind: 'candidate-source', platform: process.platform, packages: refs.packages, observations: 696, rows, publishedReferenceVerified: false }, null, 2)+'\n', { flag: 'wx' });
console.log('Satellite candidate source passed: 232 cases in each language; published reference remains pending.');
