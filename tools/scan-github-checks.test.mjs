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

const newer = 'b'.repeat(40);
const policyMain = 'c'.repeat(40);
const newerPin = { sha: newer, hashes: { ...config.pin.hashes, 'third-party/allowlist.json': '2'.repeat(64) } };
const scopedConfig = { ...config, repositories: [{ name: 'prism' }, { name: 'prism-human-plus' }], pinOverrides: { 'prism-human-plus': newerPin } };

function scopedTransport({ pin = newerPin, listed = true, relation = 'ahead', onMain = true, main = policyMain, badMergeBase = false, apiError = false } = {}) {
  const paths = [];
  const request = async (endpoint) => {
    paths.push(endpoint);
    if (endpoint === 'repos/Particle-Academy/.github/commits/main') return { sha: main };
    if (endpoint.startsWith('repos/Particle-Academy/.github/compare/')) {
      if (apiError) throw new Error('GitHub 403: ancestry is UNCHECKED');
      const [base, head] = endpoint.split('/compare/')[1].split('...');
      const status = base === sha ? relation : !onMain ? 'diverged' : base === head ? 'identical' : 'ahead';
      return { status, ahead_by: status === 'ahead' ? 1 : 0, behind_by: ['ahead', 'identical'].includes(status) ? 0 : 1, base_commit: { sha: base }, merge_base_commit: { sha: badMergeBase ? 'd'.repeat(40) : base } };
    }
    if (endpoint.startsWith('orgs/')) return [repo('prism'), repo('prism-human-plus')];
    if (endpoint.includes('/commits/')) return { sha };
    const human = endpoint.includes('/prism-human-plus/');
    const workflow = rewriteWorkflow(original, config, { ...(human ? pin : config.pin), files }).text;
    if (endpoint.includes('/git/trees/')) return { truncated: false, tree: [{ path: '.github/workflows/ci.yml', type: 'blob', mode: '100644', sha, size: Buffer.byteLength(workflow) }] };
    if (endpoint.includes('/git/blobs/')) return { encoding: 'base64', content: Buffer.from(workflow).toString('base64'), size: Buffer.byteLength(workflow) };
    throw new Error(`Unexpected scoped API path: ${endpoint}`);
  };
  return { config: listed ? scopedConfig : { ...scopedConfig, pinOverrides: {} }, request, paths };
}

test('global-equal pins pass and every repository reports its effective pin', async () => {
  const result = await auditInventory({ config, ...transport() });
  assert.deepEqual(result.repositories.map((row) => row.pin), [sha, sha]);
});

test('only the listed newer descendant gets its exact pin and hashes', async () => {
  const api = scopedTransport();
  const result = await auditInventory(api);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.repositories.map((row) => [row.name, row.pin]), [['prism', sha], ['prism-human-plus', newer]]);
  assert.equal(result.policyMain, policyMain);
  assert.ok(api.paths.includes(`repos/Particle-Academy/.github/compare/${sha}...${newer}`));
  assert.ok(api.paths.includes(`repos/Particle-Academy/.github/compare/${newer}...${policyMain}`));
});

test('an unlisted different pin refuses instead of accepting its self-declared verifier', async () => {
  const result = await auditInventory(scopedTransport({ listed: false }));
  assert.ok(result.failures.some((failure) => failure.includes('prism-human-plus/') && failure.includes('[ref-drift]')));
});

test('a listed newer pin can be the exact current main snapshot', async () => {
  const result = await auditInventory(scopedTransport({ main: newer }));
  assert.deepEqual(result.failures, []);
  assert.equal(result.policyMain, newer);
});

test('an equal-SHA override must retain the exact global hashes', async () => {
  const api = scopedTransport({ pin: config.pin });
  const result = await auditInventory({ ...api, config: { ...scopedConfig, pinOverrides: { 'prism-human-plus': config.pin } } });
  assert.deepEqual(result.failures, []);
  assert.ok(api.paths.every((endpoint) => !endpoint.includes('/.github/')));
  await assert.rejects(auditInventory({ ...api, config: { ...scopedConfig, pinOverrides: { 'prism-human-plus': { ...newerPin, sha } } } }), /equal-SHA.*different hashes/);
});

test('listed older, diverged or unproven descendants fail closed', async () => {
  for (const relation of ['behind', 'diverged', 'identical']) {
    await assert.rejects(auditInventory(scopedTransport({ relation })), /newer descendant/);
  }
  await assert.rejects(auditInventory(scopedTransport({ badMergeBase: true })), /newer descendant/);
  await assert.rejects(auditInventory(scopedTransport({ apiError: true })), /UNCHECKED/);
});

test('a listed newer commit absent from main refuses', async () => {
  await assert.rejects(auditInventory(scopedTransport({ onMain: false })), /on.*main/);
});

test('a listed newer pin cannot substitute different input hashes', async () => {
  const pin = { ...newerPin, hashes: { ...newerPin.hashes, 'third-party/check.mjs': '9'.repeat(64) } };
  const result = await auditInventory(scopedTransport({ pin }));
  assert.ok(result.failures.some((failure) => failure.includes('[hash-drift]')));
});

test('malformed or unknown repository overrides refuse before scanning', async () => {
  for (const pinOverrides of [[], { 'prism-other': newerPin }, { 'prism-human-plus': { sha: newer, hashes: {} } }]) {
    const api = scopedTransport();
    await assert.rejects(auditInventory({ ...api, config: { ...scopedConfig, pinOverrides } }), /override|pin must/);
  }
});

test('policy ancestry APIs stay on the fixed .github main and exact-SHA compare paths', async () => {
  const calls = [];
  const request = apiClient('scoped-token', async (url, options) => { calls.push({ url, options }); return new Response('{}'); });
  await request('repos/Particle-Academy/.github/commits/main');
  await request(`repos/Particle-Academy/.github/compare/${sha}...${newer}`);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.url.startsWith('https://api.github.com/repos/Particle-Academy/.github/') && call.options.redirect === 'error'));
  for (const endpoint of ['repos/Particle-Academy/.github/contents/secret', 'repos/Particle-Academy/.github/commits/topic', 'repos/Particle-Academy/.github/compare/main...topic']) {
    await assert.rejects(request(endpoint), /outside/);
  }
});
