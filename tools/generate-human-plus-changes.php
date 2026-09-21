<?php

declare(strict_types=1);

/**
 * Regenerate the PHP rows in suites/human-plus-change-feed/cases.json.
 *
 * Driven through prism-human-plus's own `SurfaceChanges::readFrom()` — the
 * method `changesSince()` calls — over the surface result each case carries. A
 * generator that re-implemented the read would pin what the generator believes
 * rather than what the package does.
 *
 * The result is decoded from the case's RAW TEXT and never re-encoded back into
 * the file. That is not fussiness: `human-plus-tool-admission` shipped a version
 * that carried its inputs decoded, and writing the file back through PHP turned
 * `1.0` into `1` and `{}` into `[]` — so all three languages agreed on inputs
 * none of them had been asked about. Half the rows here exist because a value's
 * TYPE is the thing under test.
 *
 * Each case's `"php"` string is replaced in the TEXT, never by decoding and
 * re-encoding the document (trust rubric, criterion 7), and `agrees` is
 * recomputed beside it.
 *
 *   PRISM_HUMAN_PLUS_AUTOLOAD=../prism-human-plus/vendor/autoload.php php tools/generate-human-plus-changes.php
 *   PRISM_HUMAN_PLUS_AUTOLOAD=... php tools/generate-human-plus-changes.php --check
 */
$autoload = getenv('PRISM_HUMAN_PLUS_AUTOLOAD') ?: __DIR__.'/../../prism-human-plus/vendor/autoload.php';

if (! is_file($autoload)) {
    fwrite(STDERR, "No prism-human-plus autoloader at {$autoload}. Set PRISM_HUMAN_PLUS_AUTOLOAD.\n");
    exit(3);
}

require $autoload;

use Prism\HumanPlus\Data\SurfaceChanges;
use Prism\HumanPlus\Enums\ChangeFeed;

$check = in_array('--check', $argv, true);
$path = __DIR__.'/../suites/human-plus-change-feed/cases.json';
$raw = (string) file_get_contents($path);
$document = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);

/**
 * @param  array<string, mixed>  $case
 * @return array<string, mixed>
 */
function answerFor(array $case): array
{
    $result = json_decode((string) $case['input']['result'], true, 512, JSON_THROW_ON_ERROR);
    $feed = ChangeFeed::from((string) $case['input']['feed']);

    return SurfaceChanges::readFrom(is_array($result) ? $result : [], $feed)->toArray();
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
    $produced = json_encode(answerFor($case), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);

    if ($case['rows']['php'] !== $produced) {
        $stale[] = $case['id'];
    }

    $at = strpos($raw, '"id": "'.$case['id'].'"');
    $quote = strpos($raw, '"php": ', $at) + strlen('"php": ');
    $raw = substr($raw, 0, $quote).json_encode($produced, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE).substr($raw, stringEnd($raw, $quote));

    $agrees = $produced === $case['rows']['ts'] && $produced === $case['rows']['py'];
    $valueAt = strpos($raw, '"agrees": ', $at) + strlen('"agrees": ');
    $valueEnd = $valueAt + (str_starts_with(substr($raw, $valueAt), 'true') ? 4 : 5);
    $raw = substr($raw, 0, $valueAt).($agrees ? 'true' : 'false').substr($raw, $valueEnd);
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
fwrite(STDERR, 'Wrote '.count($document['cases']).' php answer(s); '.count($stale)." changed.\n");
