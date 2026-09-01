<?php

declare(strict_types=1);

/**
 * Regenerate every PHP refusal code in suites/browser-url-policy/cases.json.
 *
 * A refusal CODE is the contract — a consumer switches on it. The sentence is
 * not, and is deliberately never pinned: the three implementations word these
 * differently on purpose, and a test over the prose holds every language to a
 * translation and goes red on a wording improvement that changed nothing.
 *
 * The conformance runner carries only core, so point this at the package:
 *
 *   PRISM_BROWSER_AUTOLOAD=../prism-browser/vendor/autoload.php php tools/generate-browser-refusals.php
 *   PRISM_BROWSER_AUTOLOAD=... php tools/generate-browser-refusals.php --check
 */
$autoload = getenv('PRISM_BROWSER_AUTOLOAD') ?: __DIR__.'/../../prism-browser/vendor/autoload.php';

if (! is_file($autoload)) {
    fwrite(STDERR, "No prism-browser autoloader at {$autoload}. Set PRISM_BROWSER_AUTOLOAD.\n");
    exit(3);
}

require $autoload;

use Prism\Browser\Exceptions\BrowserRefused;
use Prism\Browser\Security\BrowserPolicy;

$check = in_array('--check', $argv, true);
$path = __DIR__.'/../suites/browser-url-policy/cases.json';
$document = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);

$stale = [];

foreach ($document['cases'] as $index => $case) {
    $policy = new BrowserPolicy(
        allowedHosts: $case['policy']['allowed_hosts'],
        requireHttps: $case['policy']['require_https'] ?? true,
        allowedPorts: $case['policy']['allowed_ports'] ?? [443],
    );

    try {
        $policy->assertUrl($case['url']);
        $produced = null;
    } catch (BrowserRefused $refused) {
        $produced = $refused->reason;
    }

    // array_key_exists, NOT ??. A row that is ALLOWED records null, and `??`
    // fires on null as readily as on a missing key — so every allowed row read
    // as unrecorded and the checker reported drift on rows that were correct.
    $hasRecorded = array_key_exists('php', $case['refusal'] ?? []);
    $recorded = $hasRecorded ? $case['refusal']['php'] : false;

    if (! $hasRecorded || $recorded !== $produced) {
        $stale[] = sprintf(
            '%s: recorded %s, reference produces %s',
            $case['id'],
            $recorded === null ? 'allowed' : var_export($recorded, true),
            $produced === null ? 'allowed' : $produced,
        );
    }

    $document['cases'][$index]['refusal']['php'] = $produced;
}

if ($check) {
    if ($stale !== []) {
        fwrite(STDERR, "Stale PHP refusals in browser-url-policy:\n  ".implode("\n  ", $stale)."\n");
        exit(1);
    }

    fwrite(STDERR, "browser-url-policy: every PHP refusal matches the reference.\n");
    exit(0);
}

file_put_contents(
    $path,
    json_encode($document, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."\n",
);

fwrite(STDERR, $stale === []
    ? "browser-url-policy: no change.\n"
    : sprintf("browser-url-policy: rewrote %d row(s).\n  %s\n", count($stale), implode("\n  ", $stale)));
