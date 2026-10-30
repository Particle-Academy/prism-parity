<?php

declare(strict_types=1);

use Composer\InstalledVersions;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Orchestra\Testbench\TestCase;
use Prism\Harness\PrismHarness;
use Prism\Harness\PrismHarnessServiceProvider;
use Prism\Harness\Support\MessageMapper;
use Prism\Harness\Tools\ToolRegistry;
use Prism\Prism\Facades\Prism;
use Prism\Prism\PrismServiceProvider;
use Prism\Prism\Testing\TextResponseFake;
use Prism\Prism\Tool;
use Prism\Prism\ValueObjects\Messages\AssistantMessage;
use Prism\Prism\ValueObjects\Messages\UserMessage;

final class LegacyFixtureParticipant extends Model
{
    protected $table = 'participants';
    protected $guarded = [];
}

final class LegacyContentTest extends TestCase
{
    use RefreshDatabase;

    protected function getPackageProviders($app): array { return [PrismServiceProvider::class, PrismHarnessServiceProvider::class]; }
    protected function defineEnvironment($app): void
    {
        $app['config']->set('database.default', 'g154_legacy_owned');
        $app['config']->set('database.connections.g154_legacy_owned', ['driver'=>'sqlite','database'=>':memory:','prefix'=>'','foreign_key_constraints'=>true]);
        $app['config']->set('prism-harness.stores', ['ephemeral'=>'database','durable'=>'database']);
        $app['config']->set('prism-harness.agent.model', 'fixture-model');
        $app['config']->set('prism-harness.agent.modes.chat', ['system_prompt'=>'Frozen instructions','tools'=>['tock','tick'],'max_steps'=>2,'provider_options'=>['temperature'=>0.25]]);
        if ($app['config']->get('database.connections.g154_legacy_owned.database') !== ':memory:') throw new RuntimeException('Refusing a non-owned database before migration.');
    }
    protected function defineDatabaseMigrations(): void
    {
        self::assertSame(':memory:', config('database.connections.g154_legacy_owned.database'));
        Schema::create('participants', function (Blueprint $table): void { $table->id(); $table->timestamps(); });
    }

    public function test_default_content_and_requests(): void
    {
        Carbon::setTestNow('2026-01-01T00:00:00Z');
        try {
            app(ToolRegistry::class)->register((new Tool)->as('tick')->for('Fixed tool')->using(fn (): string => 'unused'));
            app(ToolRegistry::class)->register((new Tool)->as('tock')->for('Second tool')->using(fn (): string => 'unused'));
            $fake = Prism::fake([
                TextResponseFake::make()->withText('answer:1')->withMessages(collect([new UserMessage('first'),new AssistantMessage('answer:1')])),
                TextResponseFake::make()->withText('answer:2')->withMessages(collect([new UserMessage('second'),new AssistantMessage('answer:2')])),
            ]);
            $session = app(PrismHarness::class)->for(LegacyFixtureParticipant::create())->session('same:/雪');
            $session->usingMode('chat')->usingProvider('anthropic')->usingModel('fixture-model')->usingCapability('fixture',['enabled'=>true]);
            $session->tasks()->add('fixed task','fixed-task');
            $session->send('first'); $session->send('second');
            $requests=[];
            $fake->assertRequest(function (array $actual) use (&$requests): void {
                self::assertCount(2,$actual);
                foreach ($actual as $request) {
                    self::assertSame(['tick','tock'],array_map(fn (Tool $tool): string => $tool->name(),$request->tools()));
                    $requests[] = json_encode([
                        'provider'=>$request->provider(),'model'=>$request->model(),'prompt'=>$request->prompt(),
                        'system_prompts'=>array_map(MessageMapper::toArray(...),$request->systemPrompts()),
                        'messages'=>array_map(MessageMapper::toArray(...),$request->messages()),
                        'tools'=>array_map(fn (Tool $tool): array => ['name'=>$tool->name(),'description'=>$tool->description(),'parameters'=>$tool->parametersAsArray(),'required'=>$tool->requiredParameters()],$request->tools()),
                        'provider_options'=>$request->providerOptions(),'max_steps'=>$request->maxSteps(),'max_tokens'=>$request->maxTokens(),'temperature'=>$request->temperature(),'top_p'=>$request->topP(),'top_k'=>$request->topK(),'tool_choice'=>$request->toolChoice(),'client_options'=>$request->clientOptions(),'client_retry'=>$request->clientRetry(),'reasoning'=>$request->reasoningEnabled(),
                    ], JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
                }
            });
            $rows=[];
            foreach (['harness_threads','harness_thread_messages','harness_session_state'] as $table) {
                $data=DB::table($table)->orderBy($table==='harness_session_state'?'key':'id')->get()->map(function (object $row): array {
                    $value=(array)$row;
                    // Compare every pre-existing column, including literal payload strings.
                    // Additive schema metadata is separately asserted by migration tests.
                    unset($value['agent_id'],$value['participant_ref_type'],$value['participant_ref_id'],$value['address_key']);
                    return $value;
                })->all();
                $rows[$table]=json_encode($data,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
            }
            $indexed=Schema::hasTable('harness_addresses')?DB::table('harness_addresses')->count():0;
            self::assertSame(0,$indexed); self::assertCount(2,$requests);
            file_put_contents(getenv('PRISM_LEGACY_OUTPUT'),json_encode(['session_key'=>$session->key(),'requests'=>$requests,'rows'=>$rows,'indexed_addresses'=>$indexed,'core_version'=>InstalledVersions::getPrettyVersion('particle-academy/prism')],JSON_THROW_ON_ERROR));
        } finally { Carbon::setTestNow(); }
    }
}
