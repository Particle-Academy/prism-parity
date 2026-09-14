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

const check = process.argv.includes('--check');
const path = join(root, 'suites', 'harness-thread-rows', 'cases.json');
let raw = readFileSync(path, 'utf8');
const document = JSON.parse(raw);

// The same conversion prism-harness-ts/test/thread-rows-corpus.test.ts makes.
export function rowsFor(testCase, { assistantRow, toolResultRow, threadView }) {
  if (testCase.fold !== undefined) return threadView(testCase.fold);

  const input = testCase.input;

  if (input.write === 'assistant') {
    return [
      assistantRow(
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
      ),
    ];
  }

  return [
    toolResultRow(
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
  const produced = JSON.stringify(rowsFor(testCase, harness));

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
