#!/usr/bin/env node
// Execute one native implementation against the per-call-url-guard corpus, then
// compare or explicitly record its column. A generator's checkout licence;
// loaders only read shipped fixtures.
//
//   node tools/per-call-url-guard.mjs php|ts|py --check|--record
//
// PHP runs against PRISM_PHP_SRC (a prism checkout) when it is set, otherwise
// against the installed reference in runners/php. TypeScript reads
// PRISM_TS_DIST or the built sibling prism-ts/dist; Python imports PRISM_PY_SRC
// or the installed package.
//
// A `per-call-wire` row is not captured inside the SDK. Its url names
// `{endpoint}`, which is replaced with a raw TCP loopback server started here
// for that row, and the call runs over each language's real default transport:
// `dispatched` is whether that server received a connection, read off the
// server. This is how a url the SDK builds but its platform client cannot send
// shows up at all: a capture inside the SDK would record it as sent.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { observe } from './per-call-url-guard/ts.mjs';
import { perCallUrlGuardFailures } from './per-call-url-guard/contract.mjs';
import { startServer } from './cross-origin-redirect/servers.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [language, action] = process.argv.slice(2);
assert(['php', 'ts', 'py'].includes(language) && ['--check', '--record'].includes(action) && process.argv.length === 4,
  'Usage: node tools/per-call-url-guard.mjs php|ts|py --check|--record');
const file = process.env.PER_CALL_URL_GUARD_CASES ?? join(root, 'suites/per-call-url-guard/cases.json');
const document = JSON.parse(readFileSync(file, 'utf8'));
const WIRE = 'per-call-wire';
const servers = new Map();
let rows;
try {
  // The runners get a copy with each wire row's endpoint filled in; the corpus
  // never carries a port.
  const runtime = structuredClone(document);
  for (const entry of runtime.cases) {
    if (entry.given.kind !== WIRE) continue;
    assert(entry.given.config.url.includes('{endpoint}'), `${entry.id}: a wire row's url must name {endpoint}`);
    const server = await startServer('127.0.0.1');
    servers.set(entry.id, server);
    entry.given.config.url = entry.given.config.url.replaceAll('{endpoint}', `127.0.0.1:${server.port}`);
  }
  if (language === 'ts') {
    rows = await observe(runtime, process.env.PRISM_TS_DIST ?? resolve(root, '../prism-ts/dist'));
  } else {
    const command = language === 'php' ? process.env.PRISM_PHP_BINARY ?? 'php' : process.env.PRISM_PY_BINARY ?? 'python';
    const driver = join(root, 'tools/per-call-url-guard', language === 'php' ? 'php.php' : 'py.py');
    // Asynchronous: the wire rows' servers answer from this process's event loop.
    const { status, stdout } = await run(command, [driver], JSON.stringify(runtime));
    assert.equal(status, 0, 'Native per-call-url-guard observer failed.');
    rows = JSON.parse(stdout);
  }
  for (const row of rows) {
    const server = servers.get(row.id);
    if (server === undefined) continue;
    // Read off the server. A refusal code counts only when nothing arrived.
    const dispatched = server.connections > 0;
    row.observed = { dispatched, refusal: dispatched ? null : row.observed.refusal };
  }
} finally {
  await Promise.all([...servers.values()].map(server => server.close()));
}
assert.equal(rows.length, document.cases.length);
const stale = [];
for (const [index, row] of rows.entries()) {
  const entry = document.cases[index];
  assert.equal(row.id, entry.id, 'Native row identity changed.');
  if (!equal(entry.result[language], row.observed)) stale.push(entry.id);
  entry.result[language] = row.observed;
}
for (const entry of document.cases) {
  entry.agrees = ['php', 'ts', 'py'].every(name => entry.result[name] !== null && equal(entry.result.php, entry.result[name]));
}
const problems = perCallUrlGuardFailures(document, { allowIncomplete: action === '--record' });
assert.equal(problems.length, 0, problems.join('\n'));
if (action === '--check') {
  assert.equal(stale.length, 0, `Stale ${language} per-call-url-guard rows: ${stale.join(', ')}`);
} else writeFileSync(file, JSON.stringify(document, null, 4) + '\n');
console.log(`per-call-url-guard ${language}: ${rows.length} executed; ${stale.length} changed; ${action.slice(2)} passed.`);

function run(command, args, input) {
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

function equal(left, right) {
  try { assert.deepEqual(left, right); return true; } catch { return false; }
}
