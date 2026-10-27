#!/usr/bin/env node
// pin-github-checks-structure.mjs -- an INDEPENDENT structural check of what
// pin-github-checks.mjs did to a workflow. It shares no code with that tool on
// purpose: if the rewriter's parser misreads a file, reusing that parser to
// check the result would agree with the mistake.
//
//   node pin-github-checks-structure.mjs --before <old.yml> --after <new.yml>
//        --repository <owner/repo> --path <checkout path>
//        [--gate-graph <path to gate-graph.mjs>]
//
// Asserts, by parsing both versions into objects:
//   * every checkout of --repository has a 40-hex `ref`, persist-credentials
//     false, and is immediately followed by the verify step whose PIN_SHA equals
//     that ref and which pins at least one hash
//   * no job holding a write permission (job- or workflow-level) contains that
//     checkout or any step touching --path
//   * a write job that USED to run it now `needs` a job named `guard`; `guard`
//     has permissions exactly { contents: read }, its first step checks out with
//     persist-credentials false, and the rest are the moved steps plus the pin
//   * the write job's permissions are unchanged, and its steps are exactly the
//     old steps minus the moved ones -- every other step byte-for-byte identical
//   * every job not involved is unchanged; the trigger (`on`) is unchanged
//   * optionally, the org's own gate-graph reports no ungated job
// Exit 0 when all hold, 1 otherwise, printing each assertion.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Minimal YAML subset reader: block maps, block lists, `- key: v` list maps,
// block scalars (| |- >), flow lists, {}, quoted scalars, comments.
// ---------------------------------------------------------------------------

export function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  let i = 0;
  const ind = (l) => l.match(/^ */)[0].length;
  const skippable = (l) => l.trim() === '' || l.trim().startsWith('#');
  const skip = () => { while (i < lines.length && skippable(lines[i])) i++; };

  function stripComment(s) {
    let q = null;
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === '#' && (k === 0 || s[k - 1] === ' ')) return s.slice(0, k);
    }
    return s;
  }
  function scalar(raw) {
    const s = stripComment(raw).trim();
    if (s === '{}') return {};
    if (s === '[]') return [];
    if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1).split(',').map((x) => scalar(x)).filter((x) => x !== '');
    if (/^".*"$/.test(s) || /^'.*'$/.test(s)) return s.slice(1, -1);
    return s;
  }
  function blockScalar(parentIndent) {
    const body = [];
    while (i < lines.length && (lines[i].trim() === '' || ind(lines[i]) > parentIndent)) body.push(lines[i++]);
    while (body.length && body[body.length - 1].trim() === '') body.pop();
    const min = Math.min(...body.filter((l) => l.trim()).map(ind));
    return body.map((l) => l.slice(min)).join('\n');
  }
  function node(minIndent) {
    skip();
    if (i >= lines.length) return null;
    const n = ind(lines[i]);
    if (n < minIndent) return null;
    return /^\s*-(\s|$)/.test(lines[i]) ? list(n) : map(n);
  }
  function value(rest, keyIndent) {
    const v = stripComment(rest).trim();
    if (v === '|' || v === '|-' || v === '>' || v === '>-') return blockScalar(keyIndent);
    if (v !== '') return scalar(rest);
    skip();
    if (i >= lines.length) return null;
    const n = ind(lines[i]);
    if (n > keyIndent) return node(n);
    if (n === keyIndent && /^\s*-(\s|$)/.test(lines[i])) return list(n);
    return null;
  }
  function map(n) {
    const obj = {};
    for (;;) {
      skip();
      if (i >= lines.length) break;
      const l = lines[i];
      if (ind(l) !== n || /^\s*-(\s|$)/.test(l)) break;
      const m = l.match(/^\s*("[^"]*"|'[^']*'|[^:#\s][^:#]*?):(?:\s+(.*)|\s*)$/);
      if (!m) throw new Error(`line ${i + 1}: cannot read "${l.trim()}"`);
      i++;
      obj[m[1].replace(/^["']|["']$/g, '')] = value(m[2] || '', n);
    }
    return obj;
  }
  function list(n) {
    const arr = [];
    for (;;) {
      skip();
      if (i >= lines.length) break;
      const l = lines[i];
      if (ind(l) !== n || !/^\s*-(\s|$)/.test(l)) break;
      const rest = l.slice(n + 1);
      if (rest.trim() === '') { i++; arr.push(node(n + 1)); continue; }
      if (/^\s*[^:#\s"'[{][^:#]*?:(\s|$)/.test(rest) || /^\s*["'][^"']*["']:(\s|$)/.test(rest)) {
        // `- key: v` -- a map whose first key sits on the dash line.
        const inner = n + 1 + rest.match(/^ */)[0].length;
        lines[i] = ' '.repeat(inner) + rest.trimStart();
        arr.push(map(inner));
      } else {
        i++;
        arr.push(scalar(rest));
      }
    }
    return arr;
  }
  const out = map(0);
  skip();
  if (i < lines.length) throw new Error(`line ${i + 1}: unparsed content "${lines[i].trim()}"`);
  return out;
}

// ---------------------------------------------------------------------------

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const writes = (perm) => {
  if (perm == null) return null;
  if (typeof perm === 'string') return /write/.test(perm);
  return Object.values(perm).some((v) => v === 'write');
};

export function checkStructure({ before, after, repository, fetchPath, verifyName = 'Verify the pinned checkout' }) {
  const B = parseYaml(before);
  const A = parseYaml(after);
  const results = [];
  const assert = (ok, msg) => results.push({ ok: !!ok, msg });
  const repo = repository.toLowerCase();
  const isFetch = (s) => /^actions\/checkout@/.test(s?.uses || '') && String(s?.with?.repository || '').toLowerCase() === repo;
  const roots = new Set([fetchPath, ...[B, A].flatMap((workflow) => Object.values(workflow.jobs).flatMap((job) => (job.steps || []).filter(isFetch).map((step) => step.with.path))).filter(Boolean)]);
  const touches = (s) => isFetch(s) || s?.name === verifyName || [...roots].some((root) => JSON.stringify(s).includes(root + '/') || JSON.stringify(s).includes(root.split('/').pop() + '/'));
  const unpin = (step) => {
    if (!isFetch(step)) return step;
    const copy = JSON.parse(JSON.stringify(step)); delete copy.with.ref; return copy;
  };
  const jobWrites = (W, j) => writes(W.jobs[j].permissions) ?? writes(W.permissions) ?? false;
  const feedsWriter = (W, name) => {
    const uses = (job, pattern) => (job.steps || []).some((step) => pattern.test(step.uses || ''));
    if (!uses(W.jobs[name], /^actions\/upload-artifact@/)) return false;
    const needs = (from, target, seen = new Set()) => [].concat(W.jobs[from]?.needs || []).some((dependency) => {
      if (dependency === target) return true;
      if (seen.has(dependency) || !W.jobs[dependency]) return false;
      seen.add(dependency); return needs(dependency, target, seen);
    });
    return Object.keys(W.jobs).some((writer) => jobWrites(W, writer) && uses(W.jobs[writer], /^actions\/download-artifact@/) && needs(writer, name));
  };

  assert(eq(A.on, B.on), 'trigger (`on`) unchanged');
  assert(eq(A.permissions, B.permissions), 'workflow-level permissions unchanged');

  for (const [jn, job] of Object.entries(A.jobs)) {
    const steps = job.steps || [];
    steps.forEach((s, k) => {
      if (!isFetch(s)) return;
      const where = `jobs.${jn}.steps[${k}]`;
      assert(/^[0-9a-f]{40}$/.test(String(s.with.ref || '')), `${where}: ref is a 40-hex SHA (${s.with.ref})`);
      assert(s.with['persist-credentials'] === 'false', `${where}: persist-credentials false`);
      const v = steps[k + 1];
      assert(v?.name === verifyName, `${where}: next step is "${verifyName}"`);
      assert(v?.env?.PIN_SHA === s.with.ref, `${where}: verify PIN_SHA equals ref`);
      const hashes = String(v?.env?.PIN_SHA256 || '').split('\n').filter((l) => /^[0-9a-f]{64}\s+\S/.test(l.trim()));
      assert(hashes.length > 0, `${where}: verify pins ${hashes.length} file hash(es)`);
      assert(v?.shell === 'bash' && /^node -e '/.test(v?.run || ''), `${where}: verify runs under bash with the existing Node runtime`);
      assert(!JSON.stringify(v).includes('tool_cache') && !JSON.stringify(v).includes('PIN_NODE_'), `${where}: verifier never constructs a tool-cache path`);
      assert(v?.['working-directory'] === '${{ github.workspace }}', `${where}: verifier starts at the workspace root`);
      assert(['NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH'].every((key) => v?.env?.[key] === ''), `${where}: verifier clears all eleven joint runtime hooks`);
      assert(v?.env?.PATH === undefined, `${where}: PATH is protected statically, never blanked`);
      assert(!jobWrites(A, jn), `${where}: job ${jn} holds no write permission`);
      assert(!feedsWriter(A, jn), `${where}: job ${jn} never feeds a write job's artifact`);
    });
    if (jobWrites(A, jn)) assert(!steps.some(touches), `jobs.${jn}: write job runs nothing from ${fetchPath}`);
  }

  for (const [jn, oldJob] of Object.entries(B.jobs)) {
    const newJob = A.jobs[jn];
    assert(newJob, `jobs.${jn} still exists`);
    if (!newJob) continue;
    const oldSteps = oldJob.steps || [];
    const ran = oldSteps.some(touches);
    const moved = oldSteps.filter(touches);
    const kept = oldSteps.filter((s) => !touches(s));
    assert(eq(newJob.permissions, oldJob.permissions), `jobs.${jn}: permissions unchanged`);
    const strip = (j) => { const c = { ...j }; delete c.steps; delete c.needs; return c; };
    assert(eq(strip(newJob), strip(oldJob)), `jobs.${jn}: every key but steps/needs unchanged`);
    if (!ran) {
      assert(eq(newJob.steps, oldJob.steps) && eq(newJob.needs, oldJob.needs), `jobs.${jn}: untouched job identical`);
      continue;
    }
    if (jobWrites(B, jn) || feedsWriter(B, jn)) {
      const needs = [].concat(newJob.needs ?? []);
      const oldNeeds = [].concat(oldJob.needs ?? []);
      assert(needs.includes('guard'), `jobs.${jn}: needs includes guard (${needs.join(', ')})`);
      assert(eq(needs.filter((x) => x !== 'guard'), oldNeeds), `jobs.${jn}: other needs preserved`);
      assert(eq(newJob.steps, kept), `jobs.${jn}: steps are the old steps minus the ${moved.length} moved, all others identical and in order`);
      const g = A.jobs.guard;
      assert(g, 'jobs.guard exists');
      if (!g) continue;
      assert(eq(g.permissions, { contents: 'read' }), 'jobs.guard: permissions exactly { contents: read }');
      assert(/^actions\/checkout@/.test(g.steps?.[0]?.uses || '') && !g.steps[0].with?.repository && g.steps[0].with?.['persist-credentials'] === 'false',
        'jobs.guard: first step checks out this repo with persist-credentials false');
      const gotMoved = (g.steps || []).slice(1).filter((s) => s.name !== verifyName).map((s) => {
        if (!isFetch(s)) return s;
        const c = JSON.parse(JSON.stringify(s));
        delete c.with.ref;
        return c;
      });
      const expectedMoved = moved.filter((step) => step.name !== verifyName).map((step) => {
        if (!isFetch(step)) return step;
        const copy = JSON.parse(JSON.stringify(step)); delete copy.with.ref; return copy;
      });
      assert(eq(gotMoved, expectedMoved), 'jobs.guard: remaining steps are exactly the moved fetch + check (plus ref and verify)');
    } else {
      const ordinaryBefore = oldSteps.filter((step) => !touches(step));
      const ordinaryAfter = (newJob.steps || []).filter((step) => !touches(step));
      assert(eq(ordinaryAfter, ordinaryBefore), `jobs.${jn}: all ordinary steps, action inputs and Node selections identical and in order`);
      const fetchedBefore = oldSteps.filter(touches).filter((step) => step.name !== verifyName).map(unpin);
      const fetchedAfter = (newJob.steps || []).filter(touches).filter((step) => step.name !== verifyName).map(unpin);
      assert(eq(fetchedAfter, fetchedBefore), `jobs.${jn}: fetched checkout/consumer contents and order unchanged apart from the pin`);
      assert((newJob.steps || []).findIndex(isFetch) <= oldSteps.findIndex(isFetch), `jobs.${jn}: shared checks move only earlier, ahead of environment writers`);
      assert(eq(newJob.needs, oldJob.needs), `jobs.${jn}: needs unchanged`);
    }
  }
  for (const jn of Object.keys(A.jobs)) {
    if (!B.jobs[jn]) assert(jn === 'guard', `new job ${jn} is the guard`);
  }
  return results;
}

async function main(argv) {
  const o = {};
  for (let k = 0; k < argv.length; k += 2) o[argv[k].replace(/^--/, '')] = argv[k + 1];
  const before = fs.readFileSync(o.before, 'utf8');
  const after = fs.readFileSync(o.after, 'utf8');
  const results = checkStructure({ before, after, repository: o.repository, fetchPath: o.path });
  if (o['gate-graph']) {
    const { ungatedJobs } = await import(pathToFileURL(o['gate-graph']).href);
    const ungated = ungatedJobs(after);
    results.push({ ok: ungated.length === 0, msg: `gate-graph: no ungated job (${ungated.join(', ') || 'none'})` });
  }
  for (const r of results) process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${r.msg}\n`);
  const bad = results.filter((r) => !r.ok).length;
  process.stdout.write(`${results.length} assertions, ${bad} failed: ${o.after}\n`);
  return bad ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { process.stderr.write(`structure: ${e.message}\n`); process.exitCode = 2; });
}
