#!/usr/bin/env node
// Execute one native implementation against the cross-origin-redirect corpus,
// then compare or explicitly record its column.
//
//   node tools/cross-origin-redirect.mjs php|ts|py --check|--record
//
// Each row gets three loopback servers: the configured endpoint, another host
// and the endpoint's host on another port. The endpoint answers its first
// request with the row's redirect and everything else with 500. The
// observation is read off the servers, never off the SDK.
//
// PHP runs against PRISM_PHP_SRC (a prism checkout) when it is set, otherwise
// against the installed reference in runners/php. TypeScript reads
// PRISM_TS_DIST or the built sibling prism-ts/dist; Python imports PRISM_PY_SRC
// or the installed package.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { execute } from './cross-origin-redirect/ts.mjs';
import { crossOriginRedirectFailures } from './cross-origin-redirect/contract.mjs';
import { rowServers, observation, closeAll } from './cross-origin-redirect/servers.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [language, action] = process.argv.slice(2);
assert(['php', 'ts', 'py'].includes(language) && ['--check', '--record'].includes(action) && process.argv.length === 4,
  'Usage: node tools/cross-origin-redirect.mjs php|ts|py --check|--record');
const file = process.env.CROSS_ORIGIN_REDIRECT_CASES ?? join(root, 'suites/cross-origin-redirect/cases.json');
const document = JSON.parse(readFileSync(file, 'utf8'));

const servers = [];
const rows = [];
try {
  for (const entry of document.cases) {
    const { provider, status, target } = entry.given;
    const set = await rowServers(target, status);
    const prefix = provider.toUpperCase();
    // A synthetic key per row, shaped so a leak is recognisable.
    const credential = `sk-parity-redirect-${entry.id}-fixture-never-real`;
    servers.push({ set, credential });
    rows.push({ id: entry.id, provider, env: { [`${prefix}_URL`]: `${set.endpoint.origin}/v1`, [`${prefix}_API_KEY`]: credential } });
  }

  const input = { environment_names: document.environment_names, rows };
  if (language === 'ts') {
    await execute(document, rows, process.env.PRISM_TS_DIST ?? resolve(root, '../prism-ts/dist'));
  } else {
    const command = language === 'php' ? process.env.PRISM_PHP_BINARY ?? 'php' : process.env.PRISM_PY_BINARY ?? 'python';
    const driver = join(root, 'tools/cross-origin-redirect', language === 'php' ? 'php.php' : 'py.py');
    // Asynchronous: the servers answer from this process's event loop.
    const status = await run(command, [driver], JSON.stringify(input));
    assert.equal(status, 0, 'Native cross-origin-redirect driver failed.');
  }

  const stale = [];
  for (const [index, entry] of document.cases.entries()) {
    const observed = observation(servers[index].set, servers[index].credential);
    if (!equal(entry.result[language], observed)) stale.push(entry.id);
    entry.result[language] = observed;
  }
  for (const entry of document.cases) {
    entry.agrees = ['php', 'ts', 'py'].every(name => entry.result[name] !== null && equal(entry.result.php, entry.result[name]));
  }
  const problems = crossOriginRedirectFailures(document, { allowIncomplete: action === '--record' });
  assert.equal(problems.length, 0, problems.join('\n'));
  if (action === '--check') {
    assert.equal(stale.length, 0, `Stale ${language} cross-origin-redirect rows: ${stale.join(', ')}`);
  } else writeFileSync(file, JSON.stringify(document, null, 4) + '\n');
  console.log(`cross-origin-redirect ${language}: ${rows.length} executed; ${stale.length} changed; ${action.slice(2)} passed.`);
} finally {
  await Promise.all(servers.map(({ set }) => closeAll(set)));
}

function run(command, args, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    const timer = setTimeout(() => child.kill(), 300_000);
    child.stdout.resume();
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolvePromise(code); });
    child.stdin.end(input);
  });
}

function equal(left, right) {
  try { assert.deepEqual(left, right); return true; } catch { return false; }
}
