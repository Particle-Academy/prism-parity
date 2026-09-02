<?php

declare(strict_types=1);

/**
 * Regenerate the PHP half of suites/perplexity-agent-response/cases.json.
 *
 * This suite pins how ONE Agent API response body becomes the value a caller
 * acts on. That value carries three decisions a consumer cannot make for
 * itself:
 *
 *   - whether the run is FINISHED, which is what the polling loop turns on. A
 *     language that called a queued run terminal returns an empty answer as
 *     though it were the final one; one that called a cancelled run live polls
 *     until its attempt budget runs out and reports a timeout for a run that
 *     ended promptly.
 *   - which CITATIONS it carries, and in what order. A UI numbers them and the
 *     answer text refers to them by that number, so a different flattening
 *     renumbers every citation in the answer.
 *   - whether the body is REFUSED at all, and under which identifier. A
 *     consumer switches on that identifier to tell a bad request from a rate
 *     limit from an unreadable body.
 *
 * The body is untrusted input — it is whatever the provider sent — so the
 * malformed rows are not hypothetical shapes but the ones a parser is most
 * likely to disagree about.
 *
 * Driven through the REAL client against a faked transport. A generator that
 * reimplemented the mapping would pin what the generator believes and go on
 * agreeing with itself after somebody changed the client.
 *
 *   PRISM_PERPLEXITY_AUTOLOAD=../prism-perplexity/vendor/autoload.php php tools/generate-agent-responses.php
 *   PRISM_PERPLEXITY_AUTOLOAD=... php tools/generate-agent-responses.php --check
 */
$autoload = getenv('PRISM_PERPLEXITY_AUTOLOAD') ?: __DIR__.'/../../prism-perplexity/vendor/autoload.php';

if (! is_file($autoload)) {
    fwrite(STDERR, "No prism-perplexity autoloader at {$autoload}. Set PRISM_PERPLEXITY_AUTOLOAD.\n");
    exit(3);
}

require $autoload;

use Illuminate\Http\Client\Factory;
use Prism\Perplexity\Agent\AgentClient;
use Prism\Prism\Exceptions\PrismException;

$check = in_array('--check', $argv, true);
$path = __DIR__.'/../suites/perplexity-agent-response/cases.json';
$document = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);

/**
 * Drive the real client against one stubbed response and record what it makes
 * of it.
 *
 * `retrieve` rather than `create`, deliberately: it is the call the polling
 * loop makes, it sends no body of its own, and so the row records the PARSE
 * and nothing about the request that provoked it.
 *
 * @param  array<string, mixed>  $case
 * @return array<string, mixed>
 */
function parse(array $case): array
{
    $factory = new Factory;
    $factory->fake([
        '*' => $factory->response($case['body'], $case['http_status']),
    ]);

    $client = new AgentClient($factory->baseUrl('https://api.perplexity.ai'));

    try {
        $response = $client->retrieve('resp_probe');
    } catch (PrismException $exception) {
        // The identifier is what a consumer switches on, so it is recorded
        // rather than the message, which is prose and will be reworded.
        //
        // `error_code` is null here because the reference HAS no
        // machine-readable code: it builds a message string and the type it
        // carries is the PROVIDER's, or a fallback when the provider gave none.
        // Both ports define their own code alongside the provider type. That
        // asymmetry is recorded rather than papered over -- it is the same
        // shape as G-21 in the browser family.
        return [
            'refused' => true,
            'error_code' => null,
            'error_type' => errorTypeOf($exception->getMessage()),
        ];
    }

    return [
        'refused' => false,
        'id' => $response->id,
        'status' => $response->status->value,
        'terminal' => $response->isTerminal(),
        'successful' => $response->isSuccessful(),
        'model' => $response->model,
        'created_at' => $response->createdAt,
        'output_count' => count($response->output),
        'annotations' => $response->annotations,
        'usage' => $response->usage,
        'error' => $response->error === null ? null : [
            'message' => $response->error->message,
            'code' => $response->error->code,
            'type' => $response->error->type,
        ],
        'text' => $response->text(),
    ];
}

/**
 * The reference has no machine-readable error identifier — it builds a message
 * string. That asymmetry is recorded rather than papered over: the type is
 * recovered from the message the reference actually produces, and the manifest
 * says so.
 */
function errorTypeOf(string $message): string
{
    // `Perplexity Error [400]: invalid_request_error - unknown field: ...`
    return preg_match('/\]:\s*([a-z_]+)\s+-/', $message, $matches) === 1
        ? $matches[1]
        : $message;
}

$stale = [];

foreach ($document['cases'] as $index => $case) {
    $produced = parse($case);
    $recorded = $case['parsed']['php'] ?? null;

    if ($recorded !== $produced) {
        $stale[] = sprintf(
            '%s: recorded %s, reference produces %s',
            $case['id'],
            json_encode($recorded, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            json_encode($produced, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        );
    }

    $document['cases'][$index]['parsed']['php'] = $produced;
}

if ($check) {
    if ($stale !== []) {
        fwrite(STDERR, "Stale PHP rows in perplexity-agent-response:\n  ".implode("\n  ", $stale)."\n");
        exit(1);
    }

    fwrite(STDERR, "perplexity-agent-response: every PHP row matches the reference.\n");
    exit(0);
}

file_put_contents(
    $path,
    json_encode($document, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."\n",
);

fwrite(STDERR, $stale === []
    ? "perplexity-agent-response: no change.\n"
    : sprintf("perplexity-agent-response: rewrote %d row(s).\n  %s\n", count($stale), implode("\n  ", $stale)));
