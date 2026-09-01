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

use Prism\Mcp\Support\ToolDefinition;

$check = in_array('--check', $argv, true);
$path = __DIR__.'/../suites/mcp-tool-digest/cases.json';
$document = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);

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
