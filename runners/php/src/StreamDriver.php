<?php

declare(strict_types=1);

namespace Prism\Conformance\Reference;

use GuzzleHttp\Psr7\AppendStream;
use GuzzleHttp\Psr7\Utils;
use Illuminate\Container\Container;
use Illuminate\Http\Client\Factory;
use Prism\Prism\Providers\Anthropic\Handlers\Stream;
use RuntimeException;
use Throwable;

/** Native published handler and parser; only the HTTP response is faked. */
final class StreamDriver
{
    public static function parse(array $builder, array $stream): array
    {
        Driver::boot();
        $body = new AppendStream;
        if (($stream['encoding'] ?? null) !== 'base64' || ($stream['chunks'] ?? []) === []) {
            throw new RuntimeException('A stream fixture needs nonempty base64 chunks.');
        }
        foreach ($stream['chunks'] as $encoded) {
            $bytes = base64_decode($encoded, true);
            if ($bytes === false || $bytes === '') {
                throw new RuntimeException('Invalid or empty stream chunk.');
            }
            $body->addStream(Utils::streamFor($bytes));
        }
        $factory = new Factory(Container::getInstance()->make('events'));
        $factory->preventStrayRequests();
        $factory->fake(['*' => $factory->response($body, 200, ['Content-Type' => 'text/event-stream'])]);
        $events = [];
        $eventIds = [];
        $opaqueIds = [];
        $terminal = ['status' => 'returned'];
        try {
            $handler = new Stream($factory->baseUrl('https://api.anthropic.com/v1'));
            foreach ($handler->handle(Driver::pending($builder)->toRequest()) as $event) {
                $payload = $event->toArray();
                if (isset($payload['id'])) {
                    $eventIds[$payload['id']] ??= 'event-'.(count($eventIds) + 1);
                    $payload['id'] = $eventIds[$payload['id']];
                }
                if (array_key_exists('timestamp', $payload)) {
                    $payload['timestamp'] = 0;
                }
                $events[] = ['type' => $event->type()->value, 'payload' => self::aliasOpaque($payload, $opaqueIds)];
            }
        } catch (Throwable $error) {
            $terminal = ['status' => 'raised', 'exception' => $error::class];
        }

        return ['events' => $events, 'terminal' => $terminal, 'requests' => count($factory->recorded())];
    }

    private static function aliasOpaque(array $payload, array &$aliases): array
    {
        foreach ($payload as $key => $value) {
            if (in_array($key, ['message_id', 'reasoning_id'], true) && is_string($value) && $value !== '') {
                $aliases[$value] ??= 'opaque-'.(count($aliases) + 1);
                $payload[$key] = $aliases[$value];
            } elseif (is_array($value)) {
                $payload[$key] = self::aliasOpaque($value, $aliases);
            }
        }

        return $payload;
    }

    /** Properties are fixture declarations, independent of generated goldens. */
    public static function violations(array $trace, array $properties): array
    {
        $violations = [];
        $events = $trace['events'];
        $ends = array_values(array_filter($events, fn ($event) => $event['type'] === 'stream_end'));
        $text = implode('', array_map(fn ($event) => $event['payload']['delta'], array_filter($events, fn ($event) => $event['type'] === 'text_delta')));
        if ($text !== $properties['text']) {
            $violations[] = 'text';
        }
        $starts = array_filter($events, fn ($event) => $event['type'] === 'text_start');
        $completes = array_filter($events, fn ($event) => $event['type'] === 'text_complete');
        // PHP TextComplete carries only message_id; text is in TextDelta.
        if (count($starts) !== count($completes)) {
            $violations[] = 'text_completion';
        }
        if (count($ends) !== $properties['terminal_events'] || ($events[array_key_last($events)]['type'] ?? null) !== 'stream_end') {
            $violations[] = 'terminal_events';
        }
        if (($trace['terminal']['status'] ?? null) !== 'returned' || $trace['requests'] !== 1) {
            $violations[] = 'native_execution';
        }
        $errors = array_filter($events, fn ($event) => $event['type'] === 'error');
        if (($errors !== []) !== $properties['error_observable']) {
            $violations[] = 'error_observable';
        }
        if (($properties['error_nonrecoverable'] ?? false) && array_filter($errors, fn ($event) => ($event['payload']['recoverable'] ?? null) !== false) !== []) {
            $violations[] = 'error_nonrecoverable';
        }
        if (isset($properties['error_codes']) && array_values(array_map(fn ($event) => $event['payload']['error_type'] ?? $event['payload']['code'] ?? null, $errors)) !== $properties['error_codes']) {
            $violations[] = 'error_codes';
        }
        if ($properties['no_completed_tools'] && array_filter($events, fn ($event) => in_array($event['type'], ['tool_call', 'tool_result'], true)) !== []) {
            $violations[] = 'no_completed_tools';
        }
        if (count($ends) === 1) {
            $payload = $ends[0]['payload'];
            $accepted = $properties['normal_completion'] ? ['Stop', 'stop'] : ['Error', 'error'];
            if (! in_array($payload['finish_reason'] ?? null, $accepted, true)) {
                $violations[] = 'normal_completion';
            }
            if (array_key_exists('usage_known', $properties) && (($payload['usage'] ?? null) !== null) !== $properties['usage_known']) {
                $violations[] = 'usage_known';
            }
            foreach ($properties['final_usage'] ?? [] as $field => $expected) {
                if (($payload['usage'][$field] ?? null) !== $expected) {
                    $violations[] = 'final_usage.'.$field;
                }
            }
        }

        return $violations;
    }
}
