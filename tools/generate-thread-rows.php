<?php

declare(strict_types=1);

/**
 * Regenerate the PHP rows in suites/harness-thread-rows/cases.json.
 *
 * Driven through prism-harness's own MessageMapper, the mapper Thread::record()
 * stores with, and ToolResultRuns::fold(), the fold Thread::messages() replays
 * with, over Prism's own value objects. A generator that re-implemented the
 * shape would pin what the generator believes rather than what the harness
 * stores.
 *
 * Each output is the rows encoded as compact JSON, in the order the harness
 * wrote the keys. The case file is rewritten by replacing each case's `"php"`
 * string in the TEXT, never by decoding and re-encoding the document (trust
 * rubric, criterion 7), and `agrees` is recomputed beside it.
 *
 *   PRISM_HARNESS_AUTOLOAD=../prism-harness/vendor/autoload.php php tools/generate-thread-rows.php
 *   PRISM_HARNESS_AUTOLOAD=... php tools/generate-thread-rows.php --check
 */
$autoload = getenv('PRISM_HARNESS_AUTOLOAD') ?: __DIR__.'/../../prism-harness/vendor/autoload.php';

if (! is_file($autoload)) {
    fwrite(STDERR, "No prism-harness autoloader at {$autoload}. Set PRISM_HARNESS_AUTOLOAD.\n");
    exit(3);
}

require $autoload;

use Prism\Harness\Support\MessageMapper;
use Prism\Harness\Support\ToolResultRuns;
use Prism\Prism\Contracts\Message;
use Prism\Prism\ValueObjects\Messages\AssistantMessage;
use Prism\Prism\ValueObjects\Messages\ToolResultMessage;
use Prism\Prism\ValueObjects\ToolApprovalRequest;
use Prism\Prism\ValueObjects\ToolApprovalResponse;
use Prism\Prism\ValueObjects\ToolCall;
use Prism\Prism\ValueObjects\ToolResult;

$check = in_array('--check', $argv, true);
$path = __DIR__.'/../suites/harness-thread-rows/cases.json';
$raw = (string) file_get_contents($path);
$document = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);

/** @return array<string, mixed> */
function row(Message $message): array
{
    return ['type' => MessageMapper::typeOf($message), ...MessageMapper::toArray($message)];
}

/** @param array<string, mixed> $input */
function written(array $input): Message
{
    return match ($input['write']) {
        'assistant' => new AssistantMessage(
            content: $input['content'],
            toolCalls: array_map(fn (array $call): ToolCall => new ToolCall(
                id: $call['id'],
                name: $call['name'],
                arguments: $call['arguments'],
                resultId: $call['result_id'] ?? null,
                reasoningId: $call['reasoning_id'] ?? null,
                reasoningSummary: $call['reasoning_summary'] ?? null,
            ), $input['tool_calls']),
            additionalContent: $input['additional_content'],
            toolApprovalRequests: array_map(
                fn (array $request): ToolApprovalRequest => new ToolApprovalRequest($request['approval_id'], $request['tool_call_id']),
                $input['approval_requests'],
            ),
        ),
        'tool_result' => new ToolResultMessage(
            array_map(fn (array $result): ToolResult => new ToolResult(
                toolCallId: $result['tool_call_id'],
                toolName: $result['tool_name'],
                args: $result['args'],
                result: $result['result'],
                toolCallResultId: $result['tool_call_result_id'] ?? null,
            ), $input['results']),
            array_map(
                fn (array $decision): ToolApprovalResponse => new ToolApprovalResponse($decision['approval_id'], $decision['approved'], $decision['reason']),
                $input['decisions'],
            ),
        ),
        default => throw new RuntimeException('Unknown row to write: '.$input['write']),
    };
}

/**
 * @param  array<string, mixed>  $case
 * @return list<array<string, mixed>>
 */
function rows(array $case): array
{
    if (isset($case['input'])) {
        return [row(written($case['input']))];
    }

    $messages = array_map(function (array $stored): Message {
        $type = $stored['type'];
        unset($stored['type']);

        return MessageMapper::fromArray($type, $stored);
    }, $case['fold']);

    return array_map(row(...), iterator_to_array(ToolResultRuns::fold($messages), false));
}

/** The offset just past the JSON string literal that starts at $quote. */
function stringEnd(string $raw, int $quote): int
{
    for ($i = $quote + 1, $n = strlen($raw); $i < $n; $i++) {
        if ($raw[$i] === '\\') {
            $i++;
        } elseif ($raw[$i] === '"') {
            return $i + 1;
        }
    }

    throw new RuntimeException('Unterminated string in the case file.');
}

$stale = [];

foreach ($document['cases'] as $case) {
    $produced = json_encode(rows($case), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);

    if ($case['rows']['php'] !== $produced) {
        $stale[] = $case['id'];
    }

    $at = strpos($raw, '"id": "'.$case['id'].'"');
    $key = strpos($raw, '"php": ', $at);
    $quote = $key + strlen('"php": ');
    $literal = json_encode($produced, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
    $raw = substr($raw, 0, $quote).$literal.substr($raw, stringEnd($raw, $quote));

    $agrees = $produced === $case['rows']['ts'] && $produced === $case['rows']['py'] ? 'true' : 'false';
    $agreesAt = strpos($raw, '"agrees": ', $at);
    $valueAt = $agreesAt + strlen('"agrees": ');
    $valueEnd = str_starts_with(substr($raw, $valueAt, 4), 'true') ? $valueAt + 4 : $valueAt + 5;
    $raw = substr($raw, 0, $valueAt).$agrees.substr($raw, $valueEnd);
}

if ($check) {
    if ($stale !== []) {
        fwrite(STDERR, 'Stale php rows: '.implode(', ', $stale)."\n");
        exit(1);
    }

    fwrite(STDERR, "PHP rows current.\n");
    exit(0);
}

file_put_contents($path, $raw);
fwrite(STDERR, sprintf("Wrote %d php row set(s); %d changed.\n", count($document['cases']), count($stale)));
