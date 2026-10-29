import assert from 'node:assert/strict';

// Expectations come from the fixture contract, never from another port's answer.
export function validateCoexistence(spec, reports) {
  assert.equal(spec.format, 'harness-coexistence-v1');
  assert.equal(spec.agents.length, 3);
  assert.equal(spec.boot_orders.length, 6);
  assert.equal(new Set(spec.boot_orders.map(JSON.stringify)).size, 6);
  const sorted = values => [...values].sort((a, b) => a.name.localeCompare(b.name));
  for (const language of ['php', 'ts', 'py']) {
    const rows = reports[language];
    assert.equal(rows.length, 6, `${language}: no missing or skipped boot orders`);
    for (const [index, row] of rows.entries()) {
      const at = `${language}/order${index}`;
      assert.deepEqual(row.order, spec.boot_orders[index], at);
      const { native: approvalNative, ...approval } = row.approval;
      const { native: childNative, ...childAuthority } = row.child_authority;
      assert.deepEqual(childAuthority, { refused: true, requests: 0, handlers: 0, ledger_steps: 0, storage_writes: 0 }, at + ': child cannot request a different actor');
      assert.equal(typeof childNative?.class, 'string', at + ': retain native child authority refusal');
      assert.deepEqual(approval, { pending_created: true, foreign_decision_visible: false, foreign_request_visible: false, foreign_handlers: 0, source_without_decision_handlers: 0, own_approval_handlers: 1 }, at + ': approval authority remains with its session');
      assert.equal(typeof approvalNative.foreign_id, 'string');
      assert.equal(typeof approvalNative.own_id, 'string');
      assert.deepEqual([...row.order].sort(), [...spec.agents].sort(), at);
      assert.deepEqual(row.agents.map(entry => entry.agent), spec.agents, `${at}: no missing agents`);
      for (const result of row.agents) {
        const key = `${at}/${result.agent}`, agent = result.agent;
        const expected = spec.expected_tools.map(entry => ({ name: entry.name.replace('$agent', agent), owner: entry.owner.replace('$agent', agent), source: entry.source }));
        assert.deepEqual(sorted(result.inspection), sorted(expected), `${key}: exact inspection authority`);
        assert.deepEqual([...result.offered].sort(), expected.map(entry => entry.name).sort(), `${key}: exact model offer`);
        assert.deepEqual(result.inspection_safe, { writes: 0, requests: 0, handlers: 0 }, `${key}: side-effect-free inspection`);
        assert.deepEqual(result.inspection_providers, [agent], `${key}: inspection provider isolation`);
        assert.deepEqual(result.offer_providers, [agent], `${key}: offer provider isolation`);
        assert.equal(result.result, `owned:${agent}`, `${key}: positive handler`);
        assert.equal(result.positive_handlers, 1, `${key}: positive handler runs exactly once`);
        assert.equal(result.hostile_requests, 0, `${key}: no hostile model request`);
        assert.equal(result.hostile_handlers, 0, `${key}: no hostile handler`);
        assert.equal(result.foreign_registry.refused, true, `${key}: bound registry must reject foreign session`);
        assert.equal(typeof result.foreign_registry.native?.class, 'string', `${key}: native namespace refusal`);
        assert.deepEqual(result.handoff, { same_actor: true, adapter_calls: 0, same_owner: true, same_agent: true, distinct_address: true }, key + ': child inherits bound authority');
        const foreign = spec.agents.find(candidate => candidate !== agent);
        assert.deepEqual(result.refusals.map(entry => entry.name), spec.hostile_requests.map(name => name.replace('$foreign', foreign)), `${key}: no missing hostile controls`);
        for (const refusal of result.refusals) {
          assert.equal(refusal.refused, true, `${key}/${refusal.name}: widening refused`);
          assert.equal(typeof refusal.native?.class, 'string', `${key}: retain native error class`);
          assert.equal(typeof refusal.native?.message, 'string', `${key}: retain native error message`);
        }
      }
      assert.deepEqual(row.collisions.map(entry => entry.id), spec.collision_cases.map(entry => entry.id), `${at}: no missing collision controls`);
      for (const [index, test] of spec.collision_cases.entries()) {
        const result = row.collisions[index], key = `${at}/${test.id}`;
        assert.equal(result.refused, true, `${key}: duplicate registration refused`);
        assert.equal(result.handlers, 0, `${key}: no collision handler`);
        assert.equal(result.native?.code, 'registration_collision', `${key}: typed collision`);
        assert.equal(result.native?.message, `Harness registry collision: agent [support], name [lookup], owners [${test.owners[0]}] and [${test.owners[1]}]. Use replace naming predecessor owner [${test.owners[0]}].`, `${key}: actionable owner diagnostic`);
      }
      assert.deepEqual(row.child_policy.map(value => value.phase), spec.child_policy_cases.map(value => value.phase), at + ': no missing child policy controls');
      for (const [policyIndex, test] of spec.child_policy_cases.entries()) {
        const { native, ...actual } = row.child_policy[policyIndex];
        assert.deepEqual(actual, { phase: test.phase, offered: test.offered, handlers: test.handlers, offer_policy_checked: true, call_policy_checked: test.call_policy_checked, actor_matches_parent: true }, at + ': child rechecks ' + test.phase);
        assert.equal(typeof native.outcome, 'string', at + ': retain native child policy outcome');
      }
      for (const id of ['task_only', 'extra_actor']) {
        const { native, ...actual } = row.legacy_child[id];
        const expected = id === 'task_only' ? { refused: false, requests: 1, child_started: true, actor_matches_parent: true } : spec.legacy_child.expected[language];
        assert.deepEqual(actual, expected, at + ': record native legacy extra-actor divergence/' + id);
        assert.equal(typeof native.class, 'string', at + ': retain native legacy result');
      }
    }
  }
  return { languages: 3, bootOrdersPerLanguage: 6, agentsPerOrder: 3, positiveHandlers: 54, hostileRequestsRefused: 162, foreignRegistriesRefused: 54, collisionsRefused: 90, boundActorHandoffs: 54, approvalBoundaries: 18, childAuthorityRefusals: 18, childPolicyCases: 54, legacyExtraActorDivergences: 18, legacyChildPositiveControls: 18, skipped: 0 };
}
