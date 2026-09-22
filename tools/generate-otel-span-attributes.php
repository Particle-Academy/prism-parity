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
use Prism\Prism\Schema\RawSchema;
use Prism\Prism\Telemetry\TelemetryContext;
use Prism\Prism\Tool;
use Prism\Prism\ValueObjects\AdvertisedTool;
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
    public function __construct(private array $payload) {}

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
/**
 * The tools a row advertises, as the reference's own value objects.
 *
 * A row carries each tool's DECLARATION -- name, description, parameters -- and
 * never its digest, so `AdvertisedTool::from()` computes the fingerprint here
 * exactly as it does in an application. That is what makes the digest a
 * COMPARED value rather than a copied one.
 *
 * Absent stays absent: a row with no `tools` key produces an empty list, which
 * the bridge renders as no tool attributes at all -- a different assertion from
 * a row that advertises an empty tool set.
 *
 * @param  array<int, array<string, mixed>>|null  $tools
 * @return list<AdvertisedTool>
 */
function advertisedToolsOf(?array $tools): array
{
    if ($tools === null) {
        return [];
    }

    return array_values(array_map(
        function (array $tool): AdvertisedTool {
            $built = (new Tool)->as($tool['name'])->for($tool['description'] ?? '');

            // Built through the real builder rather than by handing a schema
            // array straight in: `parametersAsArray()` is what the digest reads,
            // and a tool assembled any other way would fingerprint a shape no
            // application produces.
            foreach ($tool['parameters'] ?? [] as $name => $schema) {
                $built->withParameter(new RawSchema($name, $schema));
            }

            return AdvertisedTool::from($built);
        },
        $tools,
    ));
}

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
 * Only the OUTPUT travels here, in all three languages now. Rate limits used to
 * have to as well: the reference's only channel for them was the response's
 * Meta, so a case declaring quota needed a response object even with capture
 * off -- a state core never produces, which is what let the rate-limit rows be
 * green for a bridge that exported none on a real generation. That was G-45,
 * and `GenerationCompleted` now carries the buckets as its own argument.
 *
 * @param  array<string, mixed>  $generation
 */
function responseOf(array $generation): ?CorpusPayload
{
    return $generation['output'] === null ? null : new CorpusPayload($generation['output']);
}

$check = in_array('--check', $argv, true);
$path = __DIR__.'/../suites/opentelemetry-span-attributes/cases.json';
$json = (string) file_get_contents($path);

// TWO DECODES, AND THE SECOND ONE IS WHY.
//
// This tool writes ONE column and rewrites the WHOLE file, so whatever it
// cannot represent it destroys. `json_decode($json, true)` turns an empty map
// into an empty ARRAY, and re-encoding writes it back as `[]` -- so a case
// input containing `{}` anywhere silently changed shape under a tool that was
// only supposed to record a span.
//
// That is not hypothetical: it happened to otel-0021 and otel-0023 the first
// time they were generated. A tool declaring `"parameters": {}` came back as
// `"parameters": []`, the TypeScript recorder then read the corrupted value and
// hashed it, and the two languages AGREED -- on a shape neither of them had
// been given. A false agreement manufactured by the fixture rather than by the
// code, in the suite that exists to detect exactly that.
//
// So the OBJECT tree is what gets written back, preserving every empty map, and
// the ARRAY tree is only ever read from.
$document = json_decode($json, false, 512, JSON_THROW_ON_ERROR);
$readable = json_decode($json, true, 512, JSON_THROW_ON_ERROR);

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

    // The cache and reasoning fields are OPTIONAL in the fixture: the rows that
    // predate them do not carry the keys, and null is how the bridge is told a
    // provider reported nothing -- which is not the same as zero.
    $usage = $generation['usage'] === null ? null : new Usage(
        promptTokens: $generation['usage']['prompt_tokens'],
        completionTokens: $generation['usage']['completion_tokens'],
        cacheWriteInputTokens: $generation['usage']['cache_write_input_tokens'] ?? null,
        cacheReadInputTokens: $generation['usage']['cache_read_input_tokens'] ?? null,
        thoughtTokens: $generation['usage']['thought_tokens'] ?? null,
        cost: $generation['usage']['cost'],
    );

    // THE DIGEST IS COMPUTED, NOT COPIED. A row supplies each tool's
    // DECLARATION and every language fingerprints it itself, which is the only
    // way this suite can ask whether the three agree about the digest -- the
    // question that attribute exists to answer. Handing all three columns the
    // same precomputed string would pin the fixture instead of the code.
    $subscriber->onGenerationStarted(
        new GenerationStarted($context, $input, advertisedToolsOf($generation['tools'] ?? null)),
    );
    $subscriber->onGenerationCompleted(new GenerationCompleted(
        $context,
        0.0,
        $finishReasonOf($generation['finish_reason']),
        $usage,
        $output,
        rateLimitsOf($generation['rate_limits']),
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

foreach ($readable['cases'] as $index => $case) {
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

    // Written onto the OBJECT tree. `$produced` is a string-keyed array and
    // encodes as an object; its `attributes` map is never empty, so nothing
    // here can reintroduce the `[]` problem this split exists to avoid.
    $document->cases[$index]->spans->php = $produced;
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
