import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Corpus } from '../../loaders/ts/src/index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const corpus = Corpus.open(root);
const moduleUrl = process.env.PRISM_HARNESS_TS
  ? pathToFileURL(join(process.env.PRISM_HARNESS_TS, 'dist/index.js')).href
  : import.meta.resolve('@particle-academy/prism-harness');
const harness = await import(moduleUrl);
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', moduleUrl), 'utf8')).version;
const { AgentRuntime, PrismHarness, MemorySessionStore, FileSessionStore, ModeRegistry,
  ToolRegistry, RunContext, RunBudget, HarnessError, recordApproval } = harness;
const results = [];
for (const entry of corpus.suite('harness-failed-step').cases('ts')) {
  if (entry.skipped) throw Error('Failed-step acceptance cannot skip a case');
  const directory = await mkdtemp(join(tmpdir(), 'prism-failed-step-'));
  try {
    const spec = entry.input;
    const owner = new PrismHarness({ drivers: { memory: () => new MemorySessionStore(), files: () => new FileSessionStore(directory) },
      stores: { ephemeral: 'memory', durable: 'files' } });
    const session = await owner.for({ type: 'corpus', id: entry.id }).session('failed-step');
    await session.usingProvider('anthropic');
    await session.usingModel('corpus-model');
    const modes = new ModeRegistry({ default: 'chat', modes: { chat: { tools: ['tick'], max_steps: 4,
      requires_approval: spec.guarded ? ['tick'] : [] } } });
    let models = 0, tools = 0;
    const runtime = new AgentRuntime({ modes, tools: new ToolRegistry().register({ name: 'tick', handle: () => { tools++; return 'ran'; } }),
      client: async () => {
        models++;
        return { text: '{"ok":true}', structured: { ok: true }, costUsd: 0.04,
          finishReason: models === 1 ? spec.finish : 'stop',
          toolCalls: models === 1 && spec.tools ? [{ id: 'failed-call', name: 'tick', arguments: {} }] : [] };
      } });
    const context = RunContext.root('corpus', new RunBudget(4));
    let failure = null;
    try {
      if (spec.api === 'structured') await runtime.sendStructured(session, 'go', { type: 'object' }, undefined, context);
      else await runtime.send(session, 'go', undefined, context);
    } catch (error) {
      if (!(error instanceof HarnessError)) throw error;
      failure = error;
    }
    const run = await session.run();
    const rows = (await session.thread().messages()).map(row => row.message);
    const pending = rows.filter(row => row.type === 'assistant').reduce((sum, row) => sum + (row.tool_approval_requests?.length ?? 0), 0);
    const result = { error_code: failure?.code ?? null, finish_reason: failure?.finishReason ?? run.finish_reason,
      run_status: run.status, model_calls: models, tool_calls: tools, steps: context.ledger.steps,
      cost_retained: context.ledger.costUsd === 0.04, pending_approvals: pending, resumed_tools: 0 };
    const native = { error_code: failure?.code ?? null, reason: failure?.finishReason ?? null,
      cost_usd: context.ledger.costUsd, settlement_outcome: null, package_version: packageVersion };
    await recordApproval(session, 'failed-approval', true);
    await runtime.send(session, '');
    result.resumed_tools = tools;
    results.push({ id: entry.id, result, native });
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('prism-failed-step-')) throw Error('Refusing unexpected cleanup path');
    await rm(directory, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ language: 'ts', corpus_version: corpus.version, results }));
