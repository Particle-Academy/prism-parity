<?php

declare(strict_types=1);

/**
 * Regenerate the PHP half of suites/provider-rate-limits/cases.json.
 *
 * This suite pins how a provider's RESPONSE HEADERS become rate-limit buckets.
 *
 * Why it has to cross a language boundary: quota is a fact about an ACCOUNT,
 * not about a process. A PHP worker and a Python worker drawing on the same key
 * both read these headers to decide whether to send the next request, and a
 * record of what the provider said is routinely stored by one and read by
 * another. If the two disagree about which buckets exist, what they are named,
 * or when a reset happens, nothing errors — one of them simply throttles on a
 * bucket the other cannot see, or retries into a limit it believes has lifted.
 *
 * Recorded per language rather than compared against an `expect`, because the
 * three answers are the finding. `kind` is `security-corpus` for that reason and
 * because two rows are about a header being able to abort a paid-for response.
 *
 *   PRISM_AUTOLOAD=../prism/vendor/autoload.php php tools/generate-provider-rate-limits.php
 *   PRISM_AUTOLOAD=... php tools/generate-provider-rate-limits.php --check
 */
$autoload = getenv('PRISM_AUTOLOAD') ?: __DIR__.'/../../prism/vendor/autoload.php';

if (! is_file($autoload)) {
    fwrite(STDERR, "No prism autoloader at {$autoload}. Set PRISM_AUTOLOAD.\n");
    exit(3);
}

require $autoload;

use GuzzleHttp\Psr7\Response as PsrResponse;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Carbon;
use Prism\Prism\Providers\Anthropic\Concerns\ProcessesRateLimits as AnthropicRateLimits;
use Prism\Prism\Providers\Mistral\Concerns\ProcessRateLimits as MistralRateLimits;
use Prism\Prism\Providers\OpenAI\Concerns\ProcessRateLimits as OpenAIRateLimits;
use Prism\Prism\ValueObjects\ProviderRateLimit;

/**
 * The reference's three readers, reachable.
 *
 * Each is a `protected` method on a trait, so the only way to run the SHIPPED
 * code rather than a copy of it is to compose the trait and widen the method.
 * Rewriting the logic here would measure this file instead of the package --
 * which is the failure mode decision 0006 exists to prevent.
 *
 * THREE classes rather than one composing three traits: all three name the
 * method `processRateLimits`, so PHP refuses the composition outright. That
 * collision is worth noticing rather than aliasing away -- the reference has one
 * name for three genuinely different readers, which is exactly why a port can
 * implement one of them and believe it has implemented rate limits.
 */
final class AnthropicReader
{
    use AnthropicRateLimits;

    /** @return array<int, ProviderRateLimit> */
    public function read(Response $response): array
    {
        return $this->processRateLimits($response);
    }
}

final class MistralReader
{
    use MistralRateLimits;

    /** @return array<int, ProviderRateLimit> */
    public function read(Response $response): array
    {
        return $this->processRateLimits($response);
    }
}

final class OpenAIReader
{
    use OpenAIRateLimits;

    /** @return array<int, ProviderRateLimit> */
    public function read(Response $response): array
    {
        return $this->processRateLimits($response);
    }
}

/**
 * @return array<int, ProviderRateLimit>
 */
function readWith(string $provider, Response $response): array
{
    return match ($provider) {
        'anthropic' => (new AnthropicReader)->read($response),
        'mistral' => (new MistralReader)->read($response),
        'openai' => (new OpenAIReader)->read($response),
        default => throw new RuntimeException("Unknown provider {$provider}"),
    };
}

$path = __DIR__.'/../suites/provider-rate-limits/cases.json';
$document = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
$check = in_array('--check', $argv, true);

/**
 * Run one row through the reference, with the clock frozen.
 *
 * The clock is frozen because two of the three providers report a reset as a
 * DURATION. Without that, this generator would record an instant that is stale
 * the moment it is written and every duration row would report a divergence
 * that is really just elapsed time.
 *
 * @param  array<string, mixed>  $case
 * @return array<string, mixed>
 */
function run(array $case): array
{
    Carbon::setTestNow(Carbon::createFromTimestamp($case['given']['now']));

    // A real Illuminate response over a real PSR-7 one, so header CASE survives
    // exactly as a server sent it. Handing the reader a pre-normalised array
    // would silently answer prl-0008 — the row about a title-casing proxy — in
    // the generator rather than in the package.
    $response = new Response(new PsrResponse(200, $case['given']['headers'], '{}'));

    try {
        $limits = readWith($case['given']['provider'], $response);
    } catch (Throwable $e) {
        // Recorded as the bare fact that it raised. Per 0004 the class and the
        // message are outside the contract; that a header could abort the parse
        // of a successful response is not.
        return ['outcome' => 'raised', 'buckets' => null];
    } finally {
        Carbon::setTestNow();
    }

    return [
        'outcome' => 'ok',
        'buckets' => array_map(static fn ($limit): array => $limit->toArray(), $limits),
    ];
}

$stale = [];

foreach ($document['cases'] as $index => $case) {
    $produced = run($case);
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

// `agrees` is derived from whichever columns have been recorded, never asserted.
// A row cannot be marked agreeing by an editor who wanted it to.
foreach ($document['cases'] as $index => $case) {
    $answers = array_values(array_filter(
        $document['cases'][$index]['result'],
        static fn ($answer): bool => $answer !== null,
    ));

    $document['cases'][$index]['agrees'] = count($answers) > 1
        && count(array_unique(array_map(
            static fn ($answer): string => json_encode($answer, JSON_UNESCAPED_SLASHES),
            $answers,
        ))) === 1;
}

if ($check) {
    if ($stale !== []) {
        fwrite(STDERR, "Stale PHP rows in provider-rate-limits:\n  ".implode("\n  ", $stale)."\n");
        exit(1);
    }

    fwrite(STDERR, "provider-rate-limits: every PHP row matches the reference.\n");
    exit(0);
}

file_put_contents(
    $path,
    json_encode($document, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."\n",
);

fwrite(STDERR, $stale === []
    ? "provider-rate-limits: no change.\n"
    : sprintf("provider-rate-limits: rewrote %d row(s).\n", count($stale)));
