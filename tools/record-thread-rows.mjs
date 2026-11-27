#!/usr/bin/env node
// Record the TypeScript rows in suites/harness-thread-rows/cases.json, by running
// prism-harness-ts's real assistantRow(), toolResultRow() and threadView() -- the
// builders AgentRuntime records with and the view it replays -- on each case.
//
// The case file is edited as TEXT, replacing each `"ts": ...` string in place and
// recomputing `agrees`, so the recorder cannot reformat or retype the rows it
// records.
//
//   PRISM_HARNESS_TS=../prism-harness-ts node tools/record-thread-rows.mjs [--check]

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const harnessRoot = process.env.PRISM_HARNESS_TS ?? join(root, '..', 'prism-harness-ts');
const harness = await import(pathToFileURL(join(harnessRoot, 'dist', 'index.js')).href);
// endedByStartRow and pairStepApprovals live in the thread-rows module, not the package index.
const rowsModule = await import(pathToFileURL(join(harnessRoot, 'dist', 'thread-rows.js')).href);
const threadModule = await import(pathToFileURL(join(harnessRoot, 'dist', 'thread.js')).href);
const m = { ...harness, ...rowsModule, readerRows: threadModule.readerRows };

const check = process.argv.includes('--check');
const path = join(root, 'suites', 'harness-thread-rows', 'cases.json');
let raw = readFileSync(path, 'utf8');
const document = JSON.parse(raw);

// The same conversion prism-harness-ts/test/thread-rows-corpus.test.ts makes
// (kept a plain-JS copy of that test's rowsFor; update both together).
function asStored(m, rows) {
  return m.readerRows(rows.map((row) => {
    const { harness, run_id: _runId, ...message } = row;
    return { message, harness: harness === true };
  }));
}

export function rowsFor(testCase, m) {
  if (testCase.fold !== undefined) return m.threadView(testCase.fold);

  // Round 15: the rows as stored, placed and then folded: what the runtime sends.
  if (testCase.place !== undefined) return m.replayView(asStored(m, testCase.place));

  if (testCase.read === 'approval_states') {
    const ended = m.endedByStart(asStored(m, testCase.stored ?? []));
    return (testCase.approvals ?? []).map((id) => ({ approval_id: id, ended_by_start: ended.has(id) }));
  }

  if (testCase.read === 'call_outcomes') {
    // 0.6.0: which calls of the step at `step` have an outcome (a result, or a started row).
    return m.stepAnswers(asStored(m, testCase.stored ?? []), (testCase.step ?? 0) - 1).map((answer) => answer !== null);
  }

  if (testCase.read === 'approval_reads') {
    // 0.6.0: per approval, whether it is pending and the decision that stands (null: none).
    const stored = asStored(m, testCase.stored ?? []);
    const pending = new Set(m.pendingApprovalIds(stored));
    const standing = m.standingDecisions(stored);
    return (testCase.approvals ?? []).map((id) => ({ approval_id: id, pending: pending.has(id), decision: standing.get(id)?.approved ?? null }));
  }

  const input = testCase.input;

  if (input.write === 'answer') {
    // 0.6.0: the answer row a resolution writes: only the results its step does not hold yet.
    const stored = asStored(m, input.stored);
    const own = m.newResults(stored, input.position - 1, input.results);
    if (own.length === 0 && input.decisions.length === 0) return [];
    const row = m.toolResultRow(own, input.decisions);
    return [own.length === 0 ? row : m.answeringStep(row, input.position)];
  }

  if (input.write === 'ended_by_start') {
    return [
      m.endedByStartRow(
        input.tool_calls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments, resultId: call.result_id ?? null })),
        m.pairStepApprovals(input.tool_calls, input.approval_requests).approvalIds,
      ),
    ];
  }

  if (input.write === 'started') {
    return [m.startedRow({ id: input.tool_call_id, name: input.tool_name }, input.approval_id, input.position)];
  }

  if (input.write === 'assistant') {
    const bind = (row) => (input.bind === true ? m.withBoundRequests(row) : row);
    return [
      bind(m.assistantRow(
        input.content,
        input.tool_calls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          resultId: call.result_id ?? null,
          reasoningId: call.reasoning_id ?? null,
          reasoningSummary: call.reasoning_summary ?? null,
        })),
        input.additional_content,
        input.approval_requests,
      )),
    ];
  }

  return [
    m.toolResultRow(
      input.results.map((result) => ({
        tool_call_id: result.tool_call_id,
        tool_name: result.tool_name,
        args: result.args,
        result: result.result,
        tool_call_result_id: result.tool_call_result_id ?? null,
        artifacts: [],
      })),
      input.decisions,
    ),
  ];
}

/** The offset just past the JSON string literal that starts at `quote`. */
function stringEnd(text, quote) {
  for (let i = quote + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '"') return i + 1;
  }

  throw new Error('Unterminated string in the case file.');
}

const stale = [];

for (const testCase of document.cases) {
  const produced = JSON.stringify(rowsFor(testCase, m));

  if (testCase.rows.ts !== produced) stale.push(testCase.id);

  const at = raw.indexOf(`"id": "${testCase.id}"`);
  const quote = raw.indexOf('"ts": ', at) + '"ts": '.length;
  raw = raw.slice(0, quote) + JSON.stringify(produced) + raw.slice(stringEnd(raw, quote));

  const agrees = produced === testCase.rows.php && produced === testCase.rows.py;
  const valueAt = raw.indexOf('"agrees": ', at) + '"agrees": '.length;
  const valueEnd = raw.startsWith('true', valueAt) ? valueAt + 4 : valueAt + 5;
  raw = raw.slice(0, valueAt) + String(agrees) + raw.slice(valueEnd);
}

if (check) {
  if (stale.length > 0) {
    process.stderr.write(`Stale ts rows: ${stale.join(', ')}\n`);
    process.exit(1);
  }

  process.stderr.write('TypeScript rows current.\n');
  process.exit(0);
}

writeFileSync(path, raw);
process.stderr.write(`Wrote ${document.cases.length} ts row set(s); ${stale.length} changed.\n`);
