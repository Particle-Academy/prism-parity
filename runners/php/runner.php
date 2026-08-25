<?php

declare(strict_types=1);

/**
 * The PHP (reference) conformance runner.
 *
 * Implements the subprocess CLI contract documented in runners/README.md, so
 * scripts/cross-check.mjs can run this and the ports' runners side by side and
 * require IDENTICAL VERDICTS rather than three independently green suites.
 */

use Prism\Conformance\Canonical;
use Prism\Conformance\Corpus;
use Prism\Conformance\CorpusError;
use Prism\Conformance\Reference\Driver;

$autoload = getenv('PRISM_REFERENCE_AUTOLOAD') ?: __DIR__.'/vendor/autoload.php';

if (! is_file($autoload)) {
    fwrite(STDERR, "No autoloader at {$autoload}. Run composer install in runners/php, or set PRISM_REFERENCE_AUTOLOAD.\n");
    exit(3);
}

require $autoload;
require __DIR__.'/src/Driver.php';

$options = [];
$argvRest = array_slice($argv, 1);

for ($i = 0; $i < count($argvRest); $i++) {
    if (str_starts_with($argvRest[$i], '--')) {
        $key = substr($argvRest[$i], 2);
        $value = $argvRest[$i + 1] ?? null;

        if ($value !== null && ! str_starts_with($value, '--')) {
            $options[$key] = $value;
            $i++;
        } else {
            $options[$key] = true;
        }
    }
}

try {
    $corpus = Corpus::open(is_string($options['root'] ?? null) ? $options['root'] : null);
} catch (CorpusError $e) {
    fwrite(STDOUT, Canonical::encode(['error_code' => $e->errorCode, 'error' => $e->getMessage()])."\n");
    exit(2);
}

// The fixture set prints its own version on EVERY run. A port pinned to a stale
// corpus otherwise stays green against a contract that has moved on, and nobody
// is told.
fwrite(STDERR, sprintf("prism-parity corpus %s %s (root: %s)\n", $corpus->version, $corpus->digest(), $corpus->root));

if (($options['version'] ?? false) === true) {
    fwrite(STDOUT, $corpus->version."\n");
    exit(0);
}

$suiteIds = isset($options['suite']) && is_string($options['suite'])
    ? [$options['suite']]
    : $corpus->suiteIds();

$probeId = is_string($options['probe'] ?? null) ? $options['probe'] : null;

if ($probeId !== null && $probeId !== 'faithful') {
    // The reference implementation is not mutated. Mutants live in the ports,
    // where the hazards are; asking the reference to be deliberately wrong would
    // only test this runner.
    fwrite(STDOUT, Canonical::encode([
        'corpus_version' => $corpus->version,
        'corpus_digest' => $corpus->digest(),
        'language' => 'php',
        'unsupported_probe' => $probeId,
        'results' => [],
    ])."\n");
    exit(0);
}

$documents = [];
$failed = false;

foreach ($suiteIds as $suiteId) {
    try {
        $suite = $corpus->suite($suiteId);
    } catch (CorpusError $e) {
        fwrite(STDOUT, Canonical::encode(['error_code' => $e->errorCode, 'error' => $e->getMessage()])."\n");
        exit(2);
    }

    $results = [];

    foreach ($suite->cases('php') as $case) {
        if ($case['skipped'] === true) {
            $results[] = ['id' => $case['id'], 'status' => 'skip', 'reason' => $case['skip_reason']];

            continue;
        }

        try {
            [$expected, $actual] = evaluate($suite->manifest, $case);
        } catch (Throwable $e) {
            $results[] = ['id' => $case['id'], 'status' => 'fail', 'reason' => 'threw: '.$e->getMessage()];
            $failed = true;

            continue;
        }

        if (Canonical::equals($expected, $actual)) {
            $results[] = ['id' => $case['id'], 'status' => 'pass'];
        } else {
            $results[] = ['id' => $case['id'], 'status' => 'fail', 'expected' => $expected, 'actual' => $actual];
            $failed = true;
        }
    }

    $documents[] = [
        'corpus_version' => $corpus->version,
        'corpus_digest' => $corpus->digest(),
        'language' => 'php',
        'suite' => $suiteId,
        'probe' => $probeId ?? 'faithful',
        'results' => $results,
    ];
}

fwrite(STDOUT, Canonical::encode(count($documents) === 1 ? $documents[0] : $documents)."\n");

exit($failed ? 1 : 0);

/**
 * @param  array<string, mixed>  $manifest
 * @param  array<string, mixed>  $case
 * @return array{0: string, 1: string}
 */
function evaluate(array $manifest, array $case): array
{
    return match ($manifest['kind']) {
        'request-payload' => [
            $case['expect']['body_json'],
            Canonical::encode(Driver::requestBody($case['builder'])),
        ],
        'response-parse' => [
            $case['expect']['result_json'],
            Canonical::encode(Driver::parseResponse($case['builder'], $case['response'])),
        ],
        'roundtrip' => [
            $case['expect']['serialized_json'],
            Canonical::encode(Driver::serialize($case['subject'])),
        ],
        'error-code' => [
            $case['expect']['error_code'],
            Driver::errorCode($case['builder']),
        ],
        'container-identity' => [
            Canonical::encode($case['expect']['equal_after_parse']),
            Canonical::encode(Driver::containerIdentity($case['left_raw'], $case['right_raw'])),
        ],
        default => throw new RuntimeException('Unknown suite kind '.$manifest['kind']),
    };
}
