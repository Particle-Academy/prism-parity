#!/usr/bin/env node
// Execute one native implementation against the media-fetch-guard WIRE rows,
// then compare or explicitly record its column (G-386).
//
//   node tools/media-fetch-guard.mjs php|ts|py --check|--record
//
// A wire row (`transport: "default"`) is the one kind of media-fetch-guard row
// the languages' own corpus runners cannot measure: they stub the HTTP client,
// so a url whose host the guard reads one way and the client reads another is
// recorded by what the guard decided, not by where the client connected. Here
// the row's `{port}` is replaced with a raw TCP loopback server started for that
// row, the resolver answers `answers_any` for every name (an attacker's own DNS
// zone), and the fetch runs over each language's REAL default transport.
// `dispatched` is whether that server received a connection, read off the
// server. Every other row stays with the in-repository runners.
//
// PHP runs against PRISM_PHP_SRC (a prism checkout) when it is set, otherwise
// against the installed reference in runners/php. TypeScript reads
// PRISM_TS_DIST or the built sibling prism-ts/dist; Python imports PRISM_PY_SRC
// or the installed package. MEDIA_FETCH_GUARD_CASES reads a different copy of
// the corpus, for a negative control against unchanged code.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { observe } from './media-fetch-guard/ts.mjs';
import { startServer } from './cross-origin-redirect/servers.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const LANGUAGES = ['php', 'ts', 'py'];
const WIRE = 'default';
const REFUSALS = [null, 'scheme_not_allowed', 'private_address_refused', 'host_did_not_resolve', 'redirect_refused', 'too_many_redirects', 'non_ascii_host_use_punycode'];
const [language, action] = process.argv.slice(2);
assert(LANGUAGES.includes(language) && ['--check', '--record'].includes(action) && process.argv.length === 4,
  'Usage: node tools/media-fetch-guard.mjs php|ts|py --check|--record');
const file = process.env.MEDIA_FETCH_GUARD_CASES ?? join(root, 'suites/media-fetch-guard/cases.json');
const document = JSON.parse(readFileSync(file, 'utf8'));
const wire = document.cases.filter(entry => entry.transport === WIRE);
assert(wire.length > 0, 'No wire rows: this would verify nothing.');
for (const entry of document.cases) {
  assert(entry.transport === undefined || entry.transport === WIRE, `${entry.id}: unknown transport`);
}
for (const entry of wire) {
  assert.equal(entry.url.split('{port}').length, 2, `${entry.id}: a wire row's url must name {port} once`);
  assert(Array.isArray(entry.answers_any) && entry.answers_any.length > 0, `${entry.id}: a wire row needs answers_any`);
  assert(entry.redirects_to === undefined && entry.redirects_always === undefined, `${entry.id}: wire rows do not redirect`);
  assert.deepEqual(Object.keys(entry.dispatched ?? {}).sort(), [...LANGUAGES].sort(), `${entry.id}: dispatched needs all three columns`);
}
const run = wire.filter(entry => entry.skip?.[language] === undefined);

const servers = new Map();
let rows = [];
try {
  // The runners get a copy with each row's port filled in; the corpus never
  // carries a port.
  const runtime = { cases: [] };
  for (const entry of run) {
    const server = await startServer('127.0.0.1');
    servers.set(entry.id, server);
    runtime.cases.push({ id: entry.id, url: entry.url.replace('{port}', String(server.port)), guarded: entry.guarded ?? true, resolves: entry.resolves, answers_any: entry.answers_any });
  }
  if (run.length > 0) {
    if (language === 'ts') {
      rows = await observe(runtime, process.env.PRISM_TS_DIST ?? resolve(root, '../prism-ts/dist'));
    } else {
      const command = language === 'php' ? process.env.PRISM_PHP_BINARY ?? 'php' : process.env.PRISM_PY_BINARY ?? 'python';
      const driver = join(root, 'tools/media-fetch-guard', language === 'php' ? 'php.php' : 'py.py');
      // Asynchronous: the servers answer from this process's event loop.
      const { status, stdout } = await spawnDriver(command, [driver], JSON.stringify(runtime));
      assert.equal(status, 0, 'Native media-fetch-guard observer failed.');
      rows = JSON.parse(stdout);
    }
  }
  for (const row of rows) {
    // Read off the server. A refusal code counts only when nothing arrived.
    const dispatched = servers.get(row.id).connections > 0;
    row.observed = { dispatched, refusal: dispatched ? null : row.refusal };
  }
} finally {
  await Promise.all([...servers.values()].map(server => server.close()));
}
assert.equal(rows.length, run.length);
const stale = [];
for (const [index, row] of rows.entries()) {
  const entry = run[index];
  assert.equal(row.id, entry.id, 'Native row identity changed.');
  assert(REFUSALS.includes(row.observed.refusal), `${entry.id}: unrecognised refusal ${row.observed.refusal}`);
  if (entry.refusal[language] !== row.observed.refusal || entry.dispatched[language] !== row.observed.dispatched) stale.push(entry.id);
  entry.refusal[language] = row.observed.refusal;
  entry.dispatched[language] = row.observed.dispatched;
}
for (const entry of wire) {
  // An explicit skip never establishes agreement, as on url-0009.
  entry.agrees = LANGUAGES.every(name => entry.skip?.[name] === undefined
    && entry.refusal[name] === entry.refusal.php && entry.dispatched[name] === entry.dispatched.php);
  for (const name of Object.keys(entry.skip ?? {})) {
    assert(entry.refusal[name] === null && entry.dispatched[name] === false, `${entry.id}: a skipped column records nothing`);
  }
}
if (action === '--check') {
  assert.equal(stale.length, 0, `Stale ${language} media-fetch-guard wire rows: ${stale.join(', ')}`);
} else writeFileSync(file, JSON.stringify(document, null, 4) + '\n');
console.log(`media-fetch-guard ${language}: ${rows.length} wire rows executed; ${stale.length} changed; ${action.slice(2)} passed.`);

function spawnDriver(command, args, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    const timer = setTimeout(() => child.kill(), 120_000);
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolvePromise({ status: code, stdout: Buffer.concat(chunks).toString('utf8') }); });
    child.stdin.end(input);
  });
}
