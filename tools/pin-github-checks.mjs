#!/usr/bin/env node
// pin-github-checks.mjs -- pin and isolate code a workflow fetches from another repo.
// Copied from Fancy's .ai/tools on 2026-10-27; maintained here for Prism.
//
// The problem it exists for: a workflow that does
//
//     uses: actions/checkout@v7
//     with:
//       repository: <org>/<shared-repo>        # no ref
//     ...
//     run: node <path>/some-checker.mjs
//
// runs whatever that repo's default branch holds AT THE MOMENT OF THE RUN. If the
// job also holds `id-token: write` (npm / PyPI Trusted Publishing) or any write
// scope, a push to the shared repo is code execution with publishing rights in
// every consumer. This tool enforces two things for every such checkout:
//
//   1. PIN.     The checkout carries `ref: <40-char commit SHA>`, and the step
//               right after it re-verifies the commit AND the sha256 of every
//               file the fetched code reads, failing the job on any mismatch.
//   2. ISOLATE. The fetched code never runs in a job holding a write permission.
//               Such a job gets its fetch + check moved into a separate read-only
//               job (default name `guard`) that it `needs`.
//
// Modes
//   (default)     rewrite every workflow in place: pin, verify, isolate
//   --check       change nothing; exit 1 on ANY reference to the repository that
//                 is not pinned to the expected SHA with matching hashes, or that
//                 runs in a write-holding job. Workflows are found by SCANNING,
//                 so a repo this tool has never seen is checked like any other.
//   --inventory   print one row per reference: repo, file, job, class, state
//
// Inputs (CLI overrides config; config defaults to pin-github-checks.config.json
// beside this file, paths in it relative to the config file):
//   --config <file>        config JSON
//   --repository <o/r>     the repository whose checkout is pinned
//   --file <path>          a file the fetched code reads (repeatable)
//   --source <dir>         local git clone of that repository; the expected SHA
//                          is `--source-ref` (default origin/main) after a fetch
//   --source-ref <ref>     ref to pin to (default origin/main)
//   --no-fetch             do not `git fetch` the source first
//   --sha <sha>            expected SHA, overriding the source's
//   --source-dir <dir>     a plain directory to hash files from (no git), with --sha
//   --root <dir>           a directory whose CHILDREN are repos (repeatable)
//   --repo <dir>           a single repo directory (repeatable)
//   --only <name>          limit to repos with this directory name (repeatable)
//   --default-permissions read|write
//                          what a job with no `permissions` anywhere gets
//                          (your org's default token setting; default: write,
//                          the conservative assumption)
//   --json                 machine-readable result
//
// Node built-ins only. Hashes are computed over content with CRLF normalised to
// LF, by this tool and by the generated verify step alike, so a Windows runner
// whose git converts line endings verifies the same bytes.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { executionScope, priorEnvironmentWrites, stepExecutionHooks } from './pin-github-checks-execution.mjs';

export const VERIFY_STEP_NAME = 'Verify the pinned checkout';
const SHA_RE = /^[0-9a-f]{40}$/;
const CRLF = String.fromCharCode(13, 10);
const LF = String.fromCharCode(10);

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function hashContent(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);
  return crypto
    .createHash('sha256')
    .update(text.split(CRLF).join(LF), 'latin1')
    .digest('hex');
}

/** Directory shared by every file, so the verify step can list bare names. */
export function commonDir(files) {
  const parts = files.map((f) => f.split('/').slice(0, -1));
  if (!parts.length) return '';
  const out = [];
  for (let i = 0; ; i++) {
    const seg = parts[0][i];
    if (seg === undefined || !parts.every((p) => p[i] === seg)) break;
    out.push(seg);
  }
  return out.join('/');
}

/**
 * Resolve the expected pin: { sha, hashes: { file: hex }, files }.
 * Returns null when no source was given (structural check only).
 */
export function resolveExpected(opts) {
  const files = opts.files || [];
  if (!opts.source && !opts.sourceDir && opts.pin) {
    const { sha, hashes } = opts.pin;
    if (!SHA_RE.test(sha || '') || !files.length || !hashes ||
        Object.keys(hashes).length !== files.length ||
        files.some((f) => !/^[0-9a-f]{64}$/.test(hashes[f] || ''))) {
      throw new Error('configured pin must contain an immutable SHA and an exact hash for every file');
    }
    return { sha, hashes, files };
  }
  if (opts.sourceDir) {
    if (!opts.sha) throw new Error('--source-dir needs --sha');
    const hashes = {};
    for (const f of files) hashes[f] = hashContent(fs.readFileSync(path.join(opts.sourceDir, f)));
    return { sha: opts.sha, hashes, files };
  }
  if (!opts.source) {
    if (opts.sha) throw new Error('--sha alone cannot hash files; give --source or --source-dir');
    return null;
  }
  const git = (...args) => execFileSync('git', ['-C', opts.source, ...args], { maxBuffer: 64 << 20 });
  if (opts.fetch !== false) git('fetch', '-q', 'origin');
  const sha = opts.sha || git('rev-parse', opts.sourceRef || 'origin/main').toString('utf8').trim();
  if (!SHA_RE.test(sha)) throw new Error(`source resolved to "${sha}", not a 40-char SHA`);
  const hashes = {};
  for (const f of files) hashes[f] = hashContent(git('show', `${sha}:${f}`));
  return { sha, hashes, files };
}

// ---------------------------------------------------------------------------
// Workflow model -- the subset of YAML Actions workflows actually use
// ---------------------------------------------------------------------------

const indentOf = (l) => l.match(/^ */)[0].length;
const isBlank = (l) => l.trim() === '';
const isComment = (l) => l.trim().startsWith('#');

export function splitLines(text) {
  const eol = text.includes(CRLF) ? CRLF : LF;
  return { lines: text.split(/\r?\n/), eol };
}

function parsePermissions(lines, at, keyIndent) {
  // `permissions: <inline>` or a block of `key: value` one level deeper.
  const m = lines[at].match(/^\s*permissions:\s*(.*?)\s*(#.*)?$/);
  const inline = m[1];
  if (inline) {
    if (inline === '{}') return { kind: 'map', map: {} };
    return { kind: 'inline', value: inline };
  }
  const map = {};
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (isBlank(l) || isComment(l)) continue;
    if (indentOf(l) <= keyIndent) break;
    const kv = l.match(/^\s*([A-Za-z-]+):\s*([A-Za-z-]+)/);
    if (kv) map[kv[1]] = kv[2];
  }
  return { kind: 'map', map };
}

export function permissionsWrite(perm) {
  if (!perm) return null;
  if (perm.kind === 'inline') return perm.value !== 'read-all';
  return Object.values(perm.map).some((v) => v === 'write');
}

/** Leading comment/blank lines that belong to the item starting at `at`. */
function leadStart(lines, at, indent, floor) {
  let i = at;
  while (i - 1 > floor) {
    const l = lines[i - 1];
    if (isBlank(l) || (isComment(l) && indentOf(l) === indent)) i--;
    else break;
  }
  return i;
}

export function parseWorkflow(text) {
  const { lines, eol } = splitLines(text);
  const wf = { lines, eol, permissions: null, jobs: [] };

  let jobsAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^permissions:/.test(lines[i])) wf.permissions = parsePermissions(lines, i, 0);
    if (/^jobs:\s*(#.*)?$/.test(lines[i])) jobsAt = i;
  }
  if (jobsAt === -1) return wf;

  let jobsEnd = lines.length;
  for (let i = jobsAt + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && !isComment(lines[i])) { jobsEnd = i; break; }
  }
  const headers = [];
  let jobIndent = null;
  for (let i = jobsAt + 1; i < jobsEnd; i++) {
    const l = lines[i];
    if (isBlank(l) || isComment(l)) continue;
    const ind = indentOf(l);
    if (jobIndent === null) jobIndent = ind;
    if (ind === jobIndent) {
      const h = l.match(/^\s*([A-Za-z0-9_.-]+):\s*(#.*)?$/);
      if (h) headers.push({ name: h[1], header: i });
    }
  }
  for (const job of headers) {
    job.indent = jobIndent;
    job.lead = leadStart(lines, job.header, jobIndent, jobsAt);
  }
  for (let j = 0; j < headers.length; j++) {
    const job = headers[j];
    job.end = j + 1 < headers.length ? headers[j + 1].lead : jobsEnd;
    // Trailing blank lines before the jobs mapping ends belong to nobody.
    while (job.end - 1 > job.header && isBlank(lines[job.end - 1])) job.end--;
    parseJobBody(lines, job);
    wf.jobs.push(job);
  }
  return wf;
}

function parseJobBody(lines, job) {
  const keyIndent = job.indent + 2;
  job.permissions = null;
  job.needsAt = -1;
  job.steps = [];
  job.extra = [];
  let stepsAt = -1;
  for (let i = job.header + 1; i < job.end; i++) {
    const l = lines[i];
    if (isBlank(l) || isComment(l) || indentOf(l) !== keyIndent) continue;
    const key = l.trim().split(':')[0];
    if (key === 'permissions') job.permissions = parsePermissions(lines, i, keyIndent);
    else if (key === 'needs') job.needsAt = i;
    else if (key === 'steps') stepsAt = i;
    else if (['defaults', 'container', 'services', 'env', 'working-directory'].includes(key)) job.extra.push(key);
  }
  if (stepsAt === -1) return;
  let stepIndent = null;
  const starts = [];
  for (let i = stepsAt + 1; i < job.end; i++) {
    const l = lines[i];
    if (isBlank(l) || isComment(l)) continue;
    if (indentOf(l) <= keyIndent) break;
    if (/^\s*- /.test(l) && (stepIndent === null || indentOf(l) === stepIndent)) {
      stepIndent = indentOf(l);
      starts.push(i);
    }
  }
  job.stepIndent = stepIndent;
  job.stepsAt = stepsAt;
  let stepsEnd = job.end;
  for (let i = stepsAt + 1; i < job.end; i++) {
    const l = lines[i];
    if (!isBlank(l) && !isComment(l) && indentOf(l) <= keyIndent) { stepsEnd = i; break; }
  }
  for (let s = 0; s < starts.length; s++) {
    const start = starts[s];
    const lead = leadStart(lines, start, stepIndent, stepsAt);
    job.steps.push({ start, lead, end: 0 });
  }
  for (let s = 0; s < job.steps.length; s++) {
    job.steps[s].end = s + 1 < job.steps.length ? job.steps[s + 1].lead : stepsEnd;
  }
}

/** The `with:` children (and a few top-level keys) of a step. */
export function parseStep(lines, step) {
  const body = lines.slice(step.start, step.end);
  const base = indentOf(lines[step.start]) + 2; // keys of the step mapping
  const out = { uses: null, name: null, id: null, if: null, workingDirectory: null, with: {}, withLines: {}, env: {}, envLines: {}, run: '' };
  let section = null;
  let sectionIndent = 0;
  let blockKey = null;
  let blockIndent = 0;
  for (let k = 0; k < body.length; k++) {
    const idx = step.start + k;
    const raw = body[k];
    const l = k === 0 ? raw.replace(/^(\s*)- /, (m, sp) => sp + '  ') : raw;
    if (isBlank(l)) { if (blockKey) out.env[blockKey] += LF; continue; }
    const ind = indentOf(l);
    if (blockKey) {
      if (ind > blockIndent) { out.env[blockKey] += l.trim() + LF; continue; }
      blockKey = null;
    }
    if (isComment(l)) continue;
    if (ind === base) {
      const m = l.match(/^\s*([A-Za-z-]+):\s*(.*?)\s*$/);
      if (!m) continue;
      section = null;
      if (m[1] === 'uses') out.uses = m[2];
      else if (m[1] === 'id') out.id = m[2];
      else if (m[1] === 'if') out.if = m[2];
      else if (m[1] === 'working-directory') out.workingDirectory = m[2].replace(/^["']|["']$/g, '');
      else if (m[1] === 'name') out.name = m[2].replace(/^["']|["']$/g, '');
      else if (m[1] === 'with' || m[1] === 'env') { section = m[1]; sectionIndent = ind; }
      else if (m[1] === 'run') { section = 'run'; out.run += m[2] + LF; }
      continue;
    }
    if (section === 'run') { out.run += l + LF; continue; }
    if ((section === 'with' || section === 'env') && ind === sectionIndent + 2) {
      const m = l.match(/^\s*([A-Za-z0-9_-]+):\s*(.*?)\s*(#.*)?$/);
      if (!m) continue;
      const val = m[2].replace(/^["']|["']$/g, '');
      if (section === 'with') { out.with[m[1]] = val; out.withLines[m[1]] = idx; }
      else {
        out.envLines[m[1]] = idx;
        if (val === '|' || val === '|-' || val === '>') { out.env[m[1]] = ''; blockKey = m[1]; blockIndent = ind; }
        else out.env[m[1]] = val;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Finding references
// ---------------------------------------------------------------------------

/**
 * Every executable (non-comment) line mentioning the repository, located in
 * its job and step. A mention that is not a checkout's `repository:` is still
 * returned -- as `kind: 'other'` -- because it is a fetch this tool cannot
 * verify, and an unverifiable fetch must fail --check rather than be ignored.
 */
export function findReferences(wf, repository) {
  const needle = repository.toLowerCase();
  const refs = [];
  const seen = new Set();
  wf.lines.forEach((l, i) => {
    if (isComment(l) || !l.toLowerCase().includes(needle)) return;
    const job = wf.jobs.find((j) => i >= j.header && i < j.end);
    const stepIdx = job ? job.steps.findIndex((s) => i >= s.start && i < s.end) : -1;
    const key = job ? `${job.name}#${stepIdx}` : `line${i}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!job || stepIdx === -1) { refs.push({ kind: 'other', line: i, job: job?.name ?? null }); return; }
    const step = parseStep(wf.lines, job.steps[stepIdx]);
    const isCheckout = /^actions\/checkout@/i.test(step.uses || '') && (step.with.repository || '').toLowerCase() === needle;
    refs.push({ kind: isCheckout ? 'checkout' : 'other', line: i, job: job.name, jobRef: job, stepIdx, step });
  });
  return refs;
}

export function jobWrites(wf, job, defaultPermissions = 'write') {
  const own = permissionsWrite(job.permissions);
  if (own !== null) return own;
  const top = permissionsWrite(wf.permissions);
  if (top !== null) return top;
  return defaultPermissions === 'write';
}

export function jobNeeds(wf, job) {
  if (job.needsAt === -1) return [];
  const value = wf.lines[job.needsAt].replace(/^\s*needs:\s*/, '').replace(/\s+#.*$/, '').trim();
  if (value) return value.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  const result = [];
  for (let index = job.needsAt + 1; index < job.end; index++) {
    if (isBlank(wf.lines[index]) || isComment(wf.lines[index])) continue;
    if (indentOf(wf.lines[index]) <= job.indent + 2) break;
    const item = /^\s*-\s*(\S+)/.exec(wf.lines[index]);
    if (!item) break;
    result.push(item[1].replace(/^["']|["']$/g, ''));
  }
  return result;
}

export function jobFeedsWriter(wf, job, defaultPermissions = 'write') {
  const uses = (target, pattern) => target.steps.some((step) => pattern.test(parseStep(wf.lines, step).uses || ''));
  if (!uses(job, /^actions\/upload-artifact@/i)) return false;
  const byName = new Map(wf.jobs.map((entry) => [entry.name, entry]));
  const reaches = (from, target, seen = new Set()) => jobNeeds(wf, from).some((name) => {
    if (name === target) return true;
    if (seen.has(name) || !byName.has(name)) return false;
    seen.add(name);
    return reaches(byName.get(name), target, seen);
  });
  return wf.jobs.some((writer) => writer !== job && jobWrites(wf, writer, defaultPermissions) && uses(writer, /^actions\/download-artifact@/i) && reaches(writer, job.name));
}

const stepCode = (wf, step) => wf.lines.slice(step.start, step.end).filter((line) => !isComment(line)).join(LF);
const executableLines = (lines) => {
  const exact = lines.slice();
  while (exact.length && isBlank(exact[exact.length - 1])) exact.pop();
  return exact.join(LF);
};

export function isExactVerifier(wf, job, index, cfg) {
  const step = job.steps[index];
  if (!step || index < 1) return false;
  const parsed = parseStep(wf.lines, step);
  if (parsed.name !== VERIFY_STEP_NAME || !parsed.env.PIN_ROOT || !SHA_RE.test(parsed.env.PIN_SHA || '')) return false;
  const dir = commonDir(cfg.files);
  const values = parseHashBlock(parsed.env.PIN_SHA256 || '');
  const hashes = Object.fromEntries(cfg.files.map((file) => [file, values[dir ? file.slice(dir.length + 1) : file] || '-']));
  const wanted = verifyStepLines(job.stepIndent, parsed.env.PIN_ROOT, { sha: parsed.env.PIN_SHA, hashes, files: cfg.files });
  return executableLines(wf.lines.slice(step.start, step.end)) === executableLines(wanted);
}

function gateRoot(wf, job, step) {
  const parsed = parseStep(wf.lines, step);
  let cwd = parsed.workingDirectory ?? executionScope(wf, job).workingDirectory;
  if (cwd === '${{ github.workspace }}') cwd = '';
  if (cwd.includes('$') || path.posix.isAbsolute(cwd) || cwd.includes('\\')) return null;
  const matches = [...parsed.run.matchAll(/([.A-Za-z0-9_/-]+)\/third-party\/check[.]mjs/g)];
  if (!matches.length) return null;
  const roots = new Set(matches.map((match) => path.posix.normalize(path.posix.join(cwd, match[1]))));
  return roots.size === 1 ? [...roots][0] : null;
}

export function gateProblems(wf, cfg) {
  const problems = [];
  const jobs = [];
  let gates = 0;
  for (const job of wf.jobs) {
    let hasGate = false;
    job.steps.forEach((step, index) => {
      const parsed = parseStep(wf.lines, step);
      if (!parsed.run.includes('third-party/check.mjs')) return;
      gates++;
      hasGate = true;
      const root = gateRoot(wf, job, step);
      let verified = false;
      if (root && !stepExecutionHooks(parsed).length) {
        for (let prior = index - 1; prior >= 1; prior--) {
          // A generic intervening program could mutate the checkout without
          // naming it literally. All generated gates immediately follow their
          // verifier, so require that sequence rather than guess at program IO.
          if (prior !== index - 1) continue;
          if (!isExactVerifier(wf, job, prior, cfg)) continue;
          const verifier = parseStep(wf.lines, job.steps[prior]);
          const checkout = parseStep(wf.lines, job.steps[prior - 1]);
          if (!/^actions\/checkout@/i.test(checkout.uses || '') || checkout.with.repository?.toLowerCase() !== cfg.repository.toLowerCase() || checkout.with.path !== root || checkout.with.ref !== verifier.env.PIN_SHA || verifier.env.PIN_ROOT !== root) continue;
          const touched = job.steps.slice(prior + 1, index).some((middle) => {
            const text = stepCode(wf, middle);
            const relativeRoot = path.posix.relative(executionScope(wf, job).workingDirectory || '.', root);
            return text.includes(root) || (!!relativeRoot && text.includes(relativeRoot));
          });
          if (!touched) { verified = true; break; }
        }
      }
      if (!verified) problems.push({ code: 'gate-unverified', where: `job ${job.name}`, message: `gate step ${index + 1} must run from an exactly verified checkout in the same job, with no intervening checkout mutation or execution hook` });
    });
    if (hasGate) jobs.push(job);
  }
  return { gates, jobs, problems };
}

/** Steps after the fetch that run code from its path (the consumers). */
function consumers(wf, job, fetchIdx, checkoutPath) {
  const out = [];
  for (let s = fetchIdx + 1; s < job.steps.length; s++) {
    const st = parseStep(wf.lines, job.steps[s]);
    if (st.name === VERIFY_STEP_NAME) continue;
    const body = wf.lines.slice(job.steps[s].start, job.steps[s].end).filter((l) => !isComment(l)).join(LF);
    if (body.includes(checkoutPath + '/')) out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Checking one workflow
// ---------------------------------------------------------------------------

export function checkWorkflow(text, cfg, expected) {
  const wf = parseWorkflow(text);
  const refs = findReferences(wf, cfg.repository);
  const problems = [];
  const rows = [];
  for (const r of refs) {
    const where = r.job ? `job ${r.job}` : `line ${r.line + 1}`;
    if (r.kind === 'other') {
      problems.push({ code: 'unverifiable', where, message: `references ${cfg.repository} outside an actions/checkout \`repository:\` (line ${r.line + 1}); a fetch this tool cannot pin` });
      rows.push({ job: r.job, cls: 'other', state: 'unverifiable' });
      continue;
    }
    const st = r.step;
    const writes = jobWrites(wf, r.jobRef, cfg.defaultPermissions);
    const feeds = jobFeedsWriter(wf, r.jobRef, cfg.defaultPermissions);
    const p = (code, message) => problems.push({ code, where, message });
    const ref = st.with.ref;
    if (!ref) p('no-ref', 'checkout has no `ref:`, so it runs whatever the default branch holds at run time');
    else if (!SHA_RE.test(ref)) p('ref-not-sha', `ref "${ref}" is not a 40-character commit SHA`);
    else if (expected && ref !== expected.sha) p('ref-drift', `ref ${ref} is not the expected ${expected.sha}`);
    if (st.with['persist-credentials'] !== 'false') p('persist-credentials', 'checkout does not set `persist-credentials: false`');
    if (!st.with.path) p('no-path', 'checkout has no `path:`; the fetched tree would overlay the workspace');
    if (writes) p('write-permission', 'the fetched code runs in a job holding a write permission (id-token, contents, ...); move it to a read-only job this one needs');
    if (feeds) p('artifact-to-writer', 'fetched code can poison an artifact consumed by a write job; isolate the check before the artifact-producing job');
    for (const issue of executionScope(wf, r.jobRef).problems) p('inherited-execution', issue);
    for (const writer of priorEnvironmentWrites(wf, r.jobRef, r.stepIdx, parseStep)) p('prior-environment-write', `earlier step ${writer.index + 1} (${writer.name}) can write GITHUB_ENV/GITHUB_PATH; the gate must precede it`);

    const next = r.jobRef.steps[r.stepIdx + 1];
    const v = next ? parseStep(wf.lines, next) : null;
    if (!v || v.name !== VERIFY_STEP_NAME) {
      p('no-verify', `no "${VERIFY_STEP_NAME}" step directly after the checkout`);
    } else {
      if (!isExactVerifier(wf, r.jobRef, r.stepIdx + 1, cfg)) p('verify-body', 'the verifier is not the complete generated executable step');
      if (v.env.PIN_SHA !== ref) p('verify-sha', `verify step pins ${v.env.PIN_SHA || '(nothing)'} but the checkout ref is ${ref || '(none)'}`);
      if (st.with.path && v.env.PIN_ROOT !== st.with.path) p('verify-root', `verify step PIN_ROOT ${v.env.PIN_ROOT} is not the checkout path ${st.with.path}`);
      const pinned = parseHashBlock(v.env.PIN_SHA256 || '');
      if (!Object.keys(pinned).length) p('no-hashes', 'verify step pins no file hashes');
      if (expected) {
        const dir = commonDir(expected.files);
        const wantDir = [st.with.path, dir].filter(Boolean).join('/');
        if (v.env.PIN_DIR !== wantDir) p('verify-dir', `verify step PIN_DIR ${v.env.PIN_DIR} is not ${wantDir}`);
        for (const f of expected.files) {
          const rel = dir ? f.slice(dir.length + 1) : f;
          if (!pinned[rel]) p('hash-missing', `no pinned hash for ${f}`);
          else if (pinned[rel] !== expected.hashes[f]) p('hash-drift', `${f} pinned ${pinned[rel]}, expected ${expected.hashes[f]}`);
        }
        // Declaring matching PIN_* values is insufficient: a no-op or a skipped
        // verifier must not bless the fetched executable. Compare the complete
        // generated step, allowing only whitespace and comments to differ.
        const code = (lines) => lines.filter((l) => !isBlank(l) && !isComment(l)).map((l) => l.trim()).join(LF);
        const actual = code(wf.lines.slice(next.start, next.end));
        const generated = code(verifyStepLines(r.jobRef.stepIndent, st.with.path, expected));
        if (actual !== generated) p('verify-body', 'verify step differs from the executable fail-closed verifier generated for this pin');
      }
    }
    rows.push({
      job: r.job,
      cls: writes ? 'write-holder' : feeds ? 'feeds-writer' : 'read-only',
      state: problems.some((x) => x.where === where) ? 'needs-work' : 'pinned',
    });
  }
  const gate = gateProblems(wf, cfg);
  problems.push(...gate.problems);
  for (const job of gate.jobs) {
    for (const issue of executionScope(wf, job).problems) problems.push({ code: 'inherited-execution', where: `job ${job.name}`, message: issue });
    const first = job.steps.findIndex((step) => parseStep(wf.lines, step).run.includes('third-party/check.mjs'));
    for (const writer of priorEnvironmentWrites(wf, job, first, parseStep)) problems.push({ code: 'prior-environment-write', where: `job ${job.name}`, message: `earlier step ${writer.index + 1} can write GITHUB_ENV/GITHUB_PATH` });
  }
  return { refs: refs.length, gates: gate.gates, problems, rows };
}

export function parseHashBlock(block) {
  const out = {};
  for (const line of block.split(LF)) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) out[parts.slice(1).join(' ')] = parts[0];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rewriting one workflow
// ---------------------------------------------------------------------------

function verifierUsesWorkspace(wf, job, checkoutPath) {
  return checkoutPath.includes('/') || job.extra.includes('defaults') || wf.lines.some((line) => /^defaults:/.test(line));
}

export function verifyStepLines(indent, checkoutPath, expected) {
  const si = ' '.repeat(indent);
  const dir = commonDir(expected.files);
  const pinDir = [checkoutPath, dir].filter(Boolean).join('/');
  const k = si + '  ';
  const out = [
    `${si}- name: ${VERIFY_STEP_NAME}`,
    `${k}# Generated by pin-github-checks.mjs -- edit the pin with that tool, not by`,
    `${k}# hand. The ref above is a commit SHA, and every file the fetched code reads`,
    `${k}# is hashed here, so a push to the source repo cannot change what runs in`,
    `${k}# this workflow until someone reviews it and re-pins.`,
    `${k}shell: bash`,
    k + 'working-directory: ${{ github.workspace }}',
    `${k}env:`,
    `${k}  NODE_OPTIONS: ""`,
    `${k}  NODE_PATH: ""`,
    `${k}  BASH_ENV: ""`,
    `${k}  ENV: ""`,
    `${k}  PIN_ROOT: ${checkoutPath}`,
    `${k}  PIN_DIR: ${pinDir}`,
    `${k}  PIN_SHA: ${expected.sha}`,
    `${k}  PIN_SHA256: |`,
  ];
  for (const f of expected.files) {
    const rel = dir ? f.slice(dir.length + 1) : f;
    out.push(`${k}    ${expected.hashes[f]}  ${rel}`);
  }
  const r = `${k}  `;
  out.push(
    `${k}run: |`,
    `${r}node -e '`,
    `${r}const fs = require("node:fs");`,
    `${r}const crypto = require("node:crypto");`,
    `${r}const { execFileSync } = require("node:child_process");`,
    `${r}const env = process.env;`,
    `${r}const fail = [];`,
    `${r}const head = execFileSync("git", ["-C", env.PIN_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();`,
    `${r}if (head !== env.PIN_SHA) fail.push("checkout is at " + head + ", pinned " + env.PIN_SHA);`,
    `${r}const want = env.PIN_SHA256.split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean);`,
    `${r}if (!want.length) fail.push("no file hashes are pinned");`,
    `${r}for (const entry of want) {`,
    `${r}  const [hash, ...rest] = entry.split(" ").filter(Boolean);`,
    `${r}  const file = rest.join(" ");`,
    `${r}  let got = "missing";`,
    `${r}  try {`,
    `${r}    const text = fs.readFileSync(env.PIN_DIR + "/" + file, "latin1");`,
    `${r}    const lf = text.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));`,
    `${r}    got = crypto.createHash("sha256").update(lf, "latin1").digest("hex");`,
    `${r}  } catch {}`,
    `${r}  if (got !== hash) fail.push(file + " sha256 is " + got + ", pinned " + hash);`,
    `${r}}`,
    `${r}for (const f of fail) console.log("::error::Pinned checkout mismatch: " + f);`,
    `${r}if (fail.length) {`,
    `${r}  console.log("::error::Refusing to run fetched code that does not match its pin. Review the upstream change, then re-pin with pin-github-checks.mjs.");`,
    `${r}  process.exit(1);`,
    `${r}}`,
    `${r}console.log("Pinned checkout verified: " + head + ", " + want.length + " files match.");`,
    `${r}'`,
  );
  return out;
}

function setNeeds(lines, job, guard) {
  const keyIndent = ' '.repeat(job.indent + 2);
  if (job.needsAt === -1) {
    lines.splice(job.header + 1, 0, `${keyIndent}needs: ${guard}`);
    return;
  }
  const l = lines[job.needsAt];
  const m = l.match(/^(\s*needs:\s*)(.*?)(\s*#.*)?$/);
  const val = m[2];
  if (!val) {
    lines.splice(job.needsAt + 1, 0, `${' '.repeat(job.indent + 4)}- ${guard}`);
  } else if (val.startsWith('[')) {
    const inner = val.slice(1, -1).trim();
    lines[job.needsAt] = `${m[1]}[${guard}${inner ? ', ' + inner : ''}]${m[3] || ''}`;
  } else {
    lines[job.needsAt] = `${m[1]}[${guard}, ${val}]${m[3] || ''}`;
  }
}

/**
 * Rewrite a workflow so every reference is pinned, verified and isolated.
 * Returns { text, changed, notes, errors }. On an unsupported shape the
 * workflow is returned UNCHANGED with an error -- a half-applied rewrite of a
 * publish workflow is worse than none.
 */
export function rewriteWorkflow(text, cfg, expected) {
  const notes = [];
  // Isolation first (it moves steps), then pin every remaining reference.
  // Re-parse after each structural change; line numbers move.
  let wf = parseWorkflow(text);
  for (let guardRound = 0; guardRound < 10; guardRound++) {
    const refs = findReferences(wf, cfg.repository);
    const bad = refs.find((r) => r.kind === 'checkout' && (jobWrites(wf, r.jobRef, cfg.defaultPermissions) || jobFeedsWriter(wf, r.jobRef, cfg.defaultPermissions)));
    if (!bad) break;
    const res = isolate(wf, bad, cfg);
    if (res.error) return { text, changed: false, notes, errors: [res.error] };
    notes.push(res.note);
    wf = parseWorkflow(res.lines.join(wf.eol));
  }

  const errors = [];
  for (let round = 0; round < 50; round++) {
    const refs = findReferences(wf, cfg.repository);
    let touched = false;
    for (const r of refs) {
      if (r.kind === 'other') { errors.push(`job ${r.job ?? '?'} line ${r.line + 1}: references ${cfg.repository} outside a checkout; not rewritable`); continue; }
      const step = r.step;
      const lines = wf.lines.slice();
      const stepLines = r.jobRef.steps[r.stepIdx];
      if (executionScope(wf, r.jobRef).problems.length) { errors.push(`job ${r.job}: unsafe inherited execution controls must be removed before rewriting`); continue; }
      const writers = priorEnvironmentWrites(wf, r.jobRef, r.stepIdx, parseStep);
      if (writers.length) {
        let consumer = r.stepIdx + 1;
        if (r.jobRef.steps[consumer] && parseStep(wf.lines, r.jobRef.steps[consumer]).name === VERIFY_STEP_NAME) consumer++;
        if (!r.jobRef.steps[consumer] || !parseStep(wf.lines, r.jobRef.steps[consumer]).run) { errors.push(`job ${r.job}: cannot identify the checkout's immediate consumer for ordering`); continue; }
        const end = r.jobRef.steps[consumer].end;
        const block = lines.slice(stepLines.lead, end);
        const at = r.jobRef.steps[writers[0].index].lead;
        lines.splice(stepLines.lead, end - stepLines.lead);
        lines.splice(at, 0, ...block);
        wf = parseWorkflow(lines.join(wf.eol)); touched = true; break;
      }
      if (!step.with.path) { errors.push(`job ${r.job}: checkout has no path:`); continue; }
      const repoLine = step.withLines.repository;
      const withIndent = ' '.repeat(indentOf(lines[repoLine]));
      const refLine = `${withIndent}ref: ${expected.sha}`;
      if (step.withLines.ref !== undefined) {
        if (lines[step.withLines.ref] !== refLine) { lines[step.withLines.ref] = refLine; touched = true; }
      } else {
        lines.splice(repoLine + 1, 0, refLine);
        touched = true;
      }
      if (touched) { wf = parseWorkflow(lines.join(wf.eol)); break; }

      if (step.with['persist-credentials'] !== 'false') {
        const at = step.withLines['persist-credentials'];
        const pc = `${withIndent}persist-credentials: false`;
        if (at !== undefined) lines[at] = pc; else lines.splice(repoLine + 1, 0, pc);
        wf = parseWorkflow(lines.join(wf.eol));
        touched = true;
        break;
      }

      const want = verifyStepLines(r.jobRef.stepIndent, step.with.path, expected);
      const next = r.jobRef.steps[r.stepIdx + 1];
      const nextParsed = next ? parseStep(lines, next) : null;
      // Keep one blank line between steps, matching the house style.
      const block = ['', ...want];
      if (nextParsed && nextParsed.name === VERIFY_STEP_NAME) {
        const cur = lines.slice(next.lead, next.end);
        // Trailing blank lines of the existing verify step belong to the gap
        // before the following step; keep them.
        let tail = 0;
        while (tail < cur.length && isBlank(cur[cur.length - 1 - tail])) tail++;
        const replacement = [...block, ...cur.slice(cur.length - tail)];
        if (cur.join(LF) !== replacement.join(LF)) {
          lines.splice(next.lead, next.end - next.lead, ...replacement);
          wf = parseWorkflow(lines.join(wf.eol));
          touched = true;
          break;
        }
      } else {
        // Insert right after the checkout step's own content, before any
        // comments that lead into the following step.
        let at = stepLines.end;
        while (at > stepLines.start + 1 && isBlank(lines[at - 1])) at--;
        lines.splice(at, 0, ...block);
        wf = parseWorkflow(lines.join(wf.eol));
        touched = true;
        break;
      }
    }
    if (!touched) break;
  }
  const out = wf.lines.join(wf.eol);
  if (errors.length) return { text, changed: false, notes, errors: [...new Set(errors)] };
  return { text: out, changed: out !== text, notes, errors: [] };
}

function isolate(wf, ref, cfg) {
  const job = ref.jobRef;
  const guard = cfg.guardJob || 'guard';
  const where = `job ${job.name}`;
  if (wf.jobs.some((j) => j.name === guard)) return { error: `${where}: holds write permission and a job named "${guard}" already exists; isolate by hand` };
  if (job.extra.length) return { error: `${where}: has job-level ${job.extra.join(', ')}, which the moved check may depend on; isolate by hand` };
  const checkoutPath = ref.step.with.path;
  if (!checkoutPath) return { error: `${where}: checkout has no path:` };
  const lines = wf.lines;
  const cons = consumers(wf, job, ref.stepIdx, checkoutPath);
  let last = ref.stepIdx;
  const next = job.steps[ref.stepIdx + 1];
  if (next && parseStep(lines, next).name === VERIFY_STEP_NAME) last = ref.stepIdx + 1;
  for (const c of cons) {
    if (c !== last + 1) return { error: `${where}: steps using ${checkoutPath}/ are not contiguous with the fetch; isolate by hand` };
    last = c;
  }
  if (!cons.length) return { error: `${where}: nothing runs the fetched code after the checkout; isolate by hand` };
  const from = job.steps[ref.stepIdx].lead;
  const to = job.steps[last].end;
  const moved = lines.slice(from, to);
  const body = moved.filter((l) => !isComment(l)).join(LF);
  if (/\$\{\{\s*(matrix|steps|needs|strategy)\./.test(body)) return { error: `${where}: the moved steps use matrix/steps/needs context; isolate by hand` };
  while (moved.length && isBlank(moved[0])) moved.shift();
  while (moved.length && isBlank(moved[moved.length - 1])) moved.pop();

  // The guard checks out THIS repo the same way the job did, minus credentials.
  const ownCheckout = job.steps.map((s) => parseStep(lines, s)).find((s) => /^actions\/checkout@/i.test(s.uses || '') && !s.with.repository);
  const uses = ownCheckout?.uses || ref.step.uses;
  const ownWith = Object.entries(ownCheckout?.with || {}).filter(([key]) => key !== 'persist-credentials' && key !== 'token');

  const ji = ' '.repeat(job.indent);
  const ki = ' '.repeat(job.indent + 2);
  const si = ' '.repeat(job.stepIndent);
  const shift = job.stepIndent - (job.indent + 4);
  const reindent = (l) => (shift === 0 || isBlank(l) ? l : l.slice(shift));
  const g = [
    `${ji}${guard}:`,
    `${ki}# Generated by pin-github-checks.mjs. Code fetched from another repo runs`,
    `${ki}# HERE, in a job holding nothing but \`contents: read\` -- never in a job that`,
    `${ki}# can publish or write. ${job.name} needs this job, so it still cannot start`,
    `${ki}# until the check has passed.`,
    `${ki}runs-on: ubuntu-latest`,
    `${ki}permissions:`,
    `${ki}  contents: read`,
    `${ki}steps:`,
    `${' '.repeat(job.indent + 4)}- uses: ${uses}`,
    `${' '.repeat(job.indent + 6)}with:`,
    ...ownWith.map(([key, v]) => `${' '.repeat(job.indent + 8)}${key}: ${v}`),
    `${' '.repeat(job.indent + 8)}persist-credentials: false`,
    '',
    ...moved.map(reindent),
    '',
  ];
  void si;

  // Remove the moved steps from the job (and one blank line that separated them).
  const out = lines.slice();
  let delFrom = from;
  let delTo = to;
  while (delTo < job.end && isBlank(out[delTo]) && delFrom > 0 && isBlank(out[delFrom - 1])) delTo++;
  out.splice(delFrom, delTo - delFrom);
  // Header and needs sit before the removed range, so their indexes still hold.
  setNeeds(out, job, guard);
  out.splice(job.lead, 0, ...g);
  return { lines: out, note: `isolated job ${job.name}: fetch + check moved to read-only job "${guard}", ${job.name} needs it` };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export function discover(opts) {
  const repos = [];
  for (const root of opts.roots || []) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) if (e.isDirectory()) repos.push(path.join(root, e.name));
  }
  for (const r of opts.repos || []) repos.push(r);
  const filtered = opts.only?.length ? repos.filter((r) => opts.only.includes(path.basename(path.resolve(r)))) : repos;
  const files = [];
  for (const repo of filtered) {
    const dir = path.join(repo, '.github', 'workflows');
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort(); } catch { continue; }
    for (const n of names) files.push({ repo, file: path.join(dir, n) });
  }
  return { repos: filtered, files };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const o = { roots: null, repos: null, only: [], files: null, mode: 'write', json: false, fetch: true };
  const take = (k, v) => { (o[k] ||= []).push(v); };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--check') o.mode = 'check';
    else if (a === '--inventory') o.mode = 'inventory';
    else if (a === '--json') o.json = true;
    else if (a === '--no-fetch') o.fetch = false;
    else if (a === '--config') o.config = v();
    else if (a === '--repository') o.repository = v();
    else if (a === '--file') take('files', v());
    else if (a === '--source') o.source = v();
    else if (a === '--source-ref') o.sourceRef = v();
    else if (a === '--source-dir') o.sourceDir = v();
    else if (a === '--sha') o.sha = v();
    else if (a === '--root') take('roots', v());
    else if (a === '--repo') take('repos', v());
    else if (a === '--only') o.only.push(v());
    else if (a === '--guard-job') o.guardJob = v();
    else if (a === '--default-permissions') o.defaultPermissions = v();
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  return o;
}

export function loadOptions(argv, toolDir) {
  const cli = parseArgs(argv);
  const cfgPath = cli.config || path.join(toolDir, 'pin-github-checks.config.json');
  let cfg = {};
  if (fs.existsSync(cfgPath)) {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const base = path.dirname(path.resolve(cfgPath));
    const abs = (p) => (p == null ? p : path.resolve(base, p));
    if (cfg.source) cfg.source = abs(cfg.source);
    if (cfg.roots) cfg.roots = cfg.roots.map(abs);
    if (cfg.repos) cfg.repos = cfg.repos.map(abs);
  } else if (cli.config) {
    throw new Error(`config ${cli.config} not found`);
  }
  const o = { ...cfg };
  for (const [k, v] of Object.entries(cli)) {
    if (v === null || v === undefined || k === 'only') continue;
    o[k] = v;
  }
  o.only = cli.only.length ? cli.only : cfg.only || [];
  // A CLI root/repo REPLACES the configured scan set rather than adding to it,
  // so a test or a one-off run can point at exactly one tree.
  if (cli.roots || cli.repos) { o.roots = cli.roots || []; o.repos = cli.repos || []; }
  // Likewise a CLI --source-dir replaces a configured git source.
  if (cli.sourceDir) o.source = null;
  o.defaultPermissions = o.defaultPermissions || 'write';
  if (!o.repository) throw new Error('no --repository (and none in config)');
  if (!o.files?.length && o.mode !== 'inventory') throw new Error('no --file given (and none in config)');
  return o;
}

export function run(argv, { toolDir = path.dirname(fileURLToPath(import.meta.url)), log = (s) => process.stdout.write(s + LF) } = {}) {
  const o = loadOptions(argv, toolDir);
  if (o.help) { log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split(LF).filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join(LF)); return 0; }
  const expected = o.mode === 'inventory' && !o.source && !o.sourceDir ? null : resolveExpected(o);
  if (!expected && o.mode === 'write') throw new Error('rewriting needs an expected pin: --source, or --source-dir with --sha');
  const { repos, files } = discover(o);
  const result = { mode: o.mode, repository: o.repository, expected, reposVisited: repos.length, workflowsVisited: files.length, referencing: 0, offending: [], changed: [], errors: [], rows: [] };

  for (const { repo, file } of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(process.cwd(), file).split(path.sep).join('/');
    const chk = checkWorkflow(text, o, expected);
    if (!chk.refs && !chk.gates) continue;
    result.referencing++;
    for (const row of chk.rows) result.rows.push({ repo: path.basename(path.resolve(repo)), file: rel, ...row });
    if (o.mode === 'check' || o.mode === 'inventory') {
      if (chk.problems.length) result.offending.push({ file: rel, problems: chk.problems });
      continue;
    }
    const rw = rewriteWorkflow(text, o, expected);
    if (rw.errors.length) { result.errors.push({ file: rel, errors: rw.errors }); continue; }
    if (rw.changed) {
      fs.writeFileSync(file, rw.text);
      result.changed.push({ file: rel, notes: rw.notes });
    }
    const after = checkWorkflow(rw.changed ? rw.text : text, o, expected);
    if (after.problems.length) result.offending.push({ file: rel, problems: after.problems });
  }

  if (o.json) log(JSON.stringify(result, null, 2));
  else {
    if (o.mode === 'inventory') for (const r of result.rows) log(`${r.repo}\t${r.file}\t${r.job}\t${r.cls}\t${r.state}`);
    for (const c of result.changed) log(`CHANGED ${c.file}${c.notes.length ? ' -- ' + c.notes.join('; ') : ''}`);
    for (const e of result.errors) for (const m of e.errors) log(`ERROR   ${e.file}: ${m}`);
    for (const f of result.offending) for (const p of f.problems) log(`FAIL    ${f.file} (${p.where}) [${p.code}] ${p.message}`);
    log(`Visited ${result.reposVisited} repos, ${result.workflowsVisited} workflow files; ${result.referencing} reference ${o.repository}.`);
    if (expected) log(`Expected pin: ${o.repository}@${expected.sha}`);
    else log('Expected pin: UNKNOWN (no source) -- drift was not checked, only structure.');
    const failing = new Set([...result.offending.map((f) => f.file), ...result.errors.map((e) => e.file)]);
    log(`${failing.size} offending workflow file(s)${o.mode === 'write' ? `, ${result.changed.length} rewritten` : ''}.`);
  }
  if (o.mode === 'inventory') return 0;
  return result.offending.length || result.errors.length ? 1 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`pin-github-checks: ${e.message}${LF}`);
    process.exitCode = 2;
  }
}
