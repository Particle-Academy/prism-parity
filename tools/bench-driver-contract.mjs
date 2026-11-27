#!/usr/bin/env node
// G-393 / G-10 slice 1: checks an exchange against specs/bench-driver.md
// (prism-bench-driver/1). Exported for the test; run directly it checks the
// shipped conformance fixture and exits non-zero on the first broken rule.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TOOL = /^[A-Za-z0-9_-]{1,64}$/;
const STATUSES = new Set(['completed', 'budget_stopped', 'step_limit', 'aborted', 'refused', 'error', 'protocol_error']);
const OUTCOMES = new Set(['completed', 'failed', 'abandoned']);
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, min = 0) => Number.isInteger(v) && v >= min;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function need(cond, where, why) {
  if (!cond) throw new Error(`${where}: ${why}`);
}

function checkStart(m, at) {
  need(ID.test(m.run_id ?? '') && ID.test(m.task_id ?? ''), at, 'run_id/task_id malformed');
  need(typeof m.instruction === 'string' && m.instruction !== '', at, 'instruction required');
  need(Array.isArray(m.tools), at, 'tools must be a list');
  const names = new Set();
  for (const t of m.tools) {
    need(isObj(t) && TOOL.test(t.name ?? '') && !names.has(t.name), at, 'tool name malformed or duplicate');
    need(typeof t.description === 'string' && isObj(t.parameters) && t.parameters.type === 'object', at, `tool ${t.name} needs description and an object schema`);
    names.add(t.name);
  }
  need(isObj(m.model) && typeof m.model.provider === 'string' && typeof m.model.id === 'string', at, 'model.provider and model.id required');
  need(!/-4-/.test(m.model.id), at, 'retired *-4-* model ids are not allowed');
  need(isObj(m.limits) && isNum(m.limits.max_cost_usd) && m.limits.max_cost_usd > 0, at, 'limits.max_cost_usd required and positive');
  need(isInt(m.limits.max_steps, 1) && isInt(m.limits.max_output_tokens_per_call, 1), at, 'limits.max_steps / max_output_tokens_per_call must be positive integers');
  need(isObj(m.pricing) && isNum(m.pricing.inputPerMTok) && isNum(m.pricing.outputPerMTok), at, 'pricing needs inputPerMTok and outputPerMTok');
  need(m.tools.length === 0 || isNum(m.pricing.toolOverheadTokens), at, 'pricing.toolOverheadTokens required with tools');
  need(m.approval_policy === 'auto_grant_all', at, 'approval_policy must be auto_grant_all in v1');
  return names;
}

function checkUsage(m, at) {
  need(typeof m.call_id === 'string' && m.call_id !== '', at, 'usage.call_id required');
  need(OUTCOMES.has(m.outcome) && typeof m.usage_known === 'boolean', at, 'usage.outcome / usage_known');
  for (const k of ['input_tokens', 'cache_write_tokens', 'cache_read_tokens', 'output_tokens']) need(isInt(m[k]), at, `usage.${k} must be a non-negative integer`);
  need(m.reasoning_tokens === null || (isInt(m.reasoning_tokens) && m.reasoning_tokens <= m.output_tokens), at, 'reasoning_tokens is a breakdown of output_tokens');
  need(isNum(m.charged_usd) && m.charged_usd >= 0, at, 'usage.charged_usd');
}

/**
 * @param {{dir: 'driver'|'adapter', msg: object}[]} lines
 * @returns {{toolCalls: number, modelCalls: number, status: string}}
 */
export function checkExchange(lines) {
  need(lines.length >= 2, 'exchange', 'needs at least hello and end');
  let pending = null;
  let tools = null;
  let modelCalls = 0;
  let toolCalls = 0;
  let charged = 0;
  const callIds = new Set();
  lines.forEach(({ dir, msg }, i) => {
    const at = `line ${i + 1} (${msg?.type})`;
    need(dir === 'driver' || dir === 'adapter', at, 'dir must be driver or adapter');
    need(isObj(msg) && msg.v === 1 && typeof msg.type === 'string', at, 'every line is an object with v 1 and a type');
    need(Buffer.byteLength(JSON.stringify(msg)) <= MAX_LINE_BYTES, at, 'line exceeds 8 MiB');
    if (i === 0) {
      need(dir === 'driver' && msg.type === 'hello' && msg.protocol === 'prism-bench-driver/1', at, 'the driver speaks first, with hello');
      need(isObj(msg.driver) && typeof msg.driver.name === 'string' && typeof msg.driver.harness_version === 'string', at, 'hello.driver');
      return;
    }
    if (i === 1 && !(dir === 'driver' && msg.type === 'end')) {
      need(dir === 'adapter' && msg.type === 'start', at, 'the adapter answers hello with start');
      tools = checkStart(msg, at);
      return;
    }
    if (pending !== null) {
      need(dir === 'adapter', at, `the driver wrote while ${pending} was unanswered`);
      need(msg.type === 'tool_result' || msg.type === 'abort', at, 'a tool_call is answered by tool_result or abort');
      if (msg.type === 'tool_result') {
        need(msg.call_id === pending && typeof msg.output === 'string' && typeof msg.is_error === 'boolean', at, `tool_result must answer ${pending}`);
      } else {
        need(typeof msg.reason === 'string', at, 'abort.reason');
      }
      pending = null;
      return;
    }
    need(dir === 'driver', at, 'the adapter only writes start, tool_result and abort');
    switch (msg.type) {
      case 'tool_call':
        need(tools !== null && tools.has(msg.name), at, 'tool_call names an offered tool');
        need(typeof msg.call_id === 'string' && !callIds.has(msg.call_id) && isObj(msg.arguments), at, 'tool_call needs a unique call_id and object arguments');
        callIds.add(msg.call_id);
        pending = msg.call_id;
        toolCalls++;
        return;
      case 'usage':
        checkUsage(msg, at);
        modelCalls++;
        charged += msg.charged_usd;
        return;
      case 'approval':
        need(typeof msg.approval_id === 'string' && msg.decision === 'granted' && msg.policy === 'auto_grant_all', at, 'approval is a reported automatic grant');
        return;
      case 'end':
        need(i === lines.length - 1, at, 'end is the last line');
        need(STATUSES.has(msg.status), at, `unknown status ${msg.status}`);
        need(msg.code === null || typeof msg.code === 'string', at, 'end.code');
        need(typeof msg.final_text === 'string' && isInt(msg.steps) && isNum(msg.charged_usd), at, 'end.final_text / steps / charged_usd');
        need(msg.steps >= modelCalls || msg.status === 'protocol_error', at, 'end.steps cannot be fewer than the usage lines');
        need(Math.abs(msg.charged_usd - charged) < 1e-6, at, `end.charged_usd ${msg.charged_usd} != sum of usage ${charged}`);
        return;
      default:
        need(false, at, `unknown driver message type ${msg.type}`);
    }
  });
  const last = lines[lines.length - 1].msg;
  need(last.type === 'end', 'exchange', 'the driver ends with end');
  return { toolCalls, modelCalls, status: last.status };
}

export function readFixture(path) {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixture = join(here, '..', 'specs', 'bench-driver', 'conformance.jsonl');
  try {
    const result = checkExchange(readFixture(fixture));
    console.log(`bench-driver fixture OK: ${result.modelCalls} model calls, ${result.toolCalls} tool calls, status ${result.status}`);
  } catch (error) {
    console.error(`bench-driver fixture BROKEN: ${error.message}`);
    process.exit(1);
  }
}
