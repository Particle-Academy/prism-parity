#!/usr/bin/env node
// Inspect workflows as data. Never checkout or execute a remote repository.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWorkflow, resolveExpected } from './pin-github-checks.mjs';
import { parseYaml } from './pin-github-checks-structure.mjs';

const repoName = /^prism[a-z0-9_.-]*$/i;
const shaPattern = /^[0-9a-f]{40}$/;
const organization = 'Particle-Academy';
const here = path.dirname(fileURLToPath(import.meta.url));

export function checkInventoryWorkflow(text) {
  const steps = parseYaml(text)?.jobs?.alignment?.steps || [];
  const local = steps.filter((step) => step.run === 'node tools/run-gate.mjs pins -- node tools/pin-github-checks.mjs --check --repo .');
  const live = steps.filter((step) => step.run === 'node tools/run-gate.mjs pinInventory -- node tools/scan-github-checks.mjs --check');
  const failures = [];
  if (local.length !== 1 || local[0].if || local[0]['continue-on-error']) failures.push('local pin checker must run unconditionally and fail closed');
  if (live.length !== 1 || live[0].if || live[0]['continue-on-error']) failures.push('live inventory must run unconditionally and fail closed');
  if (live.length === 1 && live[0].env?.GH_TOKEN !== '${{ github.token }}') failures.push('live inventory must use the ordinary read-only workflow token');
  return failures;
}

// Overrides are reviewed pins, never pins learned from the scanned workflow.
// A newer exception must remain on main; an older one could retain a revoked
// dependency approval. Resolve main once so both comparisons use one snapshot.
async function repositoryPins(config, expected, request) {
  const configured = config.pinOverrides ?? {};
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) throw new Error('Invalid repository pin overrides');
  const known = new Set((config.repositories || []).map((repo) => repo.name));
  const pins = new Map();
  let policyMain;
  for (const [name, pin] of Object.entries(configured)) {
    if (!repoName.test(name) || !known.has(name) || name === 'prism.agi') throw new Error(`Unknown repository pin override: ${name}`);
    const override = resolveExpected({ files: config.files, pin });
    if (!override) throw new Error(`${name}: override requires an immutable pin`);
    if (override.sha === expected.sha) {
      if (config.files.some((file) => override.hashes[file] !== expected.hashes[file])) throw new Error(`${name}: equal-SHA override has different hashes`);
      pins.set(name, expected);
      continue;
    }
    if (!policyMain) {
      const commit = await request('repos/Particle-Academy/.github/commits/main');
      policyMain = commit?.sha;
      if (!shaPattern.test(policyMain || '')) throw new Error('Invalid .github main identity; overrides are UNCHECKED');
    }
    const compare = async (base, head, statuses) => {
      const result = await request(`repos/Particle-Academy/.github/compare/${base}...${head}`);
      return statuses.includes(result?.status) && result?.base_commit?.sha === base && result?.merge_base_commit?.sha === base &&
        result?.behind_by === 0 && Number.isSafeInteger(result?.ahead_by) &&
        (result.status === 'ahead' ? result.ahead_by > 0 : result.ahead_by === 0 && base === head);
    };
    if (!await compare(expected.sha, override.sha, ['ahead'])) throw new Error(`${name}: override must be a newer descendant of the global pin`);
    if (!await compare(override.sha, policyMain, ['ahead', 'identical'])) throw new Error(`${name}: override must be on .github main`);
    pins.set(name, override);
  }
  return { pins, policyMain };
}

export async function auditInventory({ config, request, candidate }) {
  const expected = resolveExpected(config);
  if (!expected) throw new Error('The standing scan requires an immutable expected pin');
  const effective = await repositoryPins(config, expected, request);
  const repos = new Map();
  let complete = false;
  for (let page = 1; page <= 100; page++) {
    const batch = await request(`orgs/${organization}/repos?type=all&per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length > 100) throw new Error('Invalid organization inventory page');
    for (const repo of batch) {
      if (!repoName.test(repo?.name || '')) continue;
      if (repo.full_name !== `${organization}/${repo.name}` || typeof repo.default_branch !== 'string' || !repo.default_branch) throw new Error('Invalid Prism repository identity');
      if (repos.has(repo.name)) throw new Error(`Duplicate inventory entry: ${repo.name}; retry a stable scan`);
      repos.set(repo.name, repo);
    }
    if (batch.length < 100) { complete = true; break; }
  }
  if (!complete || !repos.size) throw new Error('Organization enumeration incomplete or empty');
  const result = { pin: expected.sha, ...(effective.policyMain ? { policyMain: effective.policyMain } : {}), repositories: [], workflows: 0, referencing: 0, failures: [], unchecked: [] };
  const exclusions = new Map();
  for (const exclusion of config.exclusions || []) {
    if (exclusion.name !== 'prism.agi' || typeof exclusion.reason !== 'string' || !exclusion.reason.trim() || exclusions.has(exclusion.name)) throw new Error('Only the explicitly documented no-CI envelope may be excluded');
    exclusions.set(exclusion.name, exclusion.reason);
  }
  result.excluded = [...exclusions].map(([name, reason]) => ({ name, reason }));
  for (const known of config.repositories || []) {
    if (!repoName.test(known.name || '')) throw new Error('Invalid configured repository name');
    if (!repos.has(known.name) && !exclusions.has(known.name)) result.unchecked.push(`${known.name}: configured repository invisible to inventory token`);
  }
  for (const repo of [...repos.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (exclusions.has(repo.name)) continue;
    const base = `repos/${organization}/${repo.name}`;
    const ref = candidate?.repository === repo.full_name ? candidate.sha : repo.default_branch;
    const commit = await request(`${base}/commits/${encodeURIComponent(ref)}`);
    const sha = commit?.sha;
    if (!shaPattern.test(sha || '')) throw new Error(`${repo.name}: invalid commit identity`);
    if (candidate?.repository === repo.full_name && sha !== candidate.sha) throw new Error('Candidate SHA mismatch');
    const tree = await request(`${base}/git/trees/${sha}?recursive=1`);
    if (!Array.isArray(tree?.tree) || tree.truncated !== false) throw new Error(`${repo.name}: missing or truncated tree`);
    const workflows = tree.tree.filter((entry) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(entry.path || ''));
    if (workflows.length > 200) throw new Error(`${repo.name}: workflow discovery exceeded its bound`);
    const pin = effective.pins.get(repo.name) || expected;
    const summary = { name: repo.name, private: repo.private, sha, pin: pin.sha, workflows: workflows.length, referencing: 0 };
    for (const entry of workflows) {
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || !shaPattern.test(entry.sha || '') || entry.size > 1024 * 1024) throw new Error(`${repo.name}/${entry.path}: unsupported workflow entry`);
      const blob = await request(`${base}/git/blobs/${entry.sha}`);
      if (blob?.encoding !== 'base64' || typeof blob.content !== 'string' || blob.size > 1024 * 1024) throw new Error(`${repo.name}/${entry.path}: unsupported workflow blob`);
      const bytes = Buffer.from(blob.content, 'base64');
      if (bytes.length !== blob.size) throw new Error(`${repo.name}/${entry.path}: incomplete workflow blob`);
      const check = checkWorkflow(bytes.toString('utf8'), config, pin);
      result.workflows++;
      if (check.refs) { result.referencing++; summary.referencing++; }
      for (const problem of check.problems) result.failures.push(`${repo.name}/${entry.path} (${problem.where}) [${problem.code}] ${problem.message}`);
    }
    result.repositories.push(summary);
  }
  return result;
}

// No API host, URL or executable comes from repository content. A token is used
// only for api.github.com and is never printed or passed to a child process.
export function apiClient(token, fetcher = fetch) {
  return async (endpoint) => {
    const inventory = /^(orgs\/Particle-Academy\/repos\?|repos\/Particle-Academy\/prism[a-z0-9_.-]*\/)/i.test(endpoint);
    const policy = /^repos\/Particle-Academy\/\.github\/(commits\/main|compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40})$/.test(endpoint);
    if (!inventory && !policy) throw new Error('Refusing API path outside Prism inventory and exact policy ancestry');
    const response = await fetcher(`https://api.github.com/${endpoint}`, {
      headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub ${response.status} reading ${endpoint.split('?')[0]}; inventory is UNCHECKED`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) throw new Error('API response exceeds inventory bound');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
}

export async function main(argv, { request, log = console.log, env = process.env } = {}) {
  if (argv.length !== 1 || argv[0] !== '--check') throw new Error('Usage: node tools/scan-github-checks.mjs --check');
  const config = JSON.parse(fs.readFileSync(path.join(here, 'pin-github-checks.config.json'), 'utf8'));
  const candidate = env.GITHUB_REPOSITORY === `${organization}/prism-parity` && shaPattern.test(env.GITHUB_SHA || '')
    ? { repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA } : undefined;
  const result = await auditInventory({ config, request: request || apiClient(env.GH_TOKEN), candidate });
  for (const row of result.repositories) log(`CHECKED ${row.name}@${row.sha}: ${row.workflows} workflows, ${row.referencing} shared check workflows; policy pin ${row.pin}`);
  for (const row of result.excluded) log(`EXCLUDED ${row.name}: ${row.reason}`);
  for (const failure of result.failures) log(`FAIL ${failure}`);
  for (const unchecked of result.unchecked) log(`UNCHECKED ${unchecked}`);
  log(`Shared-check inventory: ${result.repositories.length} repos, ${result.workflows} workflows, ${result.referencing} shared check workflows; ${result.failures.length} failures, ${result.unchecked.length} unchecked.`);
  if (result.failures.length || result.unchecked.length) return 1;
  log('Shared-check inventory passed.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`Shared-check inventory UNCHECKED: ${error.message}`);
    process.exitCode = 1;
  });
}
