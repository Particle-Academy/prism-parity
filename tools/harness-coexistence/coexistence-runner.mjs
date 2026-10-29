import fs from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const spec = JSON.parse(fs.readFileSync(new URL('./coexistence-cases.json', import.meta.url)));
const pkg = await import(pathToFileURL(join(process.env.PRISM_HARNESS_TS, 'dist/index.js')));
const rows = [];
for (const [number, order] of spec.boot_orders.entries()) {
  const directory = join(process.env.PRISM_COEXIST_WORK, `ts-${number}`);
  const store = new pkg.FileSessionStore(directory), tools = new pkg.ToolRegistry(), modes = new pkg.ModeRegistry(), adapters = new pkg.ParticipantAdapters();
  const participant = new pkg.ParticipantRef(spec.participant.type, spec.participant.id);
  let adapterCalls = 0;
  adapters.register(participant.type, () => ({ resolution: ++adapterCalls }));
  let handlers = 0, requests = 0, approvalPhase = false, nextApproval = false;
  const calls = [], offered = [];
  const tool = (name, agent) => ({ name, handle: () => { handlers++; return `owned:${agent}`; } });
  tools.register(tool(spec.legacy_tool, 'legacy'));
  tools.registerProvider(() => { throw Error('A named agent invoked the legacy provider'); });
  for (const agent of order) {
    const registry = tools.forAgent(agent);
    registry.register(tool('lookup', agent), agent)
      .register(tool(spec.omitted_tool, agent), 'harness')
      .registerFactory('context', () => tool('context', agent), agent)
      .registerProvider(() => { calls.push(agent); return [tool(`remote_${agent}`, agent)]; }, agent, 'catalog');
    modes.forAgent(agent).register(spec.mode, { tools: spec.expected_tools.map(row => row.name.replace('$agent', agent)) }, agent).setDefault(spec.mode);
  }
  const runtime = new pkg.AgentRuntime({ tools, modes, client: async request => {
    requests++;
    offered.push(request.tools.map(tool => tool.name));
    if (approvalPhase) {
      if (nextApproval) { nextApproval = false; return { text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'approval-call', name: spec.approval.tool, arguments: {} }] }; }
      return { text: 'done', finishReason: 'stop' };
    }
    const result = await request.tools.find(tool => tool.name === spec.positive_tool).handle({});
    return { text: result, finishReason: 'stop' };
  } });
  const harness = new pkg.PrismHarness({ runtime, participantAdapters: adapters, drivers: { owned: () => store }, stores: { ephemeral: 'owned', durable: 'owned' } });
  const agents = [];
  for (const agent of spec.agents) {
    const session = harness.forAgent(agent).for(participant).session(spec.scope);
    const beforeFiles = fs.existsSync(directory) ? fs.readdirSync(directory).map(name => [name, fs.readFileSync(join(directory, name), 'hex')]) : [];
    const beforeRequests = requests, beforeHandlers = handlers;
    calls.length = 0;
    const inspection = await runtime.effectiveTools(session, spec.mode), inspectionCalls = [...calls];
    const afterFiles = fs.existsSync(directory) ? fs.readdirSync(directory).map(name => [name, fs.readFileSync(join(directory, name), 'hex')]) : [];
    const inspectionSafe = { writes: JSON.stringify(beforeFiles) === JSON.stringify(afterFiles) ? 0 : 1, requests: requests - beforeRequests, handlers: handlers - beforeHandlers };
    calls.length = 0;
    const response = await runtime.send(session, 'go'), offerCalls = [...calls], actual = offered.at(-1);
    const foreign = spec.agents.find(candidate => candidate !== agent), errors = [];
    const hostileRequests = requests, hostileHandlers = handlers;
    for (const template of spec.hostile_requests) {
      const name = template.replace('$foreign', foreign);
      try { await runtime.send(session, 'forged', [name]); errors.push({ name, refused: false, native: null }); }
      catch (error) { errors.push({ name, refused: true, native: { class: error.constructor.name, code: error.code ?? null, message: error.message } }); }
    }
    const beforeAdapter = adapterCalls;
    const child = harness.pending(session.participant, session.agent, session.actor).session(spec.scope + '::sub::worker');
    const handoff = { same_actor: child.actor === session.actor, adapter_calls: adapterCalls - beforeAdapter, same_owner: child.participant === session.participant, same_agent: child.agent === agent, distinct_address: child.key() !== session.key() };
    let foreignRegistry;
    try { await tools.forAgent(agent).resolveDetailed(['*'], harness.forAgent(foreign).for(participant).session(spec.scope)); foreignRegistry = { refused: false, native: null }; }
    catch (error) { foreignRegistry = { refused: true, native: { class: error.constructor.name, code: error.code ?? null, message: error.message } }; }
    agents.push({ agent, inspection, offered: actual, inspection_safe: inspectionSafe, inspection_providers: inspectionCalls, offer_providers: offerCalls, result: response.text, positive_handlers: handlers - beforeHandlers, hostile_requests: requests - hostileRequests, hostile_handlers: handlers - hostileHandlers, refusals: errors, foreign_registry: foreignRegistry, handoff });
  }
  const collisions = [];
  for (const test of spec.collision_cases) {
    const registry = new pkg.ToolRegistry().forAgent('support'), before = handlers;
    const add = (source, owner, id) => {
      if (source === 'static') registry.register(tool('lookup', 'support'), owner);
      if (source === 'factory') registry.registerFactory('lookup', () => tool('lookup', 'support'), owner);
      if (source === 'provider' || source === 'duplicate-provider') registry.registerProvider(() => Array.from({ length: source === 'duplicate-provider' ? 2 : 1 }, () => tool('lookup', 'support')), owner, id);
    };
    let native = null;
    try { add(test.first, test.owners[0], 'first'); add(test.second, test.owners[1], 'second'); await registry.resolveDetailed(['*'], harness.forAgent('support').for(participant).session(spec.scope)); }
    catch (error) { native = { class: error.constructor.name, code: error.code ?? null, message: error.message }; }
    collisions.push({ id: test.id, refused: native !== null, handlers: handlers - before, native });
  }
  approvalPhase = true;
  for (const agent of [spec.approval.source, spec.approval.foreign]) modes.forAgent(agent).register(spec.approval.mode, { tools: [spec.approval.tool], requires_approval: [spec.approval.tool] }, agent);
  const approvalSession = async (agent, scope) => { const session = harness.forAgent(agent).for(participant).session(scope); await session.usingMode(spec.approval.mode); return session; };
  const source = await approvalSession(spec.approval.source, spec.approval.scope), foreign = await approvalSession(spec.approval.foreign, spec.approval.scope);
  nextApproval = true;
  const pending = await runtime.send(source, 'request approval'), id = pending.pendingApprovals[0].id;
  const beforeForeign = handlers;
  await pkg.recordApproval(foreign, id, true);
  const sourceMessages = await source.thread().messages(), foreignMessages = await foreign.thread().messages();
  const decisionVisible = sourceMessages.some(row => (row.message.tool_approval_responses ?? []).some(value => value.approval_id === id && value.approved === true));
  const requestVisible = foreignMessages.some(row => (row.message.tool_approval_requests ?? []).some(value => value.approval_id === id));
  await runtime.send(foreign, '');
  const foreignHandlers = handlers - beforeForeign;
  const beforeSource = handlers;
  await runtime.send(source, '');
  const sourceHandlers = handlers - beforeSource;
  const own = await approvalSession(spec.approval.source, spec.approval.scope + ':positive');
  nextApproval = true;
  const ownPending = await runtime.send(own, 'request approval'), ownId = ownPending.pendingApprovals[0].id;
  const beforeOwn = handlers;
  await pkg.recordApproval(own, ownId, true);
  await runtime.send(own, '');
  const approval = { pending_created: pending.pendingApprovals.length === 1 && ownPending.pendingApprovals.length === 1, foreign_decision_visible: decisionVisible, foreign_request_visible: requestVisible, foreign_handlers: foreignHandlers, source_without_decision_handlers: sourceHandlers, own_approval_handlers: handlers - beforeOwn, native: { foreign_id: id, own_id: ownId, initial_finish: pending.finishReason } };
  const parent = harness.forAgent('support').for(participant).session('child-authority'), context = pkg.RunContext.root('child-authority-root', new pkg.RunBudget(10));
  const runner = new pkg.SubagentRunner(harness, runtime), declaration = new pkg.Subagent('worker', 'Worker', spec.mode, new pkg.RunBudget(2));
  const beforeChildRequests = requests, beforeChildHandlers = handlers;
  const childSnapshot = () => fs.readdirSync(directory).sort().map(name => [name, fs.readFileSync(join(directory, name), 'hex')]);
  const beforeChildFiles = childSnapshot();
  let childNative = null;
  try { await runner.tool(declaration, parent, context, 'parent-run').handle(spec.child_request); }
  catch (error) { childNative = { class: error.constructor.name, code: error.code ?? null, message: error.message }; }
  const childAuthority = { refused: childNative !== null, requests: requests - beforeChildRequests, handlers: handlers - beforeChildHandlers, ledger_steps: context.ledger.steps, storage_writes: JSON.stringify(beforeChildFiles) === JSON.stringify(childSnapshot()) ? 0 : 1, native: childNative };
  modes.forAgent('support').register('policy-child', { tools: ['lookup'] }, 'support');
  const childPolicy = [];
  for (const test of spec.child_policy_cases) {
    let granted = test.phase !== 'offer_revoked', offerChecks = 0, callChecks = 0, actorMatches = true, modelCalls = 0, actualOffer = [];
    const expectedActor = parent.actor, beforeHandlers = handlers;
    const authorizer = new pkg.ToolAuthorizer({ enabled: true, agents: { support: {
      offer: (view, tool) => { offerChecks++; actorMatches &&= view.actor === expectedActor; return granted && tool.name === 'lookup'; },
      call: view => { callChecks++; actorMatches &&= view.actor === expectedActor; return granted; },
    } } });
    const policyRuntime = new pkg.AgentRuntime({ tools, modes, authorizer, client: async request => {
      modelCalls++; if (modelCalls === 1) actualOffer = request.tools.map(tool => tool.name);
      if (test.phase === 'call_revoked') granted = false;
      return modelCalls === 1 && test.phase !== 'offer_revoked' ? { text: '', finishReason: 'tool_calls', costUsd: 0, toolCalls: [{ id: 'policy-call', name: 'lookup', arguments: {} }] } : { text: 'done', finishReason: 'stop', costUsd: 0 };
    } });
    const policyContext = pkg.RunContext.root('policy-root', new pkg.RunBudget(10));
    const result = await new pkg.SubagentRunner(harness, policyRuntime).run(new pkg.Subagent('policy_' + test.phase, 'Policy child', 'policy-child', new pkg.RunBudget(2)), parent, policyContext, 'parent-run', 'go');
    childPolicy.push({ phase: test.phase, offered: actualOffer, handlers: handlers - beforeHandlers, offer_policy_checked: offerChecks > 0, call_policy_checked: callChecks > 0, actor_matches_parent: actorMatches, native: { outcome: result.outcome, requests: modelCalls, ledger_steps: policyContext.ledger.steps, kind: 'runtime child loop' } });
  }
  const legacyTools = new pkg.ToolRegistry(), legacyModes = new pkg.ModeRegistry(), legacyActor = { id: 'host-principal-A' };
  const legacyState = { requests: 0, actors: [] };
  legacyTools.registerFactory('actor_probe', view => { legacyState.actors.push(view.actor); return { name: 'actor_probe', handle: () => { throw Error('Legacy actor probe handler must not run'); } }; });
  legacyModes.register('legacy-child', { tools: ['actor_probe'] });
  const legacyRuntime = new pkg.AgentRuntime({ tools: legacyTools, modes: legacyModes, client: async () => { legacyState.requests++; return { text: 'done', finishReason: 'stop', costUsd: 0 }; } });
  const legacyHarness = new pkg.PrismHarness({ runtime: legacyRuntime, drivers: { owned: () => store }, stores: { ephemeral: 'owned', durable: 'owned' } });
  const legacyParent = legacyHarness.for({ type: 'legacy-owner', id: '1' }).asActor(legacyActor).session('legacy-authority');
  const legacyChild = {};
  for (const [id, input] of [['task_only', { task: spec.legacy_child.request.task }], ['extra_actor', spec.legacy_child.request]]) {
    const beforeRequests = legacyState.requests, beforeActors = legacyState.actors.length;
    const legacyContext = pkg.RunContext.root('legacy-' + id, new pkg.RunBudget(10));
    let native = { class: 'string', result: null, ledger_steps: 0 }, refused = false;
    try { native.result = await new pkg.SubagentRunner(legacyHarness, legacyRuntime).tool(new pkg.Subagent('legacy_' + id, 'Legacy child', 'legacy-child', new pkg.RunBudget(2)), legacyParent, legacyContext, 'parent-run').handle(input); }
    catch (error) { refused = true; native = { class: error.constructor.name, message: error.message }; }
    native.ledger_steps = legacyContext.ledger.steps;
    const actorViews = legacyState.actors.slice(beforeActors);
    legacyChild[id] = { refused, requests: legacyState.requests - beforeRequests, child_started: actorViews.length > 0, actor_matches_parent: actorViews.length ? actorViews.every(actor => actor === legacyActor) : null, native };
  }
  rows.push({ order, agents, collisions, approval, child_authority: childAuthority, child_policy: childPolicy, legacy_child: legacyChild });
}
console.log(JSON.stringify(rows));
