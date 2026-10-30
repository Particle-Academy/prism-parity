<?php

declare(strict_types=1);

require getenv('PRISM_HARNESS_AUTOLOAD');

use Illuminate\Database\Eloquent\Model;
use Prism\Harness\Contracts\SessionStore;
use Prism\Harness\Enums\Durability;
use Prism\Harness\Sessions\Session;
use Prism\Harness\Sessions\SessionAddress;
use Prism\Harness\Support\LiveThreadKey;

final class AddressProbeParticipant extends Model
{
    public string $probeType = '';
    public string $probeId = '';
    public function getMorphClass(): string { return $this->probeType; }
    public function getKey(): string { return $this->probeId; }
}

final class AddressProbeUnusedStore implements SessionStore
{
    public function get(string $key): ?array { throw new LogicException('Key derivation read a store.'); }
    public function put(string $key, array $payload, ?int $ttlSeconds = null): void { throw new LogicException('Key derivation wrote a store.'); }
    public function forget(string $key): void { throw new LogicException('Key derivation forgot a store.'); }
    public function withLock(string $key, Closure $callback, int $ttlSeconds = 10, int $waitSeconds = 5): mixed { throw new LogicException('Key derivation allocated a lock.'); }
    public function durability(): Durability { return Durability::Volatile; }
}

$rows = [];
foreach (json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR)['cases'] as $case) {
    $input = $case['input'];
    $type = $input['participant']['type'] ?? null;
    $id = $input['participant'] === null ? null : (string) $input['participant']['id'];
    try {
        if (class_exists(SessionAddress::class)) {
            $address = new SessionAddress($type, $id, $input['scope'], $input['agent']);
            $result = ['session_key' => $type === null ? null : $address->sessionKey(), 'thread_key' => $address->threadKey(), 'index_key' => $address->indexKey()];
        } elseif ($input['agent'] !== null) {
            $result = ['error' => 'unsupported_named_namespace'];
        } else {
            $participant = new AddressProbeParticipant;
            $participant->probeType = $type ?? '';
            $participant->probeId = $id ?? '';
            $result = ['session_key' => $type === null ? null : (new Session($participant, $input['scope'], new AddressProbeUnusedStore, new AddressProbeUnusedStore))->key(), 'thread_key' => LiveThreadKey::key($type, $id, $input['scope'])];
        }
    } catch (InvalidArgumentException $error) { $result = ['error' => 'invalid_address']; }
    $rows[] = ['id' => $case['id'], 'result' => $result];
}
echo json_encode($rows, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE).PHP_EOL;
