import { existsSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, basename } from 'node:path';

// Claims stay next to their evidence key. A changed value reports the prose
// location, not merely the source JSON that a reader never saw.
export function compareClaims(file, text, metrics) {
  const failures = [];
  const pattern = /<!-- metric:([^\s]+) -->([\s\S]*?)<!-- \/metric -->/g;
  const spans = [];
  for (const match of text.matchAll(pattern)) {
    const line = text.slice(0, match.index).split('\n').length;
    spans.push([match.index, match.index + match[0].length]);
    if (!Object.hasOwn(metrics, match[1])) {
      failures.push(`${file}:${line}: unknown metric ${match[1]}`);
    } else if (typeof metrics[match[1]] !== 'string' && !Number.isSafeInteger(metrics[match[1]])) {
      failures.push(`${file}:${line}: producer returned no usable value for ${match[1]}`);
    } else if (match[2] !== String(metrics[match[1]])) {
      failures.push(`${file}:${line}: metric ${match[1]}\n- ${match[2]}\n+ ${metrics[match[1]]}`);
    }
  }
  for (const match of text.matchAll(/<!--\s*metric:/g)) {
    if (!spans.some(([start, end]) => match.index >= start && match.index < end)) {
      failures.push(`${file}:${text.slice(0, match.index).split('\n').length}: malformed or unterminated metric claim`);
    }
  }
  return failures;
}

// This is a prose convention, not a natural-language proof. It catches the
// known inventory/count forms; historical claims and thresholds remain prose.
export function unmarkedCounts(file, text) {
  const failures = [];
  let fenced = false;
  const number = '(?:\\d+|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen)';
  const count = new RegExp(`\\b${number}\\s+(?:(?:golden-based|cross-language|security|verified)\\s+)?(?:cases?|suites?|corpora|families)\\b|\\b${number}\\s+adversarial rows?\\b`, 'i');
  for (const [index, line] of text.split('\n').entries()) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced || /\b(?:at least|fewer than|minimum|criterion)\b/i.test(line)) continue;
    const prose = line.replace(/<!-- metric:[^\s]+ -->[\s\S]*?<!-- \/metric -->/g, '[generated]').replace(/[*`]/g, '');
    const suiteTable = /^\s*\|\s*[a-z][a-z-]+\s*\|\s*(?:request-payload|response-parse|roundtrip|error-code|container-identity|security-corpus|derivation-corpus)\s*\|\s*\d+\s*\|/.test(prose);
    if (count.test(prose) || suiteTable) failures.push(`${file}:${index + 1}: unmarked produced count; use a metric claim or describe the historical/threshold context explicitly`);
  }
  return failures;
}

export function checkRunner(root, label, implementation) {
  const failures = [];
  const unchecked = [];
  if (implementation.status !== 'full') {
    if (!implementation.cause?.trim()) failures.push(`${label}: non-full status requires cause`);
    if (!implementation.gap?.trim()) failures.push(`${label}: non-full status requires gap`);
  }
  const runner = implementation.runner;
  if (!runner) {
    if (implementation.status === 'full') failures.push(`${label}: full status requires a runner`);
    return { failures, unchecked };
  }
  const match = /^([a-z0-9-]+):(.+)$/.exec(runner);
  if (!match) {
    failures.push(`${label}: invalid runner locator ${runner}; expected repository:path`);
  } else if (match[1] !== 'prism-parity') {
    unchecked.push(`${label}: ${runner} (external checkout required)`);
  } else {
    const path = resolve(root, match[2]);
    const rel = relative(root, path);
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
      failures.push(`${label}: runner points outside this checkout: ${runner}`);
    } else if (!existsSync(path) || !statSync(path).isFile()) {
      failures.push(`${label}: claimed runner is missing or is not a file: ${runner}`);
    }
  }
  return { failures, unchecked };
}

export function requireVerdict(name, result, rule) {
  if (result.error || result.status !== 0) {
    throw new Error(`${name}: gate failed (exit ${result.status ?? 'unavailable'}): ${result.error?.message ?? result.stderr ?? ''}`);
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(/\r/g, '');
  if (!rule.verdict.test(output)) throw new Error(`${name}: missing gate's own verdict; exit zero is insufficient`);
  return output;
}

// Workflows exempt from the COORDINATOR ARRANGEMENT, and why in full, because an
// exemption without a recorded reason is a permissive default nobody revisits --
// which is how most entries in gates-pointed-at-nothing.md begin.
//
// publish.yml: publishing is a tag push and nothing else. Its own header states
// why there is no manual dispatch and no publish-from-a-branch path -- both let a
// release exist that no commit in this repository claims. Forcing it to
// workflow_call would hand that trigger to the coordinator and reintroduce
// exactly what the header forbids. It is also not a gate; it is the thing gates
// protect, so the coordinator has no business invoking it.
//
// THE EXEMPTION IS DELIBERATELY NARROW. It covers the trigger rule and the
// coordinator-invocation rule only. publish.yml is still held to the verdict
// wrapper, because a gate it runs must produce evidence like any other -- and it
// runs two. A test asserts that narrowness rather than trusting this comment.
export const COORDINATOR_EXEMPT = new Set(['publish.yml']);

// Enforce this repository's explicit block-style job convention. This is not a
// general YAML parser: unfamiliar job layouts fail rather than being ignored.
export function checkWorkflowDependencies(file, text) {
  const failures = [];
  const jobText = text.split(/^jobs:\s*$/m)[1];
  if (!jobText) return [`${file}: no jobs discovered`];
  const jobs = [...jobText.matchAll(/^  ([\w-]+):\s*\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/gm)];
  const headers = [...jobText.matchAll(/^  (?!#)\S.*$/gm)];
  if (headers.length !== jobs.length) failures.push(`${file}: unsupported job layout; use unquoted block-style job ids`);
  if (basename(file) === 'alignment.yml') {
    const coordinator = jobs.find(([, name]) => name === 'alignment')?.[2] ?? '';
    if (!coordinator.includes('run: node tools/alignment.mjs') || !coordinator.includes('run: node tools/run-gate.mjs remote -- node tools/remote-alignment.mjs')) {
      failures.push(`${file}: missing local or remote alignment entrypoint`);
    }
    for (const [, name, body] of jobs) {
      if (name !== 'alignment' && !/^    needs: alignment\s*$/m.test(body)) failures.push(`${file}: ${name} needs alignment before it runs`);
    }
    if (jobs.length < 2) failures.push(`${file}: expected alignment and at least one dependent job`);
  } else if (!COORDINATOR_EXEMPT.has(basename(file))) {
    const events = text.match(/^on:\s*\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m)?.[1] ?? '';
    const keys = [...events.matchAll(/^  ([\w-]+):/gm)].map((match) => match[1]);
    if (keys.length !== 1 || keys[0] !== 'workflow_call') failures.push(`${file}: only workflow_call is allowed; the alignment coordinator owns triggers`);
    if (jobs.length === 0) failures.push(`${file}: no reusable jobs discovered`);
  }
  // Existing gate entrypoints must keep their evidence wrapper. Install/build
  // commands are not verdict producers and are intentionally outside this list.
  const gateInvocation = /(?:tools\/(?:guard-corpus|parity-check|sync-corpus|trust-rubric|factcheck|generate-goldens)\.|scripts\/cross-check\.mjs|runners\/php\/runner\.php|third-party\/check\.mjs|php tests\/run\.php|node --test|python -m (?:pytest|mypy|ruff))/;
  for (const [index, line] of text.split('\n').entries()) {
    const code = line.trim().replace(/^-\s+/, '');
    if (!code.startsWith('#') && /^(?:run:\s*)?(?:node|php|python)\s/.test(code) && gateInvocation.test(code) && !code.includes('tools/run-gate.mjs')) {
      failures.push(`${file}:${index + 1}: gate invocation lacks verdict wrapper`);
    }
  }
  return failures;
}

// Independent accounting oracle: assert the reporting helper cannot turn
// silence into agreement. Used with synthetic reports by the first CI job.
export function verifyCoverage(reports, actual) {
  const failures = [];
  const keys = new Set();
  const rows = new Map();
  const expectedSkips = [];
  const suites = new Map();
  for (const [language, documents] of reports) {
    const languageRows = new Map();
    for (const document of documents) {
      if (document.results.length === 0) failures.push(`${document.suite}/${language}: no rows reported`);
      for (const result of document.results) {
        const key = `${document.suite}/${result.id}`;
        if (languageRows.has(key)) failures.push(`${key}/${language}: duplicate verdict`);
        if (!['pass', 'fail', 'skip'].includes(result.status)) failures.push(`${key}/${language}: unknown verdict ${result.status}`);
        if (result.status === 'skip' && (typeof result.reason !== 'string' || !result.reason.trim())) failures.push(`${key}/${language}: skip requires a reason`);
        keys.add(key);
        languageRows.set(key, result.status);
        suites.set(document.suite, [...(suites.get(document.suite) ?? []), result.status]);
        if (result.status === 'skip') expectedSkips.push({ key, language, reason: result.reason ?? 'No reason reported.' });
      }
    }
    rows.set(language, languageRows);
  }
  const expected = [...keys].filter((key) => [...rows.values()].every((row) => row.get(key) === 'pass')).sort();
  if (JSON.stringify([...actual.verified].sort()) !== JSON.stringify(expected)) failures.push('verified count includes unrun rows or omits executed agreement');
  const sorted = (values) => values.map((value) => JSON.stringify(value)).sort();
  if (JSON.stringify(sorted(actual.skips)) !== JSON.stringify(sorted(expectedSkips))) failures.push('skip report omits a language, case, or reason');
  if (actual.skippedCases !== new Set(expectedSkips.map(({ key }) => key)).size) failures.push('skipped case count disagrees with per-language skips');
  for (const [suite, statuses] of suites) {
    if (statuses.length > 0 && statuses.every((status) => status === 'skip')) failures.push(`${suite}: suite skipped in every language`);
  }
  return failures;
}
