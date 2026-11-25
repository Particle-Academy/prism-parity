// G-285 harness-run-cancel, TypeScript runner: one scripted run per row through
// the real AgentRuntime. The model is a scripted client and fetch is refused.
// The cancel comes from a SECOND PrismHarness and runtime built on their own
// FileSessionStore instances over the same temp directory, as another process.
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Corpus } from '../../loaders/ts/src/index.js';
import { REFUSAL } from '../run-cancel-contract.mjs';
import { idForm } from './id-forms.mjs';

globalThis.fetch = () => { throw new Error('The run-cancel corpus never uses the network.'); };

const root = fileURLToPath(new URL('../../', import.meta.url));
const corpus = Corpus.open(root);
const moduleUrl = process.env.PRISM_HARNESS_TS
  ? pathToFileURL(join(process.env.PRISM_HARNESS_TS, 'dist/index.js')).href
  : import.meta.resolve('@particle-academy/prism-harness');
const harness = await import(moduleUrl);
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', moduleUrl), 'utf8')).version;
const { AgentRuntime, PrismHarness, FileSessionStore, ModeRegistry, ToolRegistry, HarnessError, HarnessEvents,
  recordApproval, recordDecisions } = harness;

const NAMES = { 'run.cancel_requested': 'cancel_requested', 'run.cancelled': 'cancelled', 'run.finished': 'finished', 'run.failed': 'failed' };
const WHO = { same: 'Ada', other: 'Bob', empty: 'Cy' };
const code = (error) => (error instanceof HarnessError ? error.code : null);
async function drain(stream) { for await (const _ of stream) { /* consume */ } }

const results = [];
for (const entry of corpus.suite('harness-run-cancel').cases('ts')) {
  if (entry.skipped) throw Error('Run-cancel acceptance cannot skip a case');
  const directory = await mkdtemp(join(tmpdir(), 'prism-run-cancel-'));
  try {
    const spec = entry.input;
    const modes = () => new ModeRegistry({ default: 'chat', modes: { chat: {
      system_prompt: 'You help.', tools: ['search', 'weather'], max_steps: 6, requires_approval: spec.requires_approval } } });
    const events = [];
    const listener = () => {
      const bus = new HarnessEvents();
      bus.listen((event) => { if (NAMES[event.type]) events.push(event); });
      return bus;
    };
    const queue = [];
    let call = 0;
    for (const step of [...spec.before.map((turn) => ({ text: turn.text })), ...spec.script]) {
      call++;
      if (step.calls) {
        queue.push({ text: '', finishReason: 'tool_calls', toolCalls: step.calls.map((name) => ({
          id: `call_g285_${++call}`, name, arguments: name === 'search' ? { query: 'tigers' } : { city: 'Detroit' } })) });
      } else {
        queue.push({ text: step.text, finishReason: 'stop', structured: { answer: step.text } });
      }
    }
    let requests = 0;
    let onRequest = null;
    let during = null;
    let toolsRun = [];
    const tools = new ToolRegistry()
      .register({ name: 'search', handle: async () => { toolsRun.push('search'); if (during) { const now = during; during = null; await now(); } return 'Found it'; } })
      .register({ name: 'weather', handle: () => { toolsRun.push('weather'); return 'Sunny'; } });
    const runtime = new AgentRuntime({ modes: modes(), tools, events: listener(), client: async () => {
      requests++;
      if (onRequest) await onRequest(requests);
      const next = queue.shift();
      if (next === undefined) throw new Error('The scripted model has no response left.');
      return next;
    } });
    // Each call builds NEW store instances over the shared directory.
    const make = (own) => new PrismHarness({
      drivers: { eph: () => new FileSessionStore(join(directory, 'ephemeral')), dur: () => new FileSessionStore(join(directory, 'durable')) },
      stores: { ephemeral: 'eph', durable: 'dur' }, runtime: own });
    const workerHarness = make(runtime);
    const worker = (name) => workerHarness.for({ type: 'User', id: name }).session('chat');
    const web = (name) => make(new AgentRuntime({ modes: modes(), tools: new ToolRegistry(), events: listener(),
      client: async () => { throw new Error('The web process never calls a model.'); } })).for({ type: 'User', id: name }).session('chat');

    let previous = null;
    for (const turn of spec.before) {
      await runtime.send(worker(WHO[turn.who]), 'setup');
      if (turn.who === 'same') previous = (await web('Ada').run())?.id ?? null;
    }
    events.length = 0;
    toolsRun = [];
    const base = requests;
    const outcomes = [];
    // The G-285 projection starts at the first cancel; earlier events are park vocabulary, kept native.
    let from = null;
    const cancel = async (cancels) => {
      if (cancels.length > 0 && from === null) from = events.length;
      const real = (await web('Ada').run())?.id;
      if (typeof real !== 'string') throw Error('The subject run has no id in the store.');
      for (const one of cancels) outcomes.push(await web(WHO[one.by]).cancel(idForm(one.id, real, previous)));
    };
    if (String(spec.cancel_at).startsWith('tool:')) during = () => cancel(spec.cancels);
    else if (String(spec.cancel_at).startsWith('request:')) {
      const at = Number(spec.cancel_at.slice(8)) + base;
      onRequest = async (request) => { if (request === at) { onRequest = null; await cancel(spec.cancels); } };
    }

    let failure = null;
    let pending = null;
    try {
      const response = await runtime.send(worker('Ada'), 'go');
      pending = response.pendingApprovals?.[0]?.id ?? null;
    } catch (error) {
      if (!(error instanceof HarnessError)) throw error;
      failure = error;
    }
    const approvalBefore = pending === null ? null : await web('Ada').approvalStatus(pending);
    if (spec.cancel_at === 'parked' || spec.cancel_at === 'after') await cancel(spec.cancels);
    await cancel(spec.after);

    let decideRefused = null, resumeRefused = null, decisions = null, resumes = null;
    if (spec.settle) {
      const attempt = async (fn) => { try { await fn(); return null; } catch (error) { return code(error) ?? String(error?.name ?? error); } };
      decisions = {
        recordApproval: await attempt(() => recordApproval(worker('Ada'), pending, true)),
        recordDenial: await attempt(() => recordApproval(worker('Ada'), pending, false)),
        recordDecisions: await attempt(() => recordDecisions(worker('Ada'), [{ approvalId: pending, approved: true }])),
        decide: await attempt(() => runtime.decide(worker('Ada'), pending, true)),
        streamDecision: await attempt(() => drain(runtime.streamDecision(worker('Ada'), [{ approvalId: pending, approved: true }]))),
      };
      resumes = {
        send: await attempt(() => runtime.send(worker('Ada'), '')),
        streamSteps: await attempt(() => drain(runtime.streamSteps(worker('Ada'), ''))),
      };
      decideRefused = Object.values(decisions).every((value) => value === 'approval_not_pending');
      resumeRefused = Object.values(resumes).every((value) => value === 'run_cancelled');
    }

    const view = web('Ada');
    const run = await view.run();
    const stored = (await view.state()).run ?? {};
    const parked = spec.cancel_at === 'parked';
    const projected = events.slice(from ?? 0);
    const final = spec.script.filter((step) => step.text).map((step) => step.text).pop() ?? null;
    const rows = (await view.thread().messages()).map((row) => row.message);
    const refused = [];
    let answerKept = false;
    const names = new Map(rows.filter((row) => row.type === 'assistant').flatMap((row) => (row.tool_calls ?? []).map((c) => [c.id, c.name])));
    for (const row of rows) {
      if (row.type === 'tool_result') for (const result of row.tool_results ?? []) if (result.result === REFUSAL) refused.push(names.get(result.tool_call_id) ?? result.tool_name ?? null);
      if (row.type === 'assistant' && final !== null && row.content === final) answerKept = true;
    }
    const cancelEvents = events.filter((event) => event.type === 'run.cancel_requested' || event.type === 'run.cancelled');
    const key = view.key();
    const tagged = cancelEvents.length === 0 ? null : cancelEvents.every((event) => event.runId === run?.id
      && event.rootRunId === event.runId && (event.parentRunId ?? null) === null && event.sessionKey === key);
    const result = {
      outcomes,
      run_status: run?.status ?? null,
      // A parked run's stored record is park vocabulary, not cancel: compared natively.
      stored_status: parked ? null : stored.status ?? null,
      ended_as: stored.ended_as ?? null,
      error_code: code(failure),
      model_calls: requests - base,
      tools_run: toolsRun,
      refused_tools: refused,
      final_answer_in_thread: answerKept,
      events: projected.map((event) => NAMES[event.type]),
      request_states: projected.filter((event) => event.type === 'run.cancel_requested').map((event) => event.state),
      events_tagged: tagged,
      approval_status_before: approvalBefore,
      approval_status_after: pending === null ? null : await view.approvalStatus(pending),
      decide_refused: decideRefused,
      resume_refused: resumeRefused,
    };
    const native = {
      event_names: events.map((event) => event.type),
      projected_from: from ?? 0,
      park_stored_status: parked ? stored.status ?? null : null,
      error: failure === null ? null : failure.constructor.name,
      decisions, resumes,
      run_id_shape: typeof run?.id === 'string' ? run.id.replace(/[0-9a-f]/g, 'x') : null,
      package_version: packageVersion,
    };
    results.push({ id: entry.id, result, native });
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('prism-run-cancel-')) throw Error('Refusing unexpected cleanup path');
    await rm(directory, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ language: 'ts', corpus_version: corpus.version, results }));
