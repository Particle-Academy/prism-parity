<?php

declare(strict_types=1);

/**
 * Regenerate the PHP half of suites/memory-vector-storage/cases.json.
 *
 * This suite pins the STORAGE BYTES of a vector, which is the one value in
 * `prism-memory` that has to survive crossing a language boundary intact: a
 * vector is written to a shared store by whichever service embedded it and read
 * back by whichever service is recalling. A base64 string that decodes to
 * different doubles in another language does not error — it silently scores
 * wrong, and a recall that returns the wrong memory looks exactly like a recall
 * that returned a mediocre one.
 *
 * The refusals are pinned as a boolean plus each port's code, not as a shared
 * code, because the reference does not HAVE one: it throws typed exceptions
 * with no machine-readable identifier. That asymmetry is recorded rather than
 * papered over.
 *
 *   PRISM_MEMORY_AUTOLOAD=../prism-memory/vendor/autoload.php php tools/generate-vector-storage.php
 *   PRISM_MEMORY_AUTOLOAD=... php tools/generate-vector-storage.php --check
 */
$autoload = getenv('PRISM_MEMORY_AUTOLOAD') ?: __DIR__.'/../../prism-memory/vendor/autoload.php';

if (! is_file($autoload)) {
    fwrite(STDERR, "No prism-memory autoloader at {$autoload}. Set PRISM_MEMORY_AUTOLOAD.\n");
    exit(3);
}

require $autoload;

use Prism\Memory\Exceptions\InvalidVector;
use Prism\Memory\ValueObjects\Vector;

$check = in_array('--check', $argv, true);
$path = __DIR__.'/../suites/memory-vector-storage/cases.json';
$document = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);

$stale = [];

foreach ($document['cases'] as $index => $case) {
    try {
        $vector = Vector::of($case['values']);
        $produced = ['refused' => false, 'packed' => $vector->pack()];

        // The round trip, asserted here rather than trusted. A pack that no
        // longer unpacks to its own input is the failure this suite exists to
        // catch, and it would otherwise be invisible in a string comparison
        // that only ever compares packs to packs.
        $produced['round_trips'] = Vector::unpack($vector->pack())->values === $vector->values;
    } catch (InvalidVector) {
        $produced = ['refused' => true, 'packed' => null, 'round_trips' => null];
    }

    $recorded = array_key_exists('php', $case['storage'] ?? []) ? $case['storage']['php'] : null;

    if ($recorded !== $produced) {
        $stale[] = sprintf(
            '%s: recorded %s, reference produces %s',
            $case['id'],
            json_encode($recorded, JSON_UNESCAPED_SLASHES),
            json_encode($produced, JSON_UNESCAPED_SLASHES),
        );
    }

    $document['cases'][$index]['storage']['php'] = $produced;
}

if ($check) {
    if ($stale !== []) {
        fwrite(STDERR, "Stale PHP storage in memory-vector-storage:\n  ".implode("\n  ", $stale)."\n");
        exit(1);
    }

    fwrite(STDERR, "memory-vector-storage: every PHP row matches the reference.\n");
    exit(0);
}

file_put_contents(
    $path,
    json_encode($document, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."\n",
);

fwrite(STDERR, $stale === []
    ? "memory-vector-storage: no change.\n"
    : sprintf("memory-vector-storage: rewrote %d row(s).\n  %s\n", count($stale), implode("\n  ", $stale)));
