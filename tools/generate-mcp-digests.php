<?php

declare(strict_types=1);

/**
 * Regenerate every PHP digest in suites/mcp-tool-digest/cases.json BY EXECUTION.
 *
 * A digest is a hash. There is no "what the value obviously is" to fall back on,
 * so a hand-authored golden here would assert nothing at all — which makes this
 * the one suite where generating from the reference is not a convention but the
 * only option that means anything.
 *
 * It reads the payloads out of the suite itself rather than keeping a second
 * list, because two lists drift and this repository exists to say so.
 *
 * The conformance runner carries only core, so point this at the package:
 *
 *   PRISM_MCP_AUTOLOAD=../prism-mcp/vendor/autoload.php php tools/generate-mcp-digests.php
 *   PRISM_MCP_AUTOLOAD=... php tools/generate-mcp-digests.php --check
 */
$autoload = getenv('PRISM_MCP_AUTOLOAD') ?: __DIR__.'/../../prism-mcp/vendor/autoload.php';

if (! is_file($autoload)) {
    fwrite(STDERR, "No prism-mcp autoloader at {$autoload}. Set PRISM_MCP_AUTOLOAD.\n");
    exit(3);
}

require $autoload;

use Prism\Mcp\Support\Json;
use Prism\Mcp\Support\ToolDefinition;

$check = in_array('--check', $argv, true);
$path = __DIR__.'/../suites/mcp-tool-digest/cases.json';

// `Json::decode` and not `json_decode($raw, true)`, and this is load-bearing
// twice over.
//
// Reading: the assoc decode collapses `{}` onto `[]`, so it would hand the
// reference an input the corpus never wrote — the exact trap the human-plus
// corpus fell into, where a schema carried DECODED reported 17 of 18 rows
// agreeing on values none of the three languages had been asked about.
//
// Writing: this script rewrites the whole file, so an assoc decode would also
// SILENTLY REWRITE dig-0003's `"properties": {}` to `[]` on its way back out —
// destroying the case that exists to catch the defect, using the defect.
// Generalised in decision 0007: when checking for a defect, do not use a tool
// that is subject to it.
$document = Json::decode((string) file_get_contents($path), preservingContainerTypes: true);

$stale = [];

foreach ($document['cases'] as $index => $case) {
    $produced = ToolDefinition::from('conformance', $case['payload'])->digest();
    $recorded = $case['digest']['php'] ?? null;

    if ($recorded !== $produced) {
        $stale[] = sprintf('%s: recorded %s, reference produces %s', $case['id'], $recorded ?? 'nothing', $produced);
    }

    $document['cases'][$index]['digest']['php'] = $produced;
}

if ($check) {
    if ($stale !== []) {
        fwrite(STDERR, "Stale PHP goldens in mcp-tool-digest:\n  ".implode("\n  ", $stale)."\n");
        exit(1);
    }

    fwrite(STDERR, "mcp-tool-digest: every PHP golden matches the reference.\n");
    exit(0);
}

// Written back with the same formatting the corpus uses everywhere else, so a
// regeneration that changed nothing produces no diff.
file_put_contents(
    $path,
    json_encode($document, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."\n",
);

fwrite(STDERR, $stale === []
    ? "mcp-tool-digest: no change.\n"
    : sprintf("mcp-tool-digest: rewrote %d golden(s).\n  %s\n", count($stale), implode("\n  ", $stale)));
