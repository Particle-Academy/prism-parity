import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditInventory, apiClient, checkInventoryWorkflow } from './scan-github-checks.mjs';
import { rewriteWorkflow } from './pin-github-checks.mjs';
import { readFileSync } from 'node:fs';
import { requireVerdict } from './alignment-contracts.mjs';
import { gates } from './gate-contracts.mjs';

const sha = 'a'.repeat(40);
const files = ['third-party/check.mjs', 'third-party/gate-graph.mjs', 'third-party/allowlist.json'];
const config = { repository: 'Particle-Academy/.github', files, pin: { sha, hashes: Object.fromEntries(files.map((f) => [f, '1'.repeat(64)])) }, defaultPermissions: 'read', repositories: [{ name: 'prism' }, { name: 'prism-private' }] };
const original = `on: push
permissions:
  contents: read
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          repository: Particle-Academy/.github
          path: .checks
          persist-credentials: false
      - run: node .checks/third-party/check.mjs
`;
const pinned = rewriteWorkflow(original, config, { ...config.pin, files }).text;
const repo = (name) => ({ name, full_name: `Particle-Academy/${name}`, default_branch: 'main', private: name.endsWith('private') });

function transport({ unknown = false, hidden = false, bad = false, truncated = false, paginated = false } = {}) {
  const paths = [];
  const workflow = bad ? original : pinned;
  const request = async (endpoint) => {
    paths.push(endpoint);
    if (endpoint.startsWith('orgs/')) {
      if (endpoint.endsWith('page=2')) return [repo('prism-private')];
      if (paginated) return [repo('prism'), ...Array.from({ length: 99 }, (_, n) => ({ name: `other-${n}` }))];
      return [repo('prism'), ...(!hidden ? [repo('prism-private')] : []), ...(unknown ? [repo('prism-foo')] : [])];
    }
    if (endpoint.includes('/commits/')) return { sha };
    if (endpoint.includes('/git/trees/')) return { truncated, tree: [{ path: '.github/workflows/ci.yml', type: 'blob', mode: '100644', sha, size: workflow.length }] };
    if (endpoint.includes('/git/blobs/')) return { encoding: 'base64', content: Buffer.from(endpoint.includes('/prism-foo/') ? original : workflow).toString('base64'), size: Buffer.byteLength(endpoint.includes('/prism-foo/') ? original : workflow) };
    throw new Error(`Unexpected test API path: ${endpoint}`);
  };
  return { request, paths };
}

test('live discovery audits unknown repos instead of filtering by the config', async () => {
  const good = await auditInventory({ config, ...transport() });
  assert.equal(good.repositories.length, 2);
  assert.deepEqual(good.failures, []);
  assert.deepEqual(good.unchecked, []);
  const bad = await auditInventory({ config, ...transport({ unknown: true }) });
  assert.equal(bad.repositories.length, 3);
  assert.ok(bad.failures.some((f) => f.includes('prism-foo/') && f.includes('[no-ref]')));
});

test('private invisibility is UNCHECKED and cannot turn into an empty green scan', async () => {
  const result = await auditInventory({ config, ...transport({ hidden: true }) });
  assert.equal(result.unchecked.length, 1);
  assert.match(result.unchecked[0], /prism-private/);
  await assert.rejects(auditInventory({ config, request: async () => [] }), /empty/);
});

test('pagination follows the second page and resolves workflows at exact commits', async () => {
  const api = transport({ paginated: true });
  const result = await auditInventory({ config, ...api });
  assert.equal(result.repositories.length, 2);
  assert.ok(api.paths.some((p) => p.endsWith('page=2')));
  assert.ok(api.paths.some((p) => p.includes(`/git/trees/${sha}?recursive=1`)));
});

test('an unpinned main and a truncated tree fail rather than being ignored', async () => {
  const result = await auditInventory({ config, ...transport({ bad: true }) });
  assert.ok(result.failures.some((f) => f.includes('[no-ref]')));
  await assert.rejects(auditInventory({ config, ...transport({ truncated: true }) }), /truncated/);
});

test('only this parity candidate can substitute for its remote main', async () => {
  const api = transport();
  const candidate = { repository: 'Particle-Academy/prism', sha };
  await auditInventory({ config, ...api, candidate });
  assert.ok(api.paths.includes(`repos/Particle-Academy/prism/commits/${sha}`));
  assert.ok(api.paths.includes('repos/Particle-Academy/prism-private/commits/main'));
});

test('API tokens stay on the fixed host, redirects and HTTP failures refuse', async () => {
  const calls = [];
  const request = apiClient('test-token', async (url, options) => { calls.push({ url, options }); return new Response('[]'); });
  await request('orgs/Particle-Academy/repos?per_page=100&page=1');
  assert.equal(calls[0].url.startsWith('https://api.github.com/'), true);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  await assert.rejects(request('https://evil.example/token'), /outside/);
  const denied = apiClient('secret', async () => new Response('{}', { status: 403 }));
  await assert.rejects(denied('orgs/Particle-Academy/repos?page=1'), /UNCHECKED/);
});

test('the standing CI gate cannot be removed, skipped or elevated to a private inventory credential', () => {
  const workflow = readFileSync(new URL('../.github/workflows/alignment.yml', import.meta.url), 'utf8');
  assert.deepEqual(checkInventoryWorkflow(workflow), []);
  for (const mutant of [
    workflow.replace('pin-github-checks.mjs --check --repo .', 'pin-github-checks.mjs --inventory --repo .'),
    workflow.replace('name: Live organization shared-check inventory', 'name: Live organization shared-check inventory\n        if: false'),
    workflow.replace('github.token', 'secrets.PRIVATE_TOKEN'),
    workflow.replace('scan-github-checks.mjs --check', 'scan-github-checks.mjs --inventory'),
  ]) assert.ok(checkInventoryWorkflow(mutant).length > 0);
});

test('the no-CI envelope is an explicit reasoned exclusion, with no general escape hatch', async () => {
  const excludedConfig = { ...config, repositories: [...config.repositories, { name: 'prism.agi' }], exclusions: [{ name: 'prism.agi', reason: 'Workspace envelope drives CI; it has no CI workflows.' }] };
  const result = await auditInventory({ config: excludedConfig, ...transport() });
  assert.equal(result.excluded.length, 1);
  assert.deepEqual(result.unchecked, []);
  await assert.rejects(auditInventory({ config: { ...config, exclusions: [{ name: 'prism-private', reason: 'Skip' }] }, ...transport() }), /Only the explicitly/);
  await assert.rejects(auditInventory({ config: { ...config, exclusions: [{ name: 'prism.agi', reason: '' }] }, ...transport() }), /Only the explicitly/);
});

test('inventory verdicts require positive work and zero unchecked repositories', () => {
  const output = 'Shared-check inventory: 37 repos, 120 workflows, 105 shared check workflows; 0 failures, 0 unchecked.\nShared-check inventory passed.';
  assert.doesNotThrow(() => requireVerdict('pinInventory', { status: 0, stdout: output }, gates.pinInventory));
  for (const stdout of ['', output.replace('37 repos', '0 repos'), output.replace('0 unchecked', '2 unchecked')]) {
    assert.throws(() => requireVerdict('pinInventory', { status: 0, stdout }, gates.pinInventory));
  }
});
