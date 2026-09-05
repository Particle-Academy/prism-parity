<?php

declare(strict_types=1);

/**
 * Regenerate the PHP half of suites/opentelemetry-span-attributes/cases.json.
 *
 * This suite pins the ROOT SPAN ATTRIBUTE MAP of one generation — the record
 * that leaves the application. A span is read by a backend that does not know
 * which language produced it: Phoenix groups by `session.id`, filters by
 * `gen_ai.response.finish_reasons`, and dedupes on `input.value`. Every one of
 * those is a string comparison against spans from other services, so a key or a
 * value spelled differently in one language does not error — the two services
 * simply stop appearing in the same result, and a dashboard that looks complete
 * is missing half its traffic.
 *
 * The map is read back off a REAL exporter after driving the REAL subscriber.
 * A generator that rebuilt the attribute map itself would pin what the
 * generator believes and go on agreeing with itself after somebody changed the
 * bridge.
 *
 * Timestamps and span/trace ids are excluded: they are nondeterministic by
 * construction and pinning them would make every run stale.
 *
 *   PRISM_OTEL_AUTOLOAD=../prism-opentelemetry/vendor/autoload.php php tools/generate-otel-span-attributes.php
 *   PRISM_OTEL_AUTOLOAD=... php tools/generate-otel-span-attributes.php --check
 */
$autoload = getenv('PRISM_OTEL_AUTOLOAD') ?: __DIR__.'/../../prism-opentelemetry/vendor/autoload.php';

if (! is_file($autoload)) {
    fwrite(STDERR, "No prism-opentelemetry autoloader at {$autoload}. Set PRISM_OTEL_AUTOLOAD.\n");
    exit(3);
}

require $autoload;

use Carbon\Carbon;
use Illuminate\Contracts\Support\Arrayable;
use OpenTelemetry\SDK\Trace\SpanExporter\InMemoryExporter;
use OpenTelemetry\SDK\Trace\SpanProcessor\SimpleSpanProcessor;
use OpenTelemetry\SDK\Trace\TracerProvider;
use Prism\OpenTelemetry\SpanStore;
use Prism\OpenTelemetry\TelemetrySubscriber;
use Prism\Prism\Enums\FinishReason;
use Prism\Prism\Enums\TelemetryOperation;
use Prism\Prism\Events\Telemetry\GenerationCompleted;
use Prism\Prism\Events\Telemetry\GenerationStarted;
use Prism\Prism\Telemetry\TelemetryContext;
use Prism\Prism\ValueObjects\Meta;
use Prism\Prism\ValueObjects\ProviderRateLimit;
use Prism\Prism\ValueObjects\Usage;

/**
 * A stand-in for the request/response object the bridge is handed.
 *
 * The bridge probes a request for `prompt()`, `systemPrompts()`, `messages()`
 * and `inputs()` before falling back to `toArray()`. Carrying the corpus
 * payload through that fallback is what lets all three languages be handed the
 * SAME structure: the ports take a value directly, and reproducing Prism's
 * request objects in TypeScript and Python to feed them would pin the
 * reproduction rather than the bridge.
 *
 * @implements Arrayable<string, mixed>
 */
final readonly class CorpusPayload implements Arrayable
{
    /** @param array<string, mixed> $payload */
    public function __construct(private array $payload, public ?Meta $meta = null) {}

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return $this->payload;
    }
}

/**
 * The corpus rate limits, as the value objects the reference actually carries.
 *
 * `resets_at` is parsed HERE and not in the bridge: the bridge is handed an
 * instant, so nothing in this comparison depends on three languages agreeing
 * about how to render or re-render a date.
 *
 * @param  array<int, array<string, mixed>>|null  $rateLimits
 * @return array<int, ProviderRateLimit>
 */
function rateLimitsOf(?array $rateLimits): array
{
    return array_map(static fn (array $rateLimit): ProviderRateLimit => new ProviderRateLimit(
        name: $rateLimit['name'],
        limit: $rateLimit['limit'],
        remaining: $rateLimit['remaining'],
        resetsAt: $rateLimit['resets_at'] === null ? null : new Carbon($rateLimit['resets_at']),
    ), $rateLimits ?? []);
}

/**
 * The response object the reference bridge is handed.
 *
 * Rate limits reach the reference on the RESPONSE's Meta and nowhere else, so a
 * case that declares them needs a response object even when it captures no
 * content -- which is why this returns one for a null output. That asymmetry is
 * the reference's, not the corpus's: core nulls the response entirely when
 * `prism.telemetry.capture_content` is off, so quota headroom currently rides
 * on the content switch (G-45).
 *
 * @param  array<string, mixed>  $generation
 */
function responseOf(array $generation): ?CorpusPayload
{
    if ($generation['output'] === null && $generation['rate_limits'] === null) {
        return null;
    }

    return new CorpusPayload(
        $generation['output'] ?? [],
        $generation['rate_limits'] === null
            ? null
            : new Meta(id: '', model: $generation['model'], rateLimits: rateLimitsOf($generation['rate_limits'])),
    );
}

$check = in_array('--check', $argv, true);
$path = __DIR__.'/../suites/opentelemetry-span-attributes/cases.json';
$document = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);

/** Prism's neutral operation vocabulary, resolved to the reference's enum. */
$operationOf = static fn (string $operation): TelemetryOperation => TelemetryOperation::from($operation);

/** Prism's neutral finish-reason vocabulary, resolved to the reference's enum. */
$finishReasonOf = static fn (?string $reason): ?FinishReason => $reason === null ? null : FinishReason::from($reason);

/**
 * Drive the reference for one case and read the root span back.
 *
 * @param  array<string, mixed>  $case
 * @return array<string, mixed>
 */
function emit(array $case, callable $operationOf, callable $finishReasonOf): array
{
    $generation = $case['generation'];

    $exporter = new InMemoryExporter;
    $provider = new TracerProvider(new SimpleSpanProcessor($exporter));

    $subscriber = new TelemetrySubscriber(
        $provider->getTracer('prism-parity'),
        new SpanStore,
        recordExceptions: true,
        maxContentLength: $case['max_content_length'],
    );

    $context = new TelemetryContext(
        traceId: $case['id'],
        operation: $operationOf($generation['operation']),
        provider: $generation['provider'],
        model: $generation['model'],
        startedAt: 0.0,
        userId: $generation['user_id'],
        sessionId: $generation['session_id'],
    );

    // The bridge has no capture switch of its own — the reference gates content
    // in CORE, so an event simply carries null when capture is off. Handing the
    // bridge content while `capture_content` is false is therefore a reachable
    // state here and NOT a misuse of the API: it is what otel-0013 exists to
    // record.
    $input = $generation['input'] === null ? null : new CorpusPayload($generation['input']);
    $output = responseOf($generation);

    $usage = $generation['usage'] === null ? null : new Usage(
        promptTokens: $generation['usage']['prompt_tokens'],
        completionTokens: $generation['usage']['completion_tokens'],
        cost: $generation['usage']['cost'],
    );

    $subscriber->onGenerationStarted(new GenerationStarted($context, $input));
    $subscriber->onGenerationCompleted(new GenerationCompleted(
        $context,
        0.0,
        $finishReasonOf($generation['finish_reason']),
        $usage,
        $output,
    ));

    $spans = $exporter->getSpans();

    if (count($spans) !== 1) {
        fwrite(STDERR, sprintf("%s: expected exactly one root span, got %d.\n", $case['id'], count($spans)));
        exit(4);
    }

    $attributes = $spans[0]->getAttributes()->toArray();
    ksort($attributes);

    return [
        'name' => $spans[0]->getName(),
        'status' => strtolower($spans[0]->getStatus()->getCode()),
        'attributes' => $attributes,
    ];
}

$stale = [];

foreach ($document['cases'] as $index => $case) {
    $produced = emit($case, $operationOf, $finishReasonOf);
    $recorded = $case['spans']['php'] ?? null;

    if ($recorded !== $produced) {
        $stale[] = sprintf(
            '%s: recorded %s, reference produces %s',
            $case['id'],
            json_encode($recorded, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            json_encode($produced, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        );
    }

    $document['cases'][$index]['spans']['php'] = $produced;
}

if ($check) {
    if ($stale !== []) {
        fwrite(STDERR, "Stale PHP spans in opentelemetry-span-attributes:\n  ".implode("\n  ", $stale)."\n");
        exit(1);
    }

    fwrite(STDERR, "opentelemetry-span-attributes: every PHP row matches the reference.\n");
    exit(0);
}

file_put_contents(
    $path,
    json_encode($document, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."\n",
);

fwrite(STDERR, $stale === []
    ? "opentelemetry-span-attributes: no change.\n"
    : sprintf("opentelemetry-span-attributes: rewrote %d row(s).\n  %s\n", count($stale), implode("\n  ", $stale)));
