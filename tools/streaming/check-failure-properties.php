<?php

declare(strict_types=1);

require_once __DIR__.'/../../loaders/php/src/Canonical.php';
require_once __DIR__.'/../../runners/php/src/FailureUsageProperties.php';

use Prism\Conformance\Reference\FailureUsageProperties;

// A second implementation evaluates the same executed controls and deliberate output defects.
// No SDK source, credentials, network, or reconstructed provider output is involved.
$rows = json_decode(stream_get_contents(STDIN), true, flags: JSON_THROW_ON_ERROR);
$results = [];
foreach ($rows as $row) {
    $results[] = ['id' => $row['id'], 'name' => $row['name'] ?? null,
        'violations' => FailureUsageProperties::violations($row['trace'], $row['properties'])];
}
echo json_encode($results, JSON_THROW_ON_ERROR)."\n";
