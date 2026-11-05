<?php

declare(strict_types=1);

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Schema;
use Orchestra\Testbench\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;
use Prism\Harness\PrismHarness;
use Prism\Harness\PrismHarnessServiceProvider;
use Prism\Harness\Sessions\Session;
use Prism\Harness\Tools\ToolAuthorizer;
use Prism\Harness\Tools\ToolRegistry;
use Prism\Prism\Facades\Prism;
use Prism\Prism\PrismServiceProvider;
use Prism\Prism\Testing\TextResponseFake;
use Prism\Prism\Tool;

final class ToolListParticipant extends Model
{
    protected $table = 'participants';
    protected $guarded = [];
}

/** Execute the installed package, never a runner-side approximation of its ceiling. */
final class ToolListReferenceTest extends TestCase
{
    use RefreshDatabase;

    // No application .env is read. All database configuration below is private and in memory.
    protected $loadEnvironmentVariables = false;

    protected function getPackageProviders($app): array
    {
        return [PrismServiceProvider::class, PrismHarnessServiceProvider::class];
    }

    protected function defineEnvironment($app): void
    {
        $app['config']->set('database.default', 'tool_list_owned');
        $app['config']->set('database.connections.tool_list_owned', [
            'driver' => 'sqlite', 'database' => ':memory:', 'prefix' => '',
            'foreign_key_constraints' => true,
        ]);
        $app['config']->set('prism-harness.stores', ['ephemeral' => 'database', 'durable' => 'database']);
        $app['config']->set('prism-harness.agent.model', 'fixture-model');
        if ($app['config']->get('database.connections.tool_list_owned.database') !== ':memory:') {
            throw new RuntimeException('Refusing non-owned database before migrations.');
        }
    }

    protected function defineDatabaseMigrations(): void
    {
        self::assertSame(':memory:', config('database.connections.tool_list_owned.database'));
        Schema::create('participants', function (Blueprint $table): void {
            $table->id();
            $table->timestamps();
        });
    }

    public static function scenarios(): iterable
    {
        $input = getenv('PRISM_TOOL_LIST_CASES') ?: __DIR__.'/../../suites/harness-tool-list-default/cases.json';
        $document = json_decode(file_get_contents($input), true, flags: JSON_THROW_ON_ERROR);
        foreach ($document['cases'] as $case) {
            foreach (['send', 'stream'] as $entry) {
                yield $case['id'].':'.$entry => [$case, $entry];
            }
        }
    }

    #[DataProvider('scenarios')]
    public function test_actual_entry(array $case, string $entry): void
    {
        $mode = ['tools' => ($case['wildcardMode'] ?? false) ? ['*'] : ['inside', 'second'], 'max_steps' => 2];
        config(['prism-harness.agent.modes.chat' => $mode]);
        config(['prism-harness.agents.support' => ['owner' => 'support', 'default' => 'chat', 'modes' => ['chat' => $mode]]]);
        $authorize = $case['authorize'] ?? false;
        config(['prism-harness.agent.authorize_tools' => $authorize]);
        if ($authorize) {
            Gate::define(ToolAuthorizer::ABILITY, fn ($user, Session $session, Tool $tool): bool => $tool->name() === 'inside');
        }
        $handled = 0;
        $tools = new ToolRegistry;
        foreach (['inside', 'second', 'outside'] as $name) {
            $make = fn () => (new Tool)->as($name)->for('Offering probe')->using(function () use (&$handled): string {
                $handled++;
                throw new RuntimeException('An offering probe must not execute a tool.');
            });
            $tools->register($make());
            $tools->forAgent('support')->register($make(), 'support');
        }
        app()->instance(ToolRegistry::class, $tools);
        $fake = Prism::fake([TextResponseFake::make()->withText('done')]);
        $harness = app(PrismHarness::class);
        $session = (($case['named'] ?? false) ? $harness->forAgent('support') : $harness)
            ->for(ToolListParticipant::create())->session('tool-list-probe');
        $error = null;
        try {
            if ($entry === 'stream') {
                foreach ($session->stream('probe', $case['names']) as $event) {
                    if ($event instanceof \Prism\Prism\Streaming\Events\ErrorEvent) {
                        throw new RuntimeException('Native stream error: '.json_encode($event));
                    }
                }
            } else {
                $session->send('probe', $case['names']);
            }
        } catch (Throwable $failure) {
            $error = ['class' => $failure::class, 'message' => $failure->getMessage()];
        }
        $requests = [];
        $fake->assertRequest(function (array $actual) use (&$requests): void {
            foreach ($actual as $request) {
                $requests[] = array_map(fn (Tool $tool): string => $tool->name(), $request->tools());
            }
        });
        self::assertSame(0, $handled);
        $observation = ['entry' => $entry, 'requests' => $requests, 'error' => $error];
        $output = getenv('PRISM_TOOL_LIST_OUTPUT');
        if ($output !== false && $output !== '') {
            file_put_contents($output, json_encode(['id' => $case['id'], ...$observation], JSON_THROW_ON_ERROR)."\n", FILE_APPEND | LOCK_EX);
        } else {
            self::assertSame($case['result']['php'][$entry], $observation);
        }
        // Prewritten independent properties also run while recording. A broken
        // positive fixture must fail rather than become an error golden.
        if ($case['expected'] !== null) {
            self::assertNull($error);
            self::assertSame([$case['expected']], $requests);
        } else {
            foreach ($requests as $offered) {
                self::assertNotContains('outside', $offered);
            }
            if ($case['named'] ?? false) {
                self::assertSame([], $requests);
                self::assertNotNull($error);
            } else {
                self::assertNull($error);
            }
        }
    }
}
