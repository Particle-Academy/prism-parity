<?php

declare(strict_types=1);

/**
 * Regenerate the PHP rows in suites/harness-thread-rows/cases.json.
 *
 * Driven through prism-harness's own MessageMapper, the mapper Thread::record()
 * stores with, and ToolResultRuns::fold(), the fold Thread::messages() replays
 * with, over Prism's own value objects, and (G-387) the `ended_by_start` rows
 * through AgentRuntime::endedCallsOf() and Thread::rowPayload(), and (G-387 round 13) the
 * `read` cases through Thread::endedByStartIn(), and (G-387 round 15) the `place` cases through
 * Thread::placedRows() then the fold, the `started` row through Thread::startedPayload() and a
 * bound step through StepRows::withBoundRequests(), and (G-387 round 16) the `answer` row through
 * Thread::answerPayload() and the `call_outcomes` / `approval_reads` reads through
 * Thread::callOutcomesIn() / Thread::approvalReadsIn(). A generator that re-implemented the
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

use Prism\Harness\AgentRuntime;
use Prism\Harness\Models\Thread;
use Prism\Harness\Support\MessageMapper;
use Prism\Harness\Support\StepRows;
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

/**
 * @param  list<array<string, mixed>>  $calls
 * @return list<ToolCall>
 */
function toolCalls(array $calls): array
{
    return array_map(fn (array $call): ToolCall => new ToolCall(
        id: $call['id'],
        name: $call['name'],
        arguments: $call['arguments'],
        resultId: $call['result_id'] ?? null,
        reasoningId: $call['reasoning_id'] ?? null,
        reasoningSummary: $call['reasoning_summary'] ?? null,
    ), $calls);
}

/**
 * @param  list<array<string, mixed>>  $requests
 * @return list<ToolApprovalRequest>
 */
function approvalRequests(array $requests): array
{
    return array_map(
        fn (array $request): ToolApprovalRequest => new ToolApprovalRequest($request['approval_id'], $request['tool_call_id']),
        $requests,
    );
}

/**
 * The row a runner start records when it ends the calls a child was parked
 * on (G-387). The input is the parked step (its calls and approval requests);
 * the HARNESS decides which calls it ends, with what result, and how the row
 * is marked: AgentRuntime::endedCallsOf() builds the row, Thread::rowPayload()
 * is the payload Thread::record() stores, harness metadata included.
 *
 * @param  array<string, mixed>  $input
 * @return array<string, mixed>
 */
function endedRow(array $input): array
{
    $step = new AssistantMessage('', toolCalls($input['tool_calls']), [], approvalRequests($input['approval_requests']));
    $ended = AgentRuntime::endedCallsOf([$step]) ?? throw new RuntimeException('The harness ended no call.');

    return ['type' => MessageMapper::typeOf($ended['message']), ...Thread::rowPayload($ended['message'], endedApprovals: $ended['approvals'])];
}

/**
 * @param  array<string, mixed>  $input
 * @return list<array<string, mixed>>
 */
function answerRow(array $input): array
{
    $payload = Thread::answerPayload(storedRows($input['stored']), $input['position'],
        written(['write' => 'tool_result', 'results' => $input['results'], 'decisions' => $input['decisions']]));

    return $payload === null ? [] : [['type' => MessageMapper::TYPE_TOOL_RESULT, ...$payload]];
}

/** @param array<string, mixed> $input */
function written(array $input): Message
{
    return match ($input['write']) {
        'assistant' => new AssistantMessage(
            content: $input['content'],
            toolCalls: toolCalls($input['tool_calls']),
            additionalContent: $input['additional_content'],
            toolApprovalRequests: approvalRequests($input['approval_requests']),
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
 * How each approval READS over rows as stored (0.4.0, G-387 round 13):
 * whether a runner start ended its call, decided by the harness's own
 * reader, Thread::endedByStartIn(), the rule Thread::endedByStart() applies
 * to a stored thread.
 *
 * @param  array<string, mixed>  $case
 * @return list<array{approval_id: string, ended_by_start: bool}>
 */
function readings(array $case): array
{
    return match ($case['read']) {
        'approval_states' => array_map(
            fn (string $id): array => ['approval_id' => $id, 'ended_by_start' => Thread::endedByStartIn($case['stored'], $id)],
            $case['approvals'],
        ),
        // 0.6.0 (G-387 round 16): whether each call of the step at `step`
        // has an outcome (Thread::callOutcomesIn()), and what each approval
        // reads: pending, and the decision that stands (Thread::approvalReadsIn()).
        'call_outcomes' => Thread::callOutcomesIn(storedRows($case['stored']), $case['step']),
        'approval_reads' => Thread::approvalReadsIn(storedRows($case['stored']), $case['approvals']),
        default => throw new RuntimeException('Unknown read: '.$case['read']),
    };
}

/**
 * Rows AS STORED (0.5.1): each with its `type`, `harness: true` on a row the
 * harness wrote; a `run_id` is carried and is never a trust signal (0.6.0).
 * Positions are 1-based.
 *
 * @param  list<array<string, mixed>>  $stored
 * @return list<array<string, mixed>>
 */
function storedRows(array $stored): array
{
    $rows = [];
    foreach ($stored as $index => $row) {
        $type = $row['type'];
        $harness = ($row['harness'] ?? false) === true;
        $runId = is_string($row['run_id'] ?? null) ? $row['run_id'] : null;
        unset($row['type'], $row['harness'], $row['run_id']);
        $rows[] = ['position' => $index + 1, 'type' => $type, 'run_id' => $runId, 'harness' => $harness, 'payload' => $row];
    }

    return $rows;
}

/**
 * @param  array<string, mixed>  $case
 * @return list<array<string, mixed>>
 */
function rows(array $case): array
{
    if (isset($case['read'])) {
        return readings($case);
    }
    if (isset($case['place'])) {
        // Rows as stored, each with its `type` and, for a row the harness
        // wrote, `harness: true`; positions are 1-based (0.5.1, G-387 round
        // 15): placed as the replay places them, then folded.
        $messages = array_map(static fn (array $row): Message => MessageMapper::fromArray($row['type'], $row['payload']),
            Thread::placedRows(storedRows($case['place'])));

        return array_map(row(...), iterator_to_array(ToolResultRuns::fold($messages), false));
    }
    if (isset($case['input'])) {
        return match (true) {
            $case['input']['write'] === 'ended_by_start' => [endedRow($case['input'])],
            // The row the runtime stores when it answers the step at
            // `position` (0.6.0, G-387 round 16): Thread::answerPayload().
            $case['input']['write'] === 'answer' => answerRow($case['input']),
            // The write-ahead started row (0.5.1, G-387 round 15): Thread::startedPayload().
            $case['input']['write'] === 'started' => [['type' => MessageMapper::TYPE_TOOL_RESULT, ...Thread::startedPayload(
                $case['input']['tool_call_id'], $case['input']['tool_name'], $case['input']['approval_id'], $case['input']['position'])]],
            // A step as stored, each request bound to its call (0.5.1): StepRows::withBoundRequests().
            ($case['input']['bind'] ?? false) === true => [['type' => MessageMapper::TYPE_ASSISTANT,
                ...StepRows::withBoundRequests(MessageMapper::toArray(written($case['input'])))]],
            default => [row(written($case['input']))],
        };
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
