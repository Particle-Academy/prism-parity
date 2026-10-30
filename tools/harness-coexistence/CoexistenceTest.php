<?php

declare(strict_types=1);

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Orchestra\Testbench\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;
use Prism\Harness\Modes\ModeRegistry;
use Prism\Harness\Participants\ParticipantAdapters;
use Prism\Harness\Participants\ParticipantRef;
use Prism\Harness\PrismHarness;
use Prism\Harness\PrismHarnessServiceProvider;
use Prism\Harness\Tools\ToolRegistry;
use Prism\Prism\Facades\Prism;
use Prism\Prism\PrismServiceProvider;
use Prism\Prism\PrismManager;
use Prism\Prism\Testing\TextResponseFake;
use Prism\Prism\Tool;

final class CoexistenceTest extends TestCase
{
    use RefreshDatabase;

    protected function getPackageProviders($app): array { return [PrismServiceProvider::class, PrismHarnessServiceProvider::class]; }

    protected function defineEnvironment($app): void
    {
        $app['config']->set('database.default', 'g154_owned_coexistence');
        $app['config']->set('database.connections.g154_owned_coexistence', ['driver' => 'sqlite', 'database' => ':memory:', 'prefix' => '', 'foreign_key_constraints' => true]);
        $app['config']->set('prism-harness.stores', ['ephemeral' => 'database', 'durable' => 'database']);
        $app['config']->set('prism-harness.agent.provider', 'anthropic');
        $app['config']->set('prism-harness.agent.model', 'synthetic-model');
        if ($app['config']->get('database.connections.g154_owned_coexistence.database') !== ':memory:') throw new RuntimeException('Refusing a non-owned database before migration.');
    }

    protected function defineDatabaseMigrations(): void
    {
        self::assertSame('g154_owned_coexistence', config('database.default'));
        self::assertSame(':memory:', config('database.connections.g154_owned_coexistence.database'));
    }

    public static function orders(): array
    {
        return array_map(fn (array $order): array => [$order], json_decode(file_get_contents(__DIR__.'/coexistence-cases.json'), true, 512, JSON_THROW_ON_ERROR)['boot_orders']);
    }

    #[DataProvider('orders')]
    public function test_coexistence(array $order): void
    {
        $spec = json_decode(file_get_contents(__DIR__.'/coexistence-cases.json'), true, 512, JSON_THROW_ON_ERROR);
        $tools = app(ToolRegistry::class); $modes = app(ModeRegistry::class);
        $handlers = 0; $requests = 0; $calls = []; $agents = [];
        $tool = function (string $name, string $agent) use (&$handlers): Tool {
            return (new Tool)->as($name)->for('Synthetic coexistence tool')->using(function () use (&$handlers, $agent): string { $handlers++; return 'owned:'.$agent; });
        };
        $tools->register($tool($spec['legacy_tool'], 'legacy'));
        $tools->registerProvider(fn (): never => throw new LogicException('A named agent invoked the legacy provider'));
        foreach ($order as $agent) {
            $tools->forAgent($agent)->register($tool('lookup', $agent), $agent)
                ->register($tool($spec['omitted_tool'], $agent), 'harness')
                ->registerFactory('context', fn (): Tool => $tool('context', $agent), $agent)
                ->registerProvider(function () use (&$calls, $agent, $tool): array { $calls[] = $agent; return [$tool('remote_'.$agent, $agent)]; }, $agent, 'catalog');
            $modes->forAgent($agent)->register($spec['mode'], ['tools' => array_map(fn (array $row): string => str_replace('$agent', $agent, $row['name']), $spec['expected_tools'])], $agent)->setDefault($spec['mode']);
        }
        $adapterCalls = 0;
        app(ParticipantAdapters::class)->register($spec['participant']['type'], function () use (&$adapterCalls): object { $adapterCalls++; return new stdClass; });
        $participant = new ParticipantRef(...$spec['participant']);
        $harness = app(PrismHarness::class);
        $inspecting = false; $writes = 0;
        DB::connection()->beforeExecuting(function (string $query) use (&$inspecting, &$writes): void { if ($inspecting && preg_match('/\A\s*(insert|update|delete|create|alter|drop)\b/i', $query)) $writes++; });
        foreach ($spec['agents'] as $agent) {
            $session = $harness->forAgent($agent)->for($participant)->session($spec['scope']);
            $beforeHandlers = $handlers; $beforeRequests = $requests; $writes = 0;
            $fake = Prism::fake([TextResponseFake::make()->withText('done')]);
            $calls = []; $inspecting = true;
            try { $inspection = $harness->forAgent($agent)->effectiveTools($spec['mode'], $participant, $spec['scope']); }
            finally { $inspecting = false; }
            $inspectionCalls = $calls;
            $fake->assertCallCount(0);
            $inspectionSafe = ['writes' => $writes, 'requests' => $requests - $beforeRequests, 'handlers' => $handlers - $beforeHandlers];
            $calls = []; $session->send('go');
            $offerCalls = $calls; $offered = []; $result = null;
            $fake->assertRequest(function (array $actual) use (&$offered, &$result, &$requests, $spec): void {
                $requests += count($actual);
                $offered = array_map(fn (Tool $tool): string => $tool->name(), $actual[0]->tools());
                foreach ($actual[0]->tools() as $tool) if ($tool->name() === $spec['positive_tool']) $result = $tool->handle();
            });
            $foreign = array_values(array_filter($spec['agents'], fn (string $name): bool => $name !== $agent))[0];
            $hostileHandlers = $handlers; $errors = [];
            foreach ($spec['hostile_requests'] as $template) {
                $name = str_replace('$foreign', $foreign, $template);
                try { $session->send('forged', [$name]); $errors[] = ['name' => $name, 'refused' => false, 'native' => null]; }
                catch (Throwable $error) { $errors[] = ['name' => $name, 'refused' => true, 'native' => ['class' => $error::class, 'code' => property_exists($error, 'errorCode') ? $error->errorCode : null, 'message' => $error->getMessage()]]; }
            }
            $actualRequests = 0;
            $fake->assertRequest(function (array $actual) use (&$actualRequests): void { $actualRequests = count($actual); });
            $beforeAdapter = $adapterCalls;
            $child = $harness->forAgent($agent)->session($session->participant(), $spec['scope'].'::sub::worker', $session->actor());
            $handoff = ['same_actor' => $child->actor() === $session->actor(), 'adapter_calls' => $adapterCalls - $beforeAdapter, 'same_owner' => $child->participant() === $session->participant(), 'same_agent' => $child->agent() === $agent, 'distinct_address' => $child->key() !== $session->key()];
            try { $tools->forAgent($agent)->resolveDetailed(['*'], $harness->forAgent($foreign)->for($participant)->session($spec['scope'])); $foreignRegistry = ['refused' => false, 'native' => null]; }
            catch (Throwable $error) { $foreignRegistry = ['refused' => true, 'native' => ['class' => $error::class, 'code' => property_exists($error, 'errorCode') ? $error->errorCode : null, 'message' => $error->getMessage()]]; }
            $agents[] = ['agent' => $agent, 'inspection' => $inspection, 'offered' => $offered, 'inspection_safe' => $inspectionSafe, 'inspection_providers' => $inspectionCalls, 'offer_providers' => $offerCalls, 'result' => $result, 'positive_handlers' => $handlers - $beforeHandlers, 'hostile_requests' => $actualRequests - 1, 'hostile_handlers' => $handlers - $hostileHandlers, 'refusals' => $errors, 'foreign_registry' => $foreignRegistry, 'handoff' => $handoff];
        }
        $collisions = [];
        foreach ($spec['collision_cases'] as $test) {
            $registry = (new ToolRegistry)->forAgent('support'); $before = $handlers; $native = null;
            $add = function (string $source, string $owner, string $id) use ($registry, $tool): void {
                if ($source === 'static') $registry->register($tool('lookup', 'support'), $owner);
                if ($source === 'factory') $registry->registerFactory('lookup', fn (): Tool => $tool('lookup', 'support'), $owner);
                if ($source === 'provider' || $source === 'duplicate-provider') $registry->registerProvider(fn (): array => array_map(fn (): Tool => $tool('lookup', 'support'), range(1, $source === 'duplicate-provider' ? 2 : 1)), $owner, $id);
            };
            try { $add($test['first'], $test['owners'][0], 'first'); $add($test['second'], $test['owners'][1], 'second'); $registry->resolveDetailed(['*'], $harness->forAgent('support')->for($participant)->session($spec['scope'])); }
            catch (Throwable $error) { $native = ['class' => $error::class, 'code' => property_exists($error, 'errorCode') ? $error->errorCode : null, 'message' => $error->getMessage()]; }
            $collisions[] = ['id' => $test['id'], 'refused' => $native !== null, 'handlers' => $handlers - $before, 'native' => $native];
        }
        // The real OpenAI handler, with local synthetic HTTP responses. Prism's
        // response fake does not execute the core approval/resume machinery.
        app()->instance(PrismManager::class, new PrismManager(app()));
        config()->set('prism.providers.openai.api_key', 'fixture-only-no-live-authority');
        $approvalSpec = $spec['approval'];
        foreach ([$approvalSpec['source'], $approvalSpec['foreign']] as $agent) $modes->forAgent($agent)->register($approvalSpec['mode'], ['tools' => [$approvalSpec['tool']], 'requires_approval' => [$approvalSpec['tool']]], $agent);
        $response = function (bool $call) use ($approvalSpec): array {
            return ['id' => 'fixture-response', 'object' => 'response', 'created_at' => 1, 'status' => 'completed', 'model' => 'synthetic-model',
                'output' => $call ? [['id' => 'fixture-function', 'type' => 'function_call', 'status' => 'completed', 'arguments' => '{}', 'call_id' => 'approval-call', 'name' => $approvalSpec['tool']]]
                    : [['id' => 'fixture-message', 'type' => 'message', 'status' => 'completed', 'role' => 'assistant', 'content' => [['type' => 'output_text', 'annotations' => [], 'text' => 'done', 'refusal' => null]]]],
                'usage' => ['input_tokens' => 1, 'input_tokens_details' => ['cached_tokens' => 0], 'output_tokens' => 1, 'output_tokens_details' => ['reasoning_tokens' => 0], 'total_tokens' => 2], 'service_tier' => 'default', 'system_fingerprint' => 'fixture'];
        };
        Http::preventStrayRequests();
        Http::fakeSequence()->push($response(true))->push($response(false))->push($response(false))->push($response(true))->push($response(false));
        $approvalSession = function (string $agent, string $scope) use ($harness, $participant, $approvalSpec) { return $harness->forAgent($agent)->for($participant)->session($scope)->usingProvider('openai')->usingModel('synthetic-model')->usingMode($approvalSpec['mode']); };
        $source = $approvalSession($approvalSpec['source'], $approvalSpec['scope']);
        $foreign = $approvalSession($approvalSpec['foreign'], $approvalSpec['scope']);
        $pending = $source->send('request approval'); $id = $pending->pendingApprovals()[0]->approvalId;
        $beforeForeign = $handlers;
        $foreign->approve($id);
        $decisionVisible = $source->thread()->storedMessages()->get()->contains(function ($row) use ($id): bool { foreach ($row->payload['tool_approval_responses'] ?? [] as $value) if ($value['approval_id'] === $id && $value['approved'] === true) return true; return false; });
        $requestVisible = $foreign->thread()->storedMessages()->get()->contains(function ($row) use ($id): bool { foreach ($row->payload['tool_approval_requests'] ?? [] as $value) if ($value['approval_id'] === $id) return true; return false; });
        $foreignHandlers = $handlers - $beforeForeign;
        $beforeSource = $handlers; $source->send(''); $sourceHandlers = $handlers - $beforeSource;
        $own = $approvalSession($approvalSpec['source'], $approvalSpec['scope'].':positive');
        $ownPending = $own->send('request approval'); $ownId = $ownPending->pendingApprovals()[0]->approvalId;
        $beforeOwn = $handlers; $own->approve($ownId);
        $approval = ['pending_created' => count($pending->pendingApprovals()) === 1 && count($ownPending->pendingApprovals()) === 1, 'foreign_decision_visible' => $decisionVisible, 'foreign_request_visible' => $requestVisible, 'foreign_handlers' => $foreignHandlers, 'source_without_decision_handlers' => $sourceHandlers, 'own_approval_handlers' => $handlers - $beforeOwn, 'native' => ['foreign_id' => $id, 'own_id' => $ownId, 'initial_finish' => $pending->response->finishReason->value]];
        $parent = $harness->forAgent('support')->for($participant)->session('child-authority');
        $context = \Prism\Harness\Subagents\RunContext::root('child-authority-root', new \Prism\Harness\Subagents\RunBudget(10));
        $declaration = new \Prism\Harness\Subagents\Subagent('worker', 'Worker', $spec['mode'], new \Prism\Harness\Subagents\RunBudget(2));
        $beforeChildHandlers = $handlers; $beforeHttp = count(Http::recorded()); $writes = 0; $inspecting = true;
        try { $childResult = app(\Prism\Harness\Subagents\SubagentRunner::class)->tool($declaration, $parent, $context, 'parent-run')->handle(...$spec['child_request']); }
        finally { $inspecting = false; }
        $childRefused = $childResult instanceof \Prism\Prism\ValueObjects\ToolError;
        $childAuthority = ['refused' => $childRefused, 'requests' => count(Http::recorded()) - $beforeHttp, 'handlers' => $handlers - $beforeChildHandlers, 'ledger_steps' => $context->ledger->steps(), 'storage_writes' => $writes, 'native' => $childRefused ? ['class' => $childResult::class, 'message' => $childResult->message] : null];
        $modes->forAgent('support')->register('policy-child', ['tools' => ['lookup']], 'support');
        $childPolicy = [];
        foreach ($spec['child_policy_cases'] as $test) {
            $granted = $test['phase'] !== 'offer_revoked'; $offerChecks = 0; $callChecks = 0; $actorMatches = true; $expectedActor = $parent->actor(); $beforeHandlers = $handlers;
            \Illuminate\Support\Facades\Gate::define('review.child.offer', function (object $actor, $view, Tool $tool) use (&$granted, &$offerChecks, &$actorMatches, $expectedActor): bool { $offerChecks++; $actorMatches = $actorMatches && $actor === $expectedActor && $view->actor() === $expectedActor; return $granted && $tool->name() === 'lookup'; });
            \Illuminate\Support\Facades\Gate::define('review.child.call', function (object $actor, $view) use (&$granted, &$callChecks, &$actorMatches, $expectedActor): bool { $callChecks++; $actorMatches = $actorMatches && $actor === $expectedActor && $view->actor() === $expectedActor; return $granted; });
            $authorizer = new \Prism\Harness\Tools\ToolAuthorizer(app(\Illuminate\Contracts\Auth\Access\Gate::class), true, ['support' => ['authorize_tools' => true, 'tool_ability' => 'review.child.offer', 'tool_call_ability' => 'review.child.call']]);
            $policyRuntime = new \Prism\Harness\AgentRuntime($modes, $tools, $authorizer, app(\Prism\Harness\Skills\SkillRegistry::class), ['provider' => 'anthropic', 'model' => 'synthetic-model']);
            $policyContext = \Prism\Harness\Subagents\RunContext::root('policy-root', new \Prism\Harness\Subagents\RunBudget(10));
            $fake = Prism::fake([TextResponseFake::make()->withText('done')]);
            $result = (new \Prism\Harness\Subagents\SubagentRunner($harness, $policyRuntime))->run(new \Prism\Harness\Subagents\Subagent('policy_'.$test['phase'], 'Policy child', 'policy-child', new \Prism\Harness\Subagents\RunBudget(2)), $parent, $policyContext, 'parent-run', 'go');
            $actualOffer = []; $modelCalls = 0;
            $fake->assertRequest(function (array $requests) use (&$actualOffer, &$modelCalls, &$granted, $test): void {
                $modelCalls = count($requests); $actualOffer = array_map(fn (Tool $tool): string => $tool->name(), $requests[0]->tools());
                if ($test['phase'] === 'call_revoked') $granted = false;
                foreach ($requests[0]->tools() as $tool) $tool->handle();
            });
            $childPolicy[] = ['phase' => $test['phase'], 'offered' => $actualOffer, 'handlers' => $handlers - $beforeHandlers, 'offer_policy_checked' => $offerChecks > 0, 'call_policy_checked' => $callChecks > 0, 'actor_matches_parent' => $actorMatches, 'native' => ['outcome' => $result->outcome->value, 'requests' => $modelCalls, 'ledger_steps' => $policyContext->ledger->steps(), 'kind' => 'actual child offered wrapper invocation']];
        }
        $legacyTools = new ToolRegistry; $legacyModes = new ModeRegistry([]); $legacyActor = new stdClass;
        $legacyViews = [];
        $legacyTools->registerFactory('actor_probe', function ($view) use (&$legacyViews): Tool { $legacyViews[] = $view->actor(); return (new Tool)->as('actor_probe')->for('Actor observer')->using(fn (): string => throw new RuntimeException('Observer handler must not run')); });
        $legacyModes->register('legacy-child', ['tools' => ['actor_probe']]);
        $legacyRuntime = new \Prism\Harness\AgentRuntime($legacyModes, $legacyTools, new \Prism\Harness\Tools\ToolAuthorizer(app(\Illuminate\Contracts\Auth\Access\Gate::class), false), app(\Prism\Harness\Skills\SkillRegistry::class), ['provider' => 'anthropic', 'model' => 'synthetic-model']);
        $legacyHarness = new PrismHarness(app(\Prism\Harness\Sessions\SessionStoreManager::class), $legacyRuntime, config('prism-harness'));
        $legacyOwner = new class extends \Illuminate\Database\Eloquent\Model { public function getMorphClass(): string { return 'coexistence-legacy-owner'; } };
        $legacyOwner->setRawAttributes(['id' => 1], true);
        $legacyParent = $legacyHarness->session($legacyOwner, 'legacy-authority', $legacyActor);
        $legacyChild = [];
        foreach (['task_only' => ['task' => $spec['legacy_child']['request']['task']], 'extra_actor' => $spec['legacy_child']['request']] as $id => $arguments) {
            $beforeViews = count($legacyViews); $modelCalls = 0;
            $legacyFake = Prism::fake([TextResponseFake::make()->withText('done')]);
            $legacyContext = \Prism\Harness\Subagents\RunContext::root('legacy-'.$id, new \Prism\Harness\Subagents\RunBudget(10));
            $result = (new \Prism\Harness\Subagents\SubagentRunner($legacyHarness, $legacyRuntime))->tool(new \Prism\Harness\Subagents\Subagent('legacy_'.$id, 'Legacy child', 'legacy-child', new \Prism\Harness\Subagents\RunBudget(2)), $legacyParent, $legacyContext, 'parent-run')->handle(...$arguments);
            $legacyFake->assertRequest(function (array $requests) use (&$modelCalls): void { $modelCalls = count($requests); });
            $actorViews = array_slice($legacyViews, $beforeViews); $refused = $result instanceof \Prism\Prism\ValueObjects\ToolError;
            $legacyChild[$id] = ['refused' => $refused, 'requests' => $modelCalls, 'child_started' => count($actorViews) > 0, 'actor_matches_parent' => count($actorViews) > 0 ? count(array_filter($actorViews, fn ($actor): bool => $actor !== $legacyActor)) === 0 : null, 'native' => ['class' => $refused ? $result::class : get_debug_type($result), 'result' => $refused ? $result->message : $result, 'ledger_steps' => $legacyContext->ledger->steps()]];
        }
        file_put_contents(getenv('PRISM_COEXIST_OUTPUT'), json_encode(['order' => $order, 'agents' => $agents, 'collisions' => $collisions, 'approval' => $approval, 'child_authority' => $childAuthority, 'child_policy' => $childPolicy, 'legacy_child' => $legacyChild], JSON_THROW_ON_ERROR)."\n", FILE_APPEND | LOCK_EX);
    }
}
