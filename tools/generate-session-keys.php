<?php

declare(strict_types=1);

/**
 * Regenerate the PHP half of suites/harness-session-key/cases.json.
 *
 * Driven through the real `Session`, not by reimplementing `sprintf` and
 * `sha1` here. A generator that recomputed the format would pin what the
 * generator believes rather than what the harness does, and the two would
 * agree right up until somebody changed the harness — which is the exact
 * moment this suite is supposed to notice.
 *
 *   PRISM_HARNESS_AUTOLOAD=../prism-harness/vendor/autoload.php php tools/generate-session-keys.php
 *   PRISM_HARNESS_AUTOLOAD=... php tools/generate-session-keys.php --check
 */
$autoload = getenv('PRISM_HARNESS_AUTOLOAD') ?: __DIR__.'/../../prism-harness/vendor/autoload.php';

if (! is_file($autoload)) {
    fwrite(STDERR, "No prism-harness autoloader at {$autoload}. Set PRISM_HARNESS_AUTOLOAD.\n");
    exit(3);
}

require $autoload;

use Illuminate\Database\Eloquent\Model;
use Prism\Harness\Contracts\SessionStore;
use Prism\Harness\Enums\Durability;
use Prism\Harness\Sessions\Session;

/**
 * The smallest thing `Session` will accept as a participant.
 *
 * `Session` type-hints an Eloquent Model, so this extends one — but it never
 * touches a connection: `getMorphClass()` and `getKey()` are the entire contract
 * the key depends on, and both are answered from memory. No database, no
 * container, no migrations.
 */
final class CorpusParticipant extends Model
{
    // Set after construction, NOT through the constructor: Eloquent's boot
    // sequence instantiates a model with no arguments, so a required-argument
    // constructor breaks the framework before this class does anything useful.
    public string $morphClass = '';

    public string $corpusKey = '';

    public static function for(string $type, string $id): self
    {
        $participant = new self;
        $participant->morphClass = $type;
        $participant->corpusKey = $id;

        return $participant;
    }

    #[\Override]
    public function getMorphClass(): string
    {
        return $this->morphClass;
    }

    #[\Override]
    public function getKey(): string
    {
        return $this->corpusKey;
    }
}

/**
 * A store that is never read from.
 *
 * `Session::key()` derives from the participant and the scope alone, but the
 * constructor requires two stores. A null object keeps this generator driving
 * the REAL Session rather than a reimplementation of its format — which is the
 * whole point: a generator that recomputed `sprintf` and `sha1` here would pin
 * what the generator believes, and would keep agreeing with itself after
 * somebody changed the harness.
 */
final class UnusedStore implements SessionStore
{
    public function get(string $key): ?array
    {
        return null;
    }

    public function put(string $key, array $payload, ?int $ttlSeconds = null): void {}

    public function forget(string $key): void {}

    public function withLock(string $key, Closure $callback, int $ttlSeconds = 10, int $waitSeconds = 5): mixed
    {
        return $callback();
    }

    public function durability(): Durability
    {
        return Durability::Volatile;
    }
}

$check = in_array('--check', $argv, true);
$path = __DIR__.'/../suites/harness-session-key/cases.json';
$document = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);

$stale = [];

foreach ($document['cases'] as $index => $case) {
    $participant = CorpusParticipant::for($case['participant']['type'], $case['participant']['id']);
    $produced = (new Session($participant, $case['scope'], new UnusedStore, new UnusedStore))->key();

    $recorded = array_key_exists('php', $case['key'] ?? []) ? $case['key']['php'] : null;

    if ($recorded !== $produced) {
        $stale[] = sprintf('%s: recorded %s, reference produces %s', $case['id'], $recorded ?? 'nothing', $produced);
    }

    $document['cases'][$index]['key']['php'] = $produced;
}

if ($check) {
    if ($stale !== []) {
        fwrite(STDERR, "Stale PHP keys in harness-session-key:\n  ".implode("\n  ", $stale)."\n");
        exit(1);
    }

    fwrite(STDERR, "harness-session-key: every PHP key matches the reference.\n");
    exit(0);
}

file_put_contents(
    $path,
    json_encode($document, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."\n",
);

fwrite(STDERR, $stale === []
    ? "harness-session-key: no change.\n"
    : sprintf("harness-session-key: rewrote %d key(s).\n  %s\n", count($stale), implode("\n  ", $stale)));
