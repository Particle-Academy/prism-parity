<?php

declare(strict_types=1);

/**
 * Record the PHP outputs in suites/opentelemetry-media-content/cases.json.
 *
 * Runs prism-opentelemetry's real MediaContent::withoutBytes() on each input and
 * writes the compact JSON it produces into the case file as TEXT, replacing only
 * the `"php"` output literal. The document is never re-encoded as a whole.
 *
 *   PRISM_OTEL_AUTOLOAD=../prism-opentelemetry/vendor/autoload.php php tools/record-media-content.php [--check]
 */
$autoload = getenv('PRISM_OTEL_AUTOLOAD') ?: __DIR__.'/../../prism-opentelemetry/vendor/autoload.php';

if (! is_file($autoload)) {
    fwrite(STDERR, "No prism-opentelemetry autoloader at {$autoload}. Set PRISM_OTEL_AUTOLOAD.\n");
    exit(3);
}

require $autoload;

use Prism\OpenTelemetry\Support\MediaContent;

/** Where the JSON string literal starting at $open (its opening quote) ends, exclusive. */
function literalEnd(string $raw, int $open): int
{
    for ($i = $open + 1, $n = strlen($raw); $i < $n; $i++) {
        if ($raw[$i] === '\\') {
            $i++;

            continue;
        }

        if ($raw[$i] === '"') {
            return $i + 1;
        }
    }

    throw new RuntimeException('Unterminated string literal.');
}

$check = in_array('--check', $argv, true);
$path = __DIR__.'/../suites/opentelemetry-media-content/cases.json';
$raw = (string) file_get_contents($path);
$document = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
$flags = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR;
$stale = [];

foreach ($document['cases'] as $case) {
    $output = json_encode(MediaContent::withoutBytes($case['input']), $flags);

    if ($case['output']['php'] !== $output) {
        $stale[] = $case['id'];
    }

    $at = strpos($raw, '"id": "'.$case['id'].'"');
    $key = strpos($raw, '"php": ', strpos($raw, '"output": {', $at));
    $open = $key + strlen('"php": ');
    $raw = substr($raw, 0, $open).json_encode($output, $flags).substr($raw, literalEnd($raw, $open));
}

if ($check) {
    if ($stale !== []) {
        fwrite(STDERR, 'Stale php outputs: '.implode(', ', $stale)."\n");
        exit(1);
    }

    fwrite(STDERR, "PHP outputs current.\n");
    exit(0);
}

file_put_contents($path, $raw);
fwrite(STDERR, sprintf("Wrote %d php output(s); %d changed.\n", count($document['cases']), count($stale)));
