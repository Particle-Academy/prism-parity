<?php

declare(strict_types=1);

namespace Prism\Conformance\Reference;

use Generator;
use GuzzleHttp\Psr7\AppendStream;
use GuzzleHttp\Psr7\StreamDecoratorTrait;
use GuzzleHttp\Psr7\Utils;
use Illuminate\Container\Container;
use Illuminate\Http\Client\Factory;
use Illuminate\Support\Facades\Http;
use Prism\Prism\Events\Telemetry\GenerationCompleted;
use Prism\Prism\Events\Telemetry\GenerationErrored;
use Prism\Prism\Events\Telemetry\GenerationFailed;
use Prism\Prism\Events\Telemetry\GenerationStarted;
use Prism\Prism\Exceptions\PrismException;
use Prism\Prism\Providers\Anthropic\Handlers\Stream as AnthropicStream;
use Prism\Prism\Providers\Mistral\Handlers\Stream as MistralStream;
use Prism\Prism\Providers\OpenAI\Handlers\Stream as OpenAIStream;
use Prism\Prism\Streaming\Events\ErrorEvent;
use Prism\Prism\Tool;
use Prism\Prism\ValueObjects\StreamFailureUsage;
use Prism\Prism\ValueObjects\Usage;
use Psr\Http\Message\StreamInterface;
use RuntimeException;
use Throwable;

/** Own HTTP bytes and read faults; every event and exception comes from the installed SDK. */
final class FailureUsageStreamDriver
{
    public static function parse(array $builder, array $input): array
    {
        if (array_column($builder, 'call') !== ['using', 'withPrompt', 'withMaxTokens', 'withMaxSteps']
            || ($builder[0]['args'] ?? null) !== [$input['provider'] ?? null, 'owned']
            || ($builder[1]['args'] ?? null) !== ['private-prompt-sentinel']
            || ($builder[2]['args'] ?? null) !== [32]
            || ($builder[3]['args'] ?? null) !== [($input['mode'] ?? null) === 'continuation' ? 2 : 1]) {
            throw new RuntimeException('Only the fixed owned failure builder is executable.');
        }
        Driver::boot();
        $provider = $input['provider'] ?? null;
        if (! in_array($provider, ['anthropic', 'openai', 'mistral'], true)) {
            throw new RuntimeException('Unsupported failure-usage fixture provider.');
        }
        $selected = array_values(array_filter($builder, fn ($step) => ($step['call'] ?? '') === 'using'));
        if (count($selected) !== 1 || ($selected[0]['args'][0] ?? null) !== $provider) {
            throw new RuntimeException('Failure fixture provider and builder must agree.');
        }
        $mode = $input['mode'] ?? 'single';
        if ($mode === 'serialization') {
            return self::serialization($input);
        }
        if ($mode === 'telemetry') {
            return self::telemetry($builder, $input);
        }
        if (! in_array($mode, ['single', 'reuse', 'interleave', 'continuation'], true)) {
            throw new RuntimeException('Unknown failure-usage execution mode.');
        }
        $attempts = $input['attempts'] ?? [];
        if (count($attempts) < 1 || count($attempts) > 3 || ($mode === 'single' && count($attempts) !== 1)) {
            throw new RuntimeException('A failure fixture needs one to three explicit attempts.');
        }
        $states = array_map(fn () => (object) [
            'events' => [], 'requests' => 0, 'toolCalls' => 0, 'injected' => null,
            'terminal' => ['status' => 'returned', 'exception' => null, 'injected_exception_preserved' => null, 'failure_usage' => null, 'serialized_error' => null],
        ], $attempts);
        $active = 0;
        $factory = new Factory(Container::getInstance()->make('events'));
        $factory->preventStrayRequests();
        $factory->fake(['*' => function ($request) use (&$active, $states, $attempts, $factory) {
            if (! str_starts_with($request->url(), 'https://conformance.invalid/v1/')) {
                throw new RuntimeException('Unexpected owned fixture endpoint.');
            }
            $state = $states[$active];
            $response = $attempts[$active]['responses'][$state->requests] ?? null;
            if ($response === null || $state->requests >= 3) {
                throw new RuntimeException('Unexpected extra native provider request.');
            }
            $state->requests++;

            return $factory->response(self::body($response, $state), 200, ['Content-Type' => 'text/event-stream']);
        }]);
        $client = $factory->baseUrl('https://conformance.invalid/v1');
        $newHandler = fn () => match ($provider) {
            'anthropic' => new AnthropicStream($client),
            'openai' => new OpenAIStream($client),
            'mistral' => new MistralStream($client, 'owned-conformance-only'),
        };
        $reused = $mode === 'reuse' ? $newHandler() : null;
        $generators = [];
        $eventIds = $opaqueIds = [];
        foreach ($attempts as $index => $attempt) {
            $pending = Driver::pending($builder);
            if ($mode === 'continuation') {
                if (($input['owned_tool'] ?? null) !== ['name' => 'owned_echo', 'result' => 'owned-constant-result']) {
                    throw new RuntimeException('A continuation declares only the owned constant tool.');
                }
                $steps = array_values(array_filter($builder, fn ($step) => ($step['call'] ?? '') === 'withMaxSteps'));
                if (count($steps) !== 1 || ($steps[0]['args'] ?? []) !== [2]) {
                    throw new RuntimeException('A continuation explicitly declares withMaxSteps(2).');
                }
                $state = $states[$index];
                $pending->withTools([
                    (new Tool)->as('owned_echo')->for('Owned constant continuation fixture.')->using(function () use ($state): string {
                        $state->toolCalls++;

                        return 'owned-constant-result';
                    }),
                ]);
            }
            $generators[] = self::walk(($reused ?? $newHandler())->handle($pending->toRequest()), $states[$index], $eventIds, $opaqueIds);
        }
        if ($mode === 'interleave') {
            $started = [];
            do {
                $running = false;
                foreach ($generators as $index => $generator) {
                    $active = $index;
                    if (! ($started[$index] ?? false)) {
                        $generator->rewind();
                        $started[$index] = true;
                    } elseif ($generator->valid()) {
                        $generator->next();
                    }
                    $running = $generator->valid() || $running;
                }
            } while ($running);
        } else {
            foreach ($generators as $index => $generator) {
                $active = $index;
                foreach ($generator as $_) {
                    // Iterate the actual native generator; do not synthesize terminal events.
                }
            }
        }

        return [
            'attempts' => array_map(fn ($state) => [
                'events' => $state->events, 'terminal' => $state->terminal,
                'requests' => $state->requests, 'owned_tool_calls' => $state->toolCalls,
            ], $states),
            'requests' => array_sum(array_map(fn ($state) => $state->requests, $states)),
        ];
    }

    private static function body(array $response, object $state): StreamInterface
    {
        $chunks = $response['chunks'] ?? [];
        $fault = $response['fault'] ?? 'none';
        if (($response['encoding'] ?? null) !== 'base64' || ! in_array($fault, ['none', 'transport'], true)
            || count($chunks) > 100 || ($chunks === [] && $fault !== 'transport')) {
            throw new RuntimeException('Invalid owned failure stream declaration.');
        }
        $body = new AppendStream;
        $size = 0;
        foreach ($chunks as $encoded) {
            if (! is_string($encoded) || strlen($encoded) > 1398104) {
                throw new RuntimeException('Oversized encoded failure stream chunk.');
            }
            $bytes = base64_decode($encoded, true);
            if ($bytes === false || $bytes === '' || base64_encode($bytes) !== $encoded || ($size += strlen($bytes)) > 1048576) {
                throw new RuntimeException('Invalid or oversized failure stream chunk.');
            }
            $body->addStream(Utils::streamFor($bytes));
        }
        if ($fault === 'none') {
            return $body;
        }
        $state->injected = new RuntimeException('private-transport-sentinel');

        return new class($body, $state->injected) implements StreamInterface
        {
            use StreamDecoratorTrait;

            private StreamInterface $stream;

            public function __construct(StreamInterface $stream, private readonly Throwable $failure)
            {
                $this->stream = $stream;
            }

            public function eof(): bool
            {
                return false;
            }

            public function read($length): string
            {
                if ($this->stream->eof()) {
                    throw $this->failure;
                }

                return $this->stream->read($length);
            }
        };
    }

    private static function walk(Generator $native, object $state, array &$eventIds, array &$opaqueIds): Generator
    {
        try {
            foreach ($native as $event) {
                $payload = self::normalize($event->toArray(), $eventIds, $opaqueIds);
                $row = ['type' => $event->type()->value, 'payload' => $payload];
                if ($event instanceof ErrorEvent) {
                    $row['serialized_error'] = self::normalize(json_decode(json_encode($event, JSON_THROW_ON_ERROR), true, flags: JSON_THROW_ON_ERROR), $eventIds, $opaqueIds);
                }
                $state->events[] = $row;
                yield;
            }
        } catch (Throwable $error) {
            $state->terminal = [
                'status' => 'raised', 'exception' => $error::class,
                'injected_exception_preserved' => $state->injected === null ? null : $error === $state->injected,
                'failure_usage' => $error instanceof PrismException ? $error->streamFailureUsage()?->toArray() : null,
                'serialized_error' => $error instanceof PrismException ? json_decode(json_encode($error, JSON_THROW_ON_ERROR), true, flags: JSON_THROW_ON_ERROR) : null,
            ];
        }
    }

    private static function normalize(array $payload, array &$eventIds, array &$opaqueIds): array
    {
        if (isset($payload['id'])) {
            $eventIds[$payload['id']] ??= 'event-'.(count($eventIds) + 1);
            $payload['id'] = $eventIds[$payload['id']];
        }
        if (array_key_exists('timestamp', $payload)) {
            $payload['timestamp'] = 0;
        }
        foreach ($payload as $key => $value) {
            if (in_array($key, ['message_id', 'reasoning_id'], true) && is_string($value) && $value !== '') {
                $opaqueIds[$value] ??= 'opaque-'.(count($opaqueIds) + 1);
                $payload[$key] = $opaqueIds[$value];
            } elseif (is_array($value)) {
                // Nested payloads do not contain event IDs; keep their native keys and values.
                $payload[$key] = self::aliasOpaque($value, $opaqueIds);
            }
        }

        return $payload;
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

    /** Actual public PHP telemetry is outside the ports' shared stream-event API. */
    private static function telemetry(array $builder, array $input): array
    {
        if (count($input['attempts'] ?? []) !== 1 || count($input['attempts'][0]['responses'] ?? []) !== 1) {
            throw new RuntimeException('Telemetry control needs one explicit native response.');
        }
        $app = Container::getInstance();
        $config = $app->make('config');
        $originalConfig = $config->get('prism');
        $originalHttp = Http::getFacadeRoot();
        $factory = new Factory($app->make('events'));
        $factory->preventStrayRequests();
        $state = (object) ['events' => [], 'requests' => 0, 'toolCalls' => 0, 'injected' => null,
            'terminal' => ['status' => 'returned', 'exception' => null, 'injected_exception_preserved' => null, 'failure_usage' => null, 'serialized_error' => null]];
        $factory->fake(['*' => function ($request) use ($factory, $state, $input) {
            if (! str_starts_with($request->url(), 'https://conformance.invalid/v1/') || $state->requests++ !== 0) {
                throw new RuntimeException('Unexpected public telemetry fixture request.');
            }

            return $factory->response(self::body($input['attempts'][0]['responses'][0], $state), 200, ['Content-Type' => 'text/event-stream']);
        }]);
        $telemetry = [];
        $classes = [GenerationStarted::class, GenerationCompleted::class, GenerationErrored::class, GenerationFailed::class];
        try {
            // Enable telemetry, leaving both shipped content/media capture defaults unset.
            $config->set('prism.telemetry', ['enabled' => true]);
            $config->set('prism.providers.'.$input['provider'].'.url', 'https://conformance.invalid/v1');
            Http::swap($factory);
            $app->make('events')->listen($classes, function ($event) use (&$telemetry): void {
                $row = ['class' => $event::class];
                if ($event instanceof GenerationStarted) {
                    $row['request_is_null'] = $event->request === null;
                }
                if ($event instanceof GenerationErrored || $event instanceof GenerationFailed) {
                    $row['failure_usage'] = $event->failureUsage?->toArray();
                }
                $telemetry[] = $row;
            });
            $eventIds = $opaqueIds = [];
            foreach (self::walk(Driver::pending($builder)->asStream(), $state, $eventIds, $opaqueIds) as $_) {
            }

            return ['attempts' => [['events' => $state->events, 'terminal' => $state->terminal, 'requests' => $state->requests, 'owned_tool_calls' => 0]], 'requests' => $state->requests, 'telemetry' => $telemetry];
        } finally {
            foreach ($classes as $class) {
                $app->make('events')->forget($class);
            }
            $config->set('prism', $originalConfig);
            Http::swap($originalHttp);
        }
    }

    private static function serialization(array $input): array
    {
        $reported = ($input['serialization'] ?? null) === 'reported-zero-cost';
        if (! $reported && ($input['serialization'] ?? null) !== 'legacy-error') {
            throw new RuntimeException('Unknown native serialization control.');
        }
        $failure = $reported ? new StreamFailureUsage(new Usage(0, 0, cost: 0.0), 0, ['prompt_tokens', 'completion_tokens', 'cost']) : null;
        $event = new ErrorEvent('owned-error', 0, 'owned_failure', 'owned-fixture', false, failureUsage: $failure);
        $exception = (new PrismException('private-exception-sentinel'))->withStreamFailureUsage($failure);

        return [
            'event' => $event->toArray(),
            'event_json' => json_decode(json_encode($event, JSON_THROW_ON_ERROR), true, flags: JSON_THROW_ON_ERROR),
            'exception_json' => json_decode(json_encode($exception, JSON_THROW_ON_ERROR), true, flags: JSON_THROW_ON_ERROR),
            'requests' => 0,
        ];
    }
}
