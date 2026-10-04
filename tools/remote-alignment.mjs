#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { compareCorpusContent } from './corpus-content.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const slug = /^[a-z0-9][a-z0-9-]*$/;

function safePath(path) {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.split('/').some((part) => part === '..' || part === '.' || part === '');
}

// Transport is injectable so regression tests use the actual API decoding and
// audit logic without contacting GitHub or relying on a developer's credentials.
export function contentsClient(request) {
  function repoPath(repo) {
    if (!slug.test(repo)) throw new Error(`Invalid repository name: ${repo}`);
    return `repos/Particle-Academy/${repo}`;
  }
  return {
    async head(repo) {
      const body = await request(`${repoPath(repo)}/commits/main`);
      if (!/^[a-f0-9]{40}$/.test(body?.sha ?? '')) throw new Error(`${repo}: main did not resolve to a commit`);
      return body.sha;
    },
    async tree(repo, ref) {
      const body = await request(`${repoPath(repo)}/git/trees/${ref}?recursive=1`);
      if (!body || body.truncated || !Array.isArray(body.tree)) throw new Error(`${repo}: tree is missing, malformed or truncated; copy discovery is incomplete`);
      return body.tree;
    },
    async file(repo, path, ref) {
      if (!safePath(path)) throw new Error(`Invalid repository path: ${path}`);
      const body = await request(`${repoPath(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`);
      if (body === null) return null; // An actual HTTP 404, never a network error.
      if (body.type !== 'file' || body.submodule_git_url || body.target || body.encoding !== 'base64' || typeof body.content !== 'string') {
        throw new Error(`${repo}:${path}: contents response is not an ordinary base64-encoded file`);
      }
      const encoded = body.content.replace(/\s/g, '');
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded) throw new Error(`${repo}:${path}: malformed base64 contents`);
      return bytes;
    },
  };
}

export function ghRequest(endpoint) {
  const result = spawnSync('gh', ['api', '--include', '-H', 'Accept: application/vnd.github+json', endpoint], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
  });
  const output = (result.stdout ?? '').replace(/\r/g, '');
  const status = /^HTTP\/\S+ (\d+)/m.exec(output)?.[1];
  if (status === '404') return null;
  if (result.error || result.status !== 0 || status !== '200') {
    // Never print token-bearing environment or API response bodies on failure.
    throw new Error(`GitHub API ${endpoint}: HTTP ${status ?? 'unavailable'}, process exit ${result.status ?? 'unavailable'} (request not verified)`);
  }
  const split = output.indexOf('\n\n');
  if (split < 0) throw new Error(`GitHub API ${endpoint}: missing response body`);
  return JSON.parse(output.slice(split + 2));
}

export async function auditRemote(suites, api) {
  const result = {
    ok: false, claimedRunners: 0, checkedClaims: 0, verifiedClaims: 0,
    missingFiles: 0, missingClaims: 0, unreferencedFullRunners: 0, unresolvedClaims: 0,
    discoveredCopies: 0, verifiedCopies: 0, staleCopies: 0,
    failures: [], snapshots: {}, evidence: [],
  };
  const byId = new Map(suites.map((suite) => [suite.id, suite]));
  const missingPaths = new Set();
  const claims = [];
  for (const suite of suites) {
    for (const [language, implementation] of Object.entries(suite.implementations)) {
      if (!implementation.runner) continue; // cause/gap remains guard-corpus's responsibility.
      result.claimedRunners++;
      const match = /^([a-z0-9-]+):(.+)$/.exec(implementation.runner);
      if (!match || !safePath(match[2])) {
        result.unresolvedClaims++;
        result.failures.push(`${suite.id}/${language}: invalid runner locator ${implementation.runner}`);
        continue;
      }
      claims.push({ suite: suite.id, language, status: implementation.status, repo: match[1], path: match[2] });
    }
  }
  if (result.claimedRunners === 0) result.failures.push('No runner claims discovered; the audit verified nothing.');
  for (const repo of new Set(claims.map((claim) => claim.repo))) {
    const repoClaims = claims.filter((claim) => claim.repo === repo);
    let ref;
    try {
      ref = await api.head(repo);
      result.snapshots[repo] = ref;
    } catch (error) {
      result.unresolvedClaims += repoClaims.length;
      result.failures.push(error.message);
      continue;
    }
    const cache = new Map();
    const read = (path) => {
      if (!cache.has(path)) cache.set(path, Promise.resolve().then(() => api.file(repo, path, ref)));
      return cache.get(path);
    };
    const loaded = [];
    for (const claim of repoClaims) {
      try {
        const bytes = await read(claim.path);
        if (bytes === null) {
          result.checkedClaims++;
          result.missingClaims++;
          missingPaths.add(`${repo}:${claim.path}`);
          result.missingFiles = missingPaths.size;
          result.failures.push(`MISSING ${claim.suite}/${claim.language}: ${repo}:${claim.path}@${ref}`);
        } else loaded.push({ ...claim, text: bytes.toString('utf8') });
      } catch (error) {
        result.unresolvedClaims++;
        result.failures.push(`${claim.suite}/${claim.language}: ${error.message}`);
      }
    }
    const fixtureNames = new Map();
    let discoveryComplete = true;
    const mentionedJson = new Set(loaded.flatMap(({ text }) => [...text.matchAll(/['"`]([^'"`\n]+\.json)['"`]/g)].map((match) => basename(match[1]))));
    // A tree request discovers copies without one directory request per level.
    // Fetch cases.json, suite-named/corpus-named fixtures and literal JSON paths
    // mentioned by runners. Git blob hashes also discover byte-identical aliases.
    const canonicalBlobs = new Map(suites.map(({ id, bytes }) => [createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), id]));
    try {
      const tree = await api.tree(repo, ref);
      for (const entry of tree) {
        if (entry.type !== 'blob' || !entry.path.endsWith('.json')) continue;
        // These are the sources being compared, not independently vendored copies.
        if (repo === 'prism-parity' && /^suites\/[^/]+\/cases\.json$/.test(entry.path)) continue;
        const name = basename(entry.path);
        const namedSuite = byId.get(name.slice(0, -5));
        if (name !== 'cases.json' && !namedSuite && !/corpus/i.test(name) && !mentionedJson.has(name) && !canonicalBlobs.has(entry.sha)) continue;
        const bytes = await read(entry.path);
        if (bytes === null) throw new Error(`${repo}:${entry.path}: tree-listed copy missing from contents response`);
        let document;
        try { document = JSON.parse(bytes.toString('utf8')); }
        catch { throw new Error(`${repo}:${entry.path}: candidate corpus is not JSON`); }
        const suite = byId.get(document?.suite);
        if (!suite) {
          if (namedSuite || name === 'cases.json') throw new Error(`${repo}:${entry.path}: corpus copy has no recognized suite id`);
          continue; // A referenced config JSON is not a corpus copy.
        }
        result.discoveredCopies++;
        fixtureNames.set(suite.id, [...(fixtureNames.get(suite.id) ?? []), name]);
        const compared = compareCorpusContent(suite.bytes, bytes);
        if (compared.matches) result.verifiedCopies++;
        else {
          result.staleCopies++;
          result.failures.push(`STALE ${repo}:${entry.path} (${suite.id}): expected ${compared.expected}, received ${compared.actual}`);
        }
      }
    } catch (error) {
      discoveryComplete = false;
      result.failures.push(`COPY DISCOVERY ${repo}@${ref}: ${error.message}`);
    }
    for (const claim of loaded) {
      const references = [claim.suite, ...(fixtureNames.get(claim.suite) ?? [])];
      if (claim.status === 'full' && !references.some((reference) => claim.text.includes(reference))) {
        if (!discoveryComplete) {
          result.unresolvedClaims++;
          result.failures.push(`UNRESOLVED REFERENCE ${claim.suite}/${claim.language}: copy discovery did not complete`);
          continue;
        }
        result.unreferencedFullRunners++;
        result.failures.push(`NO CORPUS REFERENCE ${claim.suite}/${claim.language}: ${repo}:${claim.path}@${ref}`);
      } else {
        result.verifiedClaims++;
        result.evidence.push(`${claim.suite}/${claim.language}: ${repo}:${claim.path}@${ref} (file exists${claim.status === 'full' ? ', corpus reference found' : ', partial status'})`);
      }
      result.checkedClaims++;
    }
  }
  result.ok = result.failures.length === 0;
  return result;
}

export function summary(result) {
  return `Remote alignment: ${result.verifiedClaims} runner claims verified; ${result.missingFiles} runner files missing (${result.missingClaims} claims); ` +
    `${result.unreferencedFullRunners} full runner claims without corpus references; ${result.unresolvedClaims} claims unresolved ` +
    `(${result.checkedClaims} checked of ${result.claimedRunners} declared).\n` +
    `Corpus copies: ${result.verifiedCopies} verified, ${result.staleCopies} stale of ${result.discoveredCopies} discovered.`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const suites = readdirSync(join(root, 'suites')).map((id) => ({
    ...JSON.parse(readFileSync(join(root, 'suites', id, 'manifest.json'), 'utf8')),
    bytes: readFileSync(join(root, 'suites', id, 'cases.json')),
  }));
  const result = await auditRemote(suites, contentsClient(ghRequest));
  for (const [repo, ref] of Object.entries(result.snapshots)) console.log(`SNAPSHOT ${repo}/main ${ref}`);
  for (const evidence of result.evidence) console.log(`VERIFIED ${evidence}`);
  for (const failure of result.failures) console.error(failure);
  console.log(summary(result));
  console.log(result.ok ? 'Remote alignment passed.' : 'Remote alignment failed.');
  process.exitCode = result.ok ? 0 : 1;
}
