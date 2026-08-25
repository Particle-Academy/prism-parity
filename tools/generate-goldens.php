<?php

declare(strict_types=1);

/**
 * Fill every @generate placeholder in the corpus by EXECUTING the reference.
 *
 * Goldens are never hand-authored and never reasoned about. The rule exists
 * because "what the value obviously is" and "what the reference actually
 * produces" diverge exactly where it matters — a whole float that renders
 * without its fraction, a token count that is an input count minus a cached
 * count, an empty map that serialises as an empty list. A hand-written golden
 * asserts the author's model of the code; a generated one asserts the code.
 *
 * Usage:
 *   php tools/generate-goldens.php            # rewrite goldens in place
 *   php tools/generate-goldens.php --check    # fail if any golden is stale
 */

$autoload = getenv('PRISM_REFERENCE_AUTOLOAD') ?: __DIR__.'/../runners/php/vendor/autoload.php';

if (! is_file($autoload)) {
    fwrite(STDERR, "No autoloader at {$autoload}.\n");
    exit(3);
}

require $autoload;

foreach (['CorpusError', 'Canonical', 'Suite', 'Corpus'] as $class) {
    require_once __DIR__."/../loaders/php/src/{$class}.php";
}

require_once __DIR__.'/../runners/php/src/Driver.php';

use Prism\Conformance\Canonical;
use Prism\Conformance\Corpus;
use Prism\Conformance\Reference\Driver;

$check = in_array('--check', $argv, true);
$root = dirname(__DIR__);
$corpus = Corpus::open($root);

fwrite(STDERR, sprintf("prism-parity corpus %s\n", $corpus->version));

$stale = [];

foreach ($corpus->suiteIds() as $suiteId) {
    $path = $root."/suites/{$suiteId}/cases.json";
    $manifest = json_decode((string) file_get_contents($root."/suites/{$suiteId}/manifest.json"), true, 512, JSON_THROW_ON_ERROR);
    $document = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);

    $changed = false;

    foreach ($document['cases'] as $index => $case) {
        $key = match ($manifest['kind']) {
            'request-payload' => 'body_json',
            'response-parse' => 'result_json',
            'roundtrip' => 'serialized_json',
            'error-code' => 'error_code',
            'container-identity' => 'equal_after_parse',
            default => throw new RuntimeException('Unknown kind '.$manifest['kind']),
        };

        // A row the REFERENCE skips has no reference behaviour to record, so
        // there is nothing to generate. Its golden stays as authored and the
        // ports assert against it.
        $referenceSkipped = isset($case['skip'][$manifest['reference']]);

        if ($referenceSkipped) {
            if (($case['expect'][$key] ?? null) === '@generate') {
                throw new RuntimeException(sprintf(
                    'Case %s is skipped for the reference language but its golden is still @generate. A golden for a row the reference cannot run has to be authored deliberately, with the reasoning in notes.',
                    $case['id']
                ));
            }

            continue;
        }

        $produced = match ($manifest['kind']) {
            'request-payload' => Canonical::encode(Driver::requestBody($case['builder'])),
            'response-parse' => Canonical::encode(Driver::parseResponse($case['builder'], $case['response'])),
            'roundtrip' => Canonical::encode(Driver::serialize($case['subject'])),
            'error-code' => Driver::errorCode($case['builder']),
            'container-identity' => Driver::containerIdentity($case['left_raw'], $case['right_raw']),
        };

        if (is_string($produced) && str_starts_with($produced, 'unmapped:')) {
            throw new RuntimeException(sprintf('Case %s produced an unmapped reference error: %s', $case['id'], $produced));
        }

        if (($case['expect'][$key] ?? null) !== $produced) {
            $stale[] = $case['id'];
            $document['cases'][$index]['expect'][$key] = $produced;
            $changed = true;
        }
    }

    if ($changed && ! $check) {
        file_put_contents($path, json_encode($document, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."\n");
        fwrite(STDERR, sprintf("  %s: rewrote goldens\n", $suiteId));
    }
}

if ($stale !== [] && $check) {
    fwrite(STDERR, sprintf("Stale goldens: %s\nRun php tools/generate-goldens.php\n", implode(', ', $stale)));
    exit(1);
}

fwrite(STDERR, $stale === [] ? "All goldens current.\n" : sprintf("Regenerated %d golden(s).\n", count($stale)));
