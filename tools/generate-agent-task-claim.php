<?php

declare(strict_types=1);

/**
 * Regenerate the PHP half of suites/agent-task-claim/cases.json.
 *
 * This suite pins the CLAIM/RELEASE state machine of an agent task list, and
 * the canonical record it stores.
 *
 * Why it has to cross a language boundary: a task list is durable state that
 * outlives the process that wrote it, and nothing says the process that reads
 * it back is in the same language. A PHP worker and a Python worker drawing
 * from one list must agree on when a lease has lapsed, on who may release, and
 * on the bytes of the stored record — because the list IS the shared surface.
 *
 * A one-tick disagreement about expiry hands one task to two workers. A
 * disagreement about `claimed_by` comparison lets one worker close another's
 * work. Neither errors.
 *
 * Recorded as OUTCOME and CODE rather than prose, per 0004: error messages are
 * explicitly outside the contract, so a row that compared them would fail on
 * wording and teach nothing.
 *
 *   PRISM_HARNESS_AUTOLOAD=../prism-harness/vendor/autoload.php php tools/generate-agent-task-claim.php
 *   PRISM_HARNESS_AUTOLOAD=... php tools/generate-agent-task-claim.php --check
 */
$autoload = getenv('PRISM_HARNESS_AUTOLOAD') ?: __DIR__.'/../../prism-harness/vendor/autoload.php';

if (! is_file($autoload)) {
    fwrite(STDERR, "No prism-harness autoloader at {$autoload}. Set PRISM_HARNESS_AUTOLOAD.\n");
    exit(3);
}

require $autoload;

use Illuminate\Support\Carbon;
use Prism\Harness\Contracts\SessionStore;
use Prism\Harness\Enums\Durability;
use Prism\Harness\Enums\TaskOutcome;
use Prism\Harness\Contracts\HasErrorCode;
use Prism\Harness\Tasks\StoreTaskSource;

/**
 * The smallest store that satisfies the contract.
 *
 * Deliberately NOT one of the shipped stores. Those need Laravel, and a corpus
 * generator that boots a framework is measuring the framework too. The lock is
 * a no-op because this process is single-threaded — the locking PRIMITIVE has
 * its own failure modes and is explicitly out of this suite's scope.
 */
final class ArrayStore implements SessionStore
{
    /** @var array<string, array<string, mixed>> */
    private array $rows = [];

    public function get(string $key): ?array
    {
        return $this->rows[$key] ?? null;
    }

    public function put(string $key, array $payload, ?int $ttlSeconds = null): void
    {
        $this->rows[$key] = $payload;
    }

    public function forget(string $key): void
    {
        unset($this->rows[$key]);
    }

    public function withLock(string $key, Closure $callback, int $ttlSeconds = 10, int $waitSeconds = 5): mixed
    {
        return $callback();
    }

    public function durability(): Durability
    {
        return Durability::Durable;
    }
}

$path = __DIR__.'/../suites/agent-task-claim/cases.json';
$document = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
$check = in_array('--check', $argv, true);

/**
 * Seed a source with the row's `given`, then run its `when`.
 *
 * @param  array<string, mixed>  $case
 * @return array<string, mixed>
 */
function run(array $case): array
{
    Carbon::setTestNow(Carbon::createFromTimestamp($case['given']['now']));

    $store = new ArrayStore;
    $list = 'corpus';

    // Seeded directly rather than through add(), so a row may describe a state
    // the public API would refuse to create — an inconsistent one, say. A
    // corpus that can only express states the implementation is willing to
    // build cannot test what it does when it meets one it did not.
    $source = new StoreTaskSource(store: $store, list: $list);

    // Seeded at the source's OWN key. Writing to the bare list name instead
    // made every row read an empty list, and the generator recorded "nothing
    // happened" for all 21 as though it were an answer -- outcome ok, pending 0,
    // no record. It looked entirely plausible.
    $store->put($source->key(), ['tasks' => array_map(static function (array $t): array {
        $claimedBy = $t['claimed_by'] ?? null;

        return [
            'claimed_by' => $claimedBy,
            'claimed_until' => $t['claimed_until'] ?? null,
            'id' => $t['id'],
            'instruction' => $t['instruction'],
            'state' => $t['state'] ?? ($claimedBy !== null ? 'claimed' : 'todo'),
        ];
    }, $case['given']['tasks'])]);

    // The guard that would have caught the above immediately. A row that seeds
    // tasks and then cannot see any of them is a broken generator, not a
    // finding -- and the difference is invisible in the recorded output.
    if ($case['given']['tasks'] !== [] && $source->find($case['given']['tasks'][0]['id']) === null) {
        fwrite(STDERR, "SEEDING FAILED for {$case['id']}: the source cannot see the tasks it was given.
");
        exit(4);
    }

    $when = $case['when'];

    try {
        $record = match ($when['op']) {
            'claim' => $source->claim($when['worker'], $when['lease_seconds'] ?? null),
            'find' => $source->find($when['task_id']),
            'pending' => null,
            'release' => (function () use ($source, $when) {
                $task = $source->find($when['task_id']);

                if ($task === null) {
                    return null;
                }

                $source->release($task, $when['worker'], TaskOutcome::from($when['outcome']));

                return $source->find($when['task_id']);
            })(),
            'claim_then_find' => (function () use ($source, $when) {
                $source->claim($when['worker'], $when['lease_seconds']);

                return $source->find($when['task_id']);
            })(),
            default => throw new RuntimeException("Unknown op {$when['op']}"),
        };

        return [
            'outcome' => 'ok',
            'code' => null,
            'record' => $record?->toArray(),
            'pending' => $source->pending(),
        ];
    } catch (HasErrorCode $e) {
        // The package's exceptions share an INTERFACE, not a base class -- they
        // extend the built-in that fits each failure. So the catch is on the
        // code-carrying contract, which is the only part 0004 pins anyway.
        return [
            'outcome' => 'refused',
            'code' => $e->code(),
            'record' => null,
            'pending' => null,
        ];
    } catch (ValueError $e) {
        // TaskOutcome::from() on a string that is not an outcome. The refusal is
        // real; the language simply raises it before the package is reached.
        return [
            'outcome' => 'refused',
            'code' => 'task_outcome_invalid',
            'record' => null,
            'pending' => null,
        ];
    } catch (TypeError $e) {
        // 0002: when a language genuinely cannot express a case, SKIP it with a
        // mandatory reason and KEEP the row. A deleted case is a divergence
        // nobody rediscovers until it costs something.
        //
        // Returned as a SENTINEL and written to the row's canonical `skip` map
        // below, never into `result`. An earlier version of this generator put
        // `{"skipped": ...}` inside `result.php`, which every loader's
        // `skippedIds()` is blind to -- so the row reported as skipped to a human
        // reading the file and as not-skipped to every tool. A skip a loader
        // cannot see is the "skip that becomes permanent silently" 0002 exists
        // to prevent, wearing the shape of compliance.
        return ['__skip__' => 'PHP cannot express this row: claim() declares ?int, so the value is rejected by the type system before any guard in the package runs. The reachable path in PHP is the configuration route, which is a different value and belongs in its own row.'];
    } finally {
        Carbon::setTestNow();
    }
}

$stale = [];

foreach ($document['cases'] as $index => $case) {
    $produced = run($case);

    // A skip lands in the row's `skip` map where the loaders can see it, and
    // `result.php` stays null. Anything else clears a stale skip, so a row that
    // becomes expressible stops claiming it is not.
    if (isset($produced['__skip__'])) {
        $document['cases'][$index]['skip']['php'] = $produced['__skip__'];
        $document['cases'][$index]['result']['php'] = null;

        continue;
    }

    unset($document['cases'][$index]['skip']['php']);

    if (($document['cases'][$index]['skip'] ?? null) === []) {
        unset($document['cases'][$index]['skip']);
    }

    $recorded = $case['result']['php'] ?? null;

    if ($recorded !== $produced) {
        $stale[] = sprintf(
            '%s: recorded %s, reference produces %s',
            $case['id'],
            json_encode($recorded, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            json_encode($produced, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        );
    }

    $document['cases'][$index]['result']['php'] = $produced;
}

if ($check) {
    if ($stale !== []) {
        fwrite(STDERR, "Stale PHP rows in agent-task-claim:\n  ".implode("\n  ", $stale)."\n");
        exit(1);
    }

    fwrite(STDERR, "agent-task-claim: every PHP row matches the reference.\n");
    exit(0);
}

file_put_contents(
    $path,
    json_encode($document, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."\n",
);

fwrite(STDERR, $stale === []
    ? "agent-task-claim: no change.\n"
    : sprintf("agent-task-claim: rewrote %d row(s).\n", count($stale)));
