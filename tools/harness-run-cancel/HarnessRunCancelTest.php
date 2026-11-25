<?php

declare(strict_types=1);

use Composer\InstalledVersions;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Schema;
use Orchestra\Testbench\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;
use Prism\Conformance\Corpus;
use Prism\Harness\AgentRuntime;
use Prism\Harness\Events\HarnessEvent;
use Prism\Harness\Events\RunCancelled;
use Prism\Harness\Events\RunCancelRequested;
use Prism\Harness\Events\RunFailed;
use Prism\Harness\Events\RunFinished;
use Prism\Harness\Exceptions\ApprovalNotPending;
use Prism\Harness\Exceptions\RunNotPermitted;
use Prism\Harness\PrismHarness;
use Prism\Harness\PrismHarnessServiceProvider;
use Prism\Harness\Sessions\Session;
use Prism\Harness\Stores\DatabaseSessionStore;
use Prism\Harness\Tools\ToolRegistry;
use Prism\Prism\PrismServiceProvider;
use Prism\Prism\Tool;
use Prism\Prism\ValueObjects\Messages\AssistantMessage;
use Prism\Prism\ValueObjects\Messages\ToolResultMessage;
use Prism\Prism\ValueObjects\ToolApprovalResponse;

final class RunCancelParticipant extends Model
{
    protected $table = 'participants';

    protected $guarded = [];
}

/**
 * G-285 harness-run-cancel: one scripted run per row through the REAL PHP
 * harness runtime. The model is Prism's real OpenAI handler on faked HTTP with
 * stray requests refused, so no request leaves the process. The cancel comes
 * from a SECOND Session built on its own DatabaseSessionStore instances over
 * the same in-memory SQLite database, as another process would.
 */
final class HarnessRunCancelTest extends TestCase
{
    use RefreshDatabase;

    private const REFUSAL = 'Not run: the run was cancelled.';

    private const NAMES = [
        RunCancelRequested::class => 'cancel_requested', RunCancelled::class => 'cancelled',
        RunFinished::class => 'finished', RunFailed::class => 'failed',
    ];

    protected function getPackageProviders($app): array
    {
        return [PrismServiceProvider::class, PrismHarnessServiceProvider::class];
    }

    protected function defineEnvironment($app): void
    {
        // Explicit before RefreshDatabase can migrate: this runner has no shared database.
        $app['config']->set('database.default', 'corpus_g285');
        $app['config']->set('database.connections.corpus_g285', [
            'driver' => 'sqlite', 'database' => ':memory:', 'prefix' => '', 'foreign_key_constraints' => true,
        ]);
        $app['config']->set('cache.default', 'array');
        $app['config']->set('prism-harness.stores', ['ephemeral' => 'database', 'durable' => 'database']);
        // A placeholder: the faked transport refuses every request it was not scripted for.
        $app['config']->set('prism.providers.openai.api_key', 'sk-corpus-placeholder');
        $app['config']->set('prism-harness.agent.provider', 'openai');
        $app['config']->set('prism-harness.agent.model', 'gpt-4o');
        $app['config']->set('prism-harness.agent.modes.chat.tools', ['search', 'weather']);
    }

    protected function defineDatabaseMigrations(): void
    {
        if (config('database.default') !== 'corpus_g285'
            || config('database.connections.corpus_g285.database') !== ':memory:') {
            throw new RuntimeException('Refusing to migrate a non-corpus database.');
        }
        Schema::create('participants', function (Blueprint $table): void {
            $table->id();
            $table->string('name')->nullable();
            $table->timestamps();
        });
    }

    public static function cases(): array
    {
        return array_map(fn (array $row): array => [$row],
            Corpus::open(dirname(__DIR__, 2))->suite('harness-run-cancel')->cases('php'));
    }

    private static function who(string $by): string
    {
        return ['same' => 'Ada', 'other' => 'Bob', 'empty' => 'Cy'][$by] ?? throw new RuntimeException("Unknown session {$by}");
    }

    private function worker(string $name): Session
    {
        return app(PrismHarness::class)->for(RunCancelParticipant::query()->firstOrCreate(['name' => $name]))->session('chat');
    }

    /** Another process: its own store instances, nothing cached. */
    private function web(string $name): Session
    {
        return new Session(RunCancelParticipant::query()->firstOrCreate(['name' => $name]), 'chat',
            new DatabaseSessionStore(DB::connection()), new DatabaseSessionStore(DB::connection()),
            runtime: app(AgentRuntime::class));
    }

    /** The id forms every runner derives identically from the live run id. */
    public static function form(string $form, string $real, ?string $previous): string
    {
        $last = substr($real, -1);

        return match ($form) {
            'current' => $real,
            'previous' => $previous ?? throw new RuntimeException('No previous run id.'),
            'forged' => substr($real, 0, -1).($last === '0' ? '1' : '0'),
            'empty' => '',
            'truncated' => substr($real, 0, -1),
            'extended' => $real.$last,
            'traversal' => '../'.$real,
            'upper' => strtoupper($real),
            'trailing_newline' => $real."\n",
            'trailing_space' => $real.' ',
            'leading_space' => ' '.$real,
            'zero_width' => $real."\u{200B}",
            'nbsp' => $real."\u{00A0}",
            'nul' => $real."\0",
            'homoglyph' => self::homoglyph($real),
            default => throw new RuntimeException("Unknown id form {$form}"),
        };
    }

    private static function homoglyph(string $real): string
    {
        $lookalike = ['a' => "\u{0430}", 'c' => "\u{0441}", 'e' => "\u{0435}"];
        $best = null;
        foreach ($lookalike as $ascii => $_) {
            $at = strpos($real, $ascii);
            if ($at !== false && ($best === null || $at < $best)) {
                $best = $at;
            }
        }

        return $best === null ? $real."\u{0430}" : substr($real, 0, $best).$lookalike[$real[$best]].substr($real, $best + 1);
    }

    private static function shape(?string $id): ?string
    {
        return $id === null ? null : preg_replace('/[0-9a-f]/', 'x', $id);
    }

    private static function response(array $output, int $n): string
    {
        return (string) json_encode([
            'id' => 'resp_'.$n, 'object' => 'response', 'created_at' => 1741989983, 'status' => 'completed',
            'model' => 'gpt-4o-2024-08-06', 'output' => $output,
            'usage' => ['input_tokens' => 10, 'input_tokens_details' => ['cached_tokens' => 0], 'output_tokens' => 5,
                'output_tokens_details' => ['reasoning_tokens' => 0], 'total_tokens' => 15],
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    #[DataProvider('cases')]
    public function test_runtime(array $entry): void
    {
        self::assertFalse($entry['skipped']);
        $spec = $entry['input'];
        config()->set('prism-harness.agent.modes.chat.requires_approval', $spec['requires_approval']);

        // The scripted model: before-turns first, then the subject script.
        $queue = [];
        $call = 0;
        $names = [];
        foreach ([...array_map(fn (array $turn): array => ['text' => $turn['text']], $spec['before']), ...$spec['script']] as $step) {
            $call++;
            if (isset($step['calls'])) {
                $output = [];
                foreach ($step['calls'] as $name) {
                    $id = 'call_g285_'.(++$call);
                    $names[$id] = $name;
                    $output[] = ['id' => 'fc_'.$call, 'type' => 'function_call', 'status' => 'completed',
                        'arguments' => $name === 'search' ? '{"query":"tigers"}' : '{"city":"Detroit"}', 'call_id' => $id, 'name' => $name];
                }
                $queue[] = self::response($output, $call);
            } else {
                $queue[] = self::response([['id' => 'msg_'.$call, 'type' => 'message', 'status' => 'completed', 'role' => 'assistant',
                    'content' => [['type' => 'output_text', 'annotations' => [], 'text' => $step['text'], 'refusal' => null]]]], $call);
            }
        }
        $requests = 0;
        $onRequest = null;
        Http::preventStrayRequests();
        Http::fake(['*' => function () use (&$queue, &$requests, &$onRequest) {
            $requests++;
            if ($onRequest !== null) {
                ($onRequest)($requests);
            }
            $next = array_shift($queue);
            if ($next === null) {
                throw new RuntimeException('The scripted model has no response left.');
            }

            return Http::response($next);
        }]);

        $toolsRun = [];
        $during = null;
        app(ToolRegistry::class)->registerMany([
            (new Tool)->as('search')->for('Search.')->withStringParameter('query', 'Query')
                ->using(function (string $query) use (&$toolsRun, &$during): string {
                    $toolsRun[] = 'search';
                    if ($during !== null) {
                        ($during)();
                    }

                    return 'Found it';
                }),
            (new Tool)->as('weather')->for('Weather.')->withStringParameter('city', 'City')
                ->using(function (string $city) use (&$toolsRun): string {
                    $toolsRun[] = 'weather';

                    return 'Sunny';
                }),
        ]);

        /** @var list<HarnessEvent> $events */
        $events = [];
        Event::listen(array_keys(self::NAMES), function (object $event) use (&$events): void {
            $events[] = $event;
        });

        // Setup turns, then the subject turn starts with clean counters.
        $previous = null;
        foreach ($spec['before'] as $turn) {
            $this->worker(self::who($turn['who']))->send('setup');
            if ($turn['who'] === 'same') {
                $previous = $this->web('Ada')->run()['id'] ?? null;
            }
        }
        $events = [];
        $toolsRun = [];
        $modelBase = $requests;

        $outcomes = [];
        // The G-285 projection starts at the first cancel: events a turn emits
        // before it (PHP's park-time RunFinished) are park vocabulary, kept native.
        $from = null;
        $cancel = function (array $cancels) use (&$outcomes, &$previous, &$from, &$events): void {
            if ($cancels !== [] && $from === null) {
                $from = count($events);
            }
            $real = $this->web('Ada')->run()['id'] ?? throw new RuntimeException('The subject run has no id in the store.');
            foreach ($cancels as $one) {
                $outcomes[] = $this->web(self::who($one['by']))->cancel(self::form($one['id'], $real, $previous))->value;
            }
        };
        if (str_starts_with((string) $spec['cancel_at'], 'tool:')) {
            $during = function () use (&$during, $cancel, $spec): void {
                $during = null;
                $cancel($spec['cancels']);
            };
        } elseif (str_starts_with((string) $spec['cancel_at'], 'request:')) {
            $at = (int) substr($spec['cancel_at'], 8) + $modelBase;
            $onRequest = function (int $request) use (&$onRequest, $at, $cancel, $spec): void {
                if ($request === $at) {
                    $onRequest = null;
                    $cancel($spec['cancels']);
                }
            };
        }

        $failure = null;
        $pending = null;
        try {
            $response = $this->worker('Ada')->send('go');
            $pending = $response->pendingApprovals()[0]->approvalId ?? null;
        } catch (RunNotPermitted $refused) {
            $failure = $refused;
        }

        $approvalBefore = $pending === null ? null : $this->web('Ada')->approvalStatus($pending);
        if (in_array($spec['cancel_at'], ['parked', 'after'], true)) {
            $cancel($spec['cancels']);
        }
        $cancel($spec['after']);

        $decideRefused = null;
        $resumeRefused = null;
        $decisions = [];
        $resumes = [];
        if ($spec['settle']) {
            $tries = [
                'approve' => fn () => $this->worker('Ada')->approve($pending),
                'deny' => fn () => $this->worker('Ada')->deny($pending),
                'decide' => fn () => $this->worker('Ada')->decide([new ToolApprovalResponse($pending, true)]),
                'streamDecision' => fn () => iterator_to_array($this->worker('Ada')->streamDecision([new ToolApprovalResponse($pending, true)]), false),
            ];
            foreach ($tries as $path => $try) {
                try {
                    $try();
                    $decisions[$path] = null;
                } catch (ApprovalNotPending) {
                    $decisions[$path] = 'ApprovalNotPending';
                }
            }
            foreach (['send' => fn () => $this->worker('Ada')->send(''),
                'streamSteps' => fn () => iterator_to_array($this->worker('Ada')->streamSteps(''), false)] as $path => $try) {
                try {
                    $try();
                    $resumes[$path] = null;
                } catch (RunNotPermitted $refused) {
                    $resumes[$path] = $refused->code();
                }
            }
            $decideRefused = ! in_array(null, $decisions, true);
            $resumeRefused = $resumes === array_fill_keys(array_keys($resumes), 'run_cancelled');
        }

        $web = $this->web('Ada');
        $run = $web->run();
        $parked = $spec['cancel_at'] === 'parked';
        $projected = array_slice($events, $from ?? 0);
        $stored = $web->state()['run'] ?? [];
        $refused = [];
        $final = null;
        foreach ($spec['script'] as $step) {
            if (isset($step['text'])) {
                $final = $step['text'];
            }
        }
        $answerKept = false;
        foreach ($web->thread()->messages() as $message) {
            if ($message instanceof ToolResultMessage) {
                foreach ($message->toolResults as $result) {
                    if ($result->result === self::REFUSAL) {
                        $refused[] = $result->toolName;
                    }
                }
            }
            if ($message instanceof AssistantMessage && $final !== null && $message->content === $final) {
                $answerKept = true;
            }
        }
        $cancelEvents = array_values(array_filter($events, fn (object $e): bool => $e instanceof RunCancelRequested || $e instanceof RunCancelled));
        $tagged = null;
        if ($cancelEvents !== []) {
            $tagged = true;
            foreach ($cancelEvents as $event) {
                $tagged = $tagged && $event->runId === ($run['id'] ?? null) && $event->rootRunId === $event->runId
                    && $event->parentRunId === null && $event->sessionKey === $web->key();
            }
        }

        $result = [
            'outcomes' => $outcomes,
            'run_status' => $run['status'] ?? null,
            // A parked run's stored record is park vocabulary, not cancel: compared natively.
            'stored_status' => $parked ? null : ($stored['status'] ?? null),
            'ended_as' => $stored['ended_as'] ?? null,
            'error_code' => $failure?->code(),
            'model_calls' => $requests - $modelBase,
            'tools_run' => $toolsRun,
            'refused_tools' => $refused,
            'final_answer_in_thread' => $answerKept,
            'events' => array_map(fn (object $e): string => self::NAMES[$e::class], $projected),
            'request_states' => array_map(fn (RunCancelRequested $e): string => $e->state,
                array_values(array_filter($projected, fn (object $e): bool => $e instanceof RunCancelRequested))),
            'events_tagged' => $tagged,
            'approval_status_before' => $approvalBefore,
            'approval_status_after' => $pending === null ? null : $web->approvalStatus($pending),
            'decide_refused' => $decideRefused,
            'resume_refused' => $resumeRefused,
        ];
        $native = [
            'event_names' => array_map(fn (object $e): string => class_basename($e), $events),
            'projected_from' => $from ?? 0,
            'park_stored_status' => $parked ? ($stored['status'] ?? null) : null,
            'error' => $failure === null ? null : class_basename($failure),
            'decisions' => $decisions === [] ? null : $decisions,
            'resumes' => $resumes === [] ? null : $resumes,
            'run_id_shape' => self::shape($run['id'] ?? null),
            'package_version' => InstalledVersions::isInstalled('particle-academy/prism-harness')
                ? ltrim(InstalledVersions::getPrettyVersion('particle-academy/prism-harness') ?? '', 'v') : null,
        ];
        $output = getenv('PRISM_RUN_CANCEL_OUTPUT');
        if (! is_string($output) || $output === '') {
            throw new RuntimeException('Missing result output path.');
        }
        file_put_contents($output, json_encode(['id' => $entry['id'], 'result' => $result, 'native' => $native],
            JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE)."\n", FILE_APPEND | LOCK_EX);
    }
}
