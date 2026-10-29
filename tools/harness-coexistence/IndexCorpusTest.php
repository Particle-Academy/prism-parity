<?php

declare(strict_types=1);

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Orchestra\Testbench\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;
use Prism\Harness\Exceptions\AddressLimitExceeded;
use Prism\Harness\Models\Thread;
use Prism\Harness\Participants\ParticipantAdapters;
use Prism\Harness\Participants\ParticipantRef;
use Prism\Harness\PrismHarness;
use Prism\Harness\PrismHarnessServiceProvider;
use Prism\Harness\Sessions\DatabaseAddressIndex;
use Prism\Prism\PrismServiceProvider;

final class IndexCorpusTest extends TestCase
{
    use RefreshDatabase;

    protected function getPackageProviders($app): array { return [PrismServiceProvider::class, PrismHarnessServiceProvider::class]; }

    protected function defineEnvironment($app): void
    {
        $app['config']->set('database.default', 'g154_owned_index');
        $app['config']->set('database.connections.g154_owned_index', ['driver'=>'sqlite','database'=>':memory:','prefix'=>'','foreign_key_constraints'=>true]);
        $app['config']->set('prism-harness.stores', ['ephemeral'=>'database','durable'=>'database']);
        if ($app['config']->get('database.connections.g154_owned_index.database') !== ':memory:') throw new RuntimeException('Refusing a non-owned database before migration.');
    }

    protected function defineDatabaseMigrations(): void
    {
        self::assertSame('g154_owned_index', config('database.default'));
        self::assertSame(':memory:', config('database.connections.g154_owned_index.database'));
    }

    public static function cases(): array
    {
        $cases = json_decode(file_get_contents(__DIR__.'/index-cases.json'), true, 512, JSON_THROW_ON_ERROR)['cases'];
        self::assertCount(3, $cases);
        return array_map(fn (array $row): array => [$row], $cases);
    }

    #[DataProvider('cases')]
    public function test_index(array $spec): void
    {
        config()->set('prism-harness.addresses.max_addresses_per_participant', $spec['max_addresses_per_participant']);
        app(ParticipantAdapters::class)->register('index-person', fn (ParticipantRef $ref): object => new stdClass);
        $participant = new ParticipantRef('index-person', '1');
        $harness = app(PrismHarness::class)->forAgent('support');
        $refusals = 0; $code = null; $present = false;
        for ($i=0; $i<$spec['addresses']; $i++) {
            $session = $harness->for($participant)->session('page:'.$i);
            try { $session->usingMode('reply'); }
            catch (AddressLimitExceeded $error) {
                $refusals++; $code = $error->errorCode;
                $present = $present || DB::table('harness_session_state')->where('key', $session->key().':ephemeral')->exists();
            }
        }
        $index = DatabaseAddressIndex::configured((new Thread)->getConnection());
        $sizes=[]; $cursors=[]; $positions=[]; $cursor=0;
        do {
            $page = $index->page($participant->type, $participant->id, $cursor);
            $sizes[] = count($page['entries']); $cursors[] = $page['next_cursor'];
            foreach ($page['entries'] as $entry) $positions[] = (int) $entry['position'];
            $cursor = $page['next_cursor'];
        } while ($cursor !== null);
        $harness->for($participant)->session('page:0')->usingMode('updated');
        $result = ['indexed'=>count($positions),'page_sizes'=>$sizes,'next_cursors'=>$cursors,'quota_refusals'=>$refusals,'error_code'=>$code,'refused_state_present'=>$present,'positions_dense'=>$positions===range(0,count($positions)-1),'existing_writable'=>$harness->for($participant)->session('page:0')->mode()==='updated'];
        self::assertSame($spec['expected'], $result);
        file_put_contents(getenv('PRISM_INDEX_OUTPUT'), json_encode(['id'=>$spec['id'],'result'=>$result], JSON_THROW_ON_ERROR)."\n", FILE_APPEND|LOCK_EX);
    }
}
