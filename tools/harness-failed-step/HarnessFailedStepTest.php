<?php

declare(strict_types=1);

use Composer\InstalledVersions;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Schema;
use Orchestra\Testbench\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;
use Prism\Conformance\Corpus;
use Prism\Harness\Contracts\CallCostObserver;
use Prism\Harness\PrismHarness;
use Prism\Harness\PrismHarnessServiceProvider;
use Prism\Harness\Subagents\CallReservation;
use Prism\Harness\Subagents\CallSettlement;
use Prism\Harness\Subagents\RunBudget;
use Prism\Harness\Subagents\RunContext;
use Prism\Harness\Tools\ToolRegistry;
use Prism\Prism\Enums\FinishReason;
use Prism\Prism\PrismManager;
use Prism\Prism\PrismServiceProvider;
use Prism\Prism\Schema\RawSchema;
use Prism\Prism\Streaming\Events\ErrorEvent;
use Prism\Prism\Streaming\Events\StreamEndEvent;
use Prism\Prism\Streaming\Events\ToolApprovalRequestEvent;
use Prism\Prism\Streaming\Events\ToolCallEvent;
use Prism\Prism\Structured\Response as StructuredResponse;
use Prism\Prism\Testing\PrismFake;
use Prism\Prism\Text\Request;
use Prism\Prism\Text\Response as TextResponse;
use Prism\Prism\Tool;
use Prism\Prism\ValueObjects\Messages\AssistantMessage;
use Prism\Prism\ValueObjects\Messages\UserMessage;
use Prism\Prism\ValueObjects\Meta;
use Prism\Prism\ValueObjects\ToolCall;
use Prism\Prism\ValueObjects\ToolResult;
use Prism\Prism\ValueObjects\Usage;

final class CorpusParticipant extends Model
{
    protected $table = 'participants';

    protected $guarded = [];
}

final class HarnessFailedStepTest extends TestCase
{
    use RefreshDatabase;

    protected function getPackageProviders($app): array
    {
        return [PrismServiceProvider::class, PrismHarnessServiceProvider::class];
    }

    protected function defineEnvironment($app): void
    {
        // Explicit before RefreshDatabase can migrate: this runner has no shared database.
        $app['config']->set('database.default', 'corpus_g153');
        $app['config']->set('database.connections.corpus_g153', [
            'driver' => 'sqlite', 'database' => ':memory:', 'prefix' => '', 'foreign_key_constraints' => true,
        ]);
        $app['config']->set('cache.default', 'array');
        $app['config']->set('prism-harness.stores', ['ephemeral' => 'database', 'durable' => 'database']);
        $app['config']->set('prism-harness.agent.provider', 'anthropic');
        $app['config']->set('prism-harness.agent.model', 'corpus-model');
        $app['config']->set('prism-harness.agent.modes.chat.tools', ['tick']);
    }

    protected function defineDatabaseMigrations(): void
    {
        if (config('database.default') !== 'corpus_g153'
            || config('database.connections.corpus_g153.database') !== ':memory:') {
            throw new RuntimeException('Refusing to migrate a non-corpus database.');
        }
        Schema::create('participants', function (Blueprint $table): void {
            $table->id();
            $table->timestamps();
        });
    }

    public static function cases(): array
    {
        return array_map(fn (array $row): array => [$row],
            Corpus::open(dirname(__DIR__, 2))->suite('harness-failed-step')->cases('php'));
    }

    #[DataProvider('cases')]
    public function test_runtime(array $entry): void
    {
        self::assertFalse($entry['skipped']);
        $spec = $entry['input'];
        $finish = FinishReason::from($spec['finish']);
        $usage = new Usage(3, 2, cost: 0.04);
        $meta = new Meta('corpus', 'corpus-model');
        $calls = $spec['tools'] ? [new ToolCall('failed-call', 'tick', [])] : [];
        $stream = $spec['php_stream'] !== null;
        $text = '{"ok":true}';
        $answered = $spec['php_stream'] === 'legacy_answered' ? [new ToolResult('failed-call', 'tick', [], 'already answered')] : [];
        $first = $spec['api'] === 'structured' && ! $stream
            ? new StructuredResponse(collect(), $text, ['ok' => true], $finish, $usage, $meta, $calls)
            : new TextResponse(collect(), $text, $stream ? FinishReason::ToolCalls : $finish,
                $calls, $answered, $usage, $meta, collect([new UserMessage('go'), new AssistantMessage($text, $calls)]));
        $last = new TextResponse(collect(), 'resumed', FinishReason::Stop, [], [], $usage, $meta, collect());
        $provider = new class([$first, $last]) extends PrismFake
        {
            public ?string $fault = null;

            public function calls(): int
            {
                return count($this->recorded);
            }

            public function stream(Request $request): Generator
            {
                foreach (parent::stream($request) as $event) {
                    if ($event instanceof StreamEndEvent && $this->fault !== null) {
                        if (in_array($this->fault, ['legacy_error', 'legacy_answered'], true)) {
                            yield new ErrorEvent('owned-error', time(), 'provider_error', 'Owned provider failure', true);
                        }
                        yield new StreamEndEvent($event->id, $event->timestamp, FinishReason::Stop,
                            $this->fault === 'missing_usage' ? null : $event->usage);
                    } else {
                        yield $event;
                        if (in_array($this->fault, ['legacy_error', 'missing_usage'], true) && $event instanceof ToolCallEvent) {
                            yield new ToolApprovalRequestEvent('owned-approval', time(), $event->toolCall, $event->messageId, 'failed-approval');
                        }
                    }
                }
            }
        };
        $provider->fault = $spec['php_stream'];
        app(PrismManager::class)->extend('anthropic', fn () => $provider);
        config()->set('prism-harness.agent.modes.chat.requires_approval', $spec['guarded'] ? ['tick'] : []);
        $tools = 0;
        app(ToolRegistry::class)->register((new Tool)->as('tick')->for('Count')->using(function () use (&$tools): string {
            $tools++;

            return 'ran';
        }));
        $observer = new class implements CallCostObserver
        {
            public array $settlements = [];

            public function reserving(CallReservation $call, RunContext $run): void {}

            public function settled(CallSettlement $call, RunContext $run): void
            {
                $this->settlements[] = $call;
            }
        };
        $run = RunContext::root('corpus', new RunBudget(4, 1.0, maxOutputTokensPerCall: 10), [
            'anthropic' => ['corpus-model' => ['inputPerMTok' => 0, 'outputPerMTok' => 10000, 'toolOverheadTokens' => 286]],
        ]);
        $run = new RunContext($run->ledger, $run->budget, pricing: $run->pricing, observer: $observer);
        $session = app(PrismHarness::class)->for(CorpusParticipant::create())->session('failed-step');
        if ($stream) {
            foreach ($session->stream('go', context: $run) as $event) {
            }
        } elseif ($spec['api'] === 'structured') {
            $session->sendStructured('go', new RawSchema('answer', ['type' => 'object']), context: $run);
        } else {
            $session->send('go', context: $run);
        }
        $state = $session->run();
        $reason = $state['failure'] ?? $state['finish_reason'];
        $failed = $state['status'] === 'failed' && in_array($reason, ['error', 'unknown'], true);
        $pending = 0;
        foreach ($session->thread()->messages() as $message) {
            if ($message instanceof AssistantMessage) {
                $pending += count($message->toolApprovalRequests);
            }
        }
        $result = ['error_code' => $failed ? 'model_step_failed' : null, 'finish_reason' => $reason,
            'run_status' => $state['status'], 'model_calls' => $provider->calls(), 'tool_calls' => $tools,
            'steps' => $run->ledger->steps(), 'cost_retained' => $run->ledger->costUsd() === ($stream ? 0.1 : 0.04),
            'pending_approvals' => $pending, 'resumed_tools' => 0];
        $native = ['error_code' => null, 'reason' => $failed ? $reason : null,
            'cost_usd' => $run->ledger->costUsd(), 'settlement_outcome' => $observer->settlements[0]->outcome,
            'package_version' => InstalledVersions::isInstalled('particle-academy/prism-harness')
                ? ltrim(InstalledVersions::getPrettyVersion('particle-academy/prism-harness') ?? '', 'v') : null];
        self::assertCount(1, $observer->settlements);
        $session->approve('failed-approval', context: $run);
        $result['resumed_tools'] = $tools;
        $output = getenv('PRISM_FAILED_STEP_OUTPUT');
        if (! is_string($output) || $output === '') {
            throw new RuntimeException('Missing result output path.');
        }
        file_put_contents($output, json_encode(['id' => $entry['id'], 'result' => $result, 'native' => $native], JSON_THROW_ON_ERROR)."\n", FILE_APPEND | LOCK_EX);
    }
}
