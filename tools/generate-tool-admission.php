<?php

declare(strict_types=1);

/**
 * Regenerate the PHP half of suites/human-plus-tool-admission/cases.json.
 *
 * This suite pins the ADMISSION DECISION for a surface-declared tool, and the
 * digest its pin is compared against.
 *
 * Both matter across a language boundary for the same reason: a Human+ surface
 * is shared. The same surface is driven by a PHP application and by a
 * TypeScript or Python agent, so a tool the reference reserves for the human
 * must be reserved everywhere — a name that is refused in two languages and
 * callable in the third is an agent approving its own proposals in whichever
 * one got it wrong, and nothing errors to say so.
 *
 * The digest is the same story one level down. It is the material of a pin, so
 * a pin computed against a PHP deployment has to validate in a TypeScript app.
 * Where it does not, the failure LOOKS like a surface that swapped a tool
 * definition — a rug pull that did not happen — and the usual response to that
 * is to delete the pin.
 *
 * Recorded as BEHAVIOUR, never as prose: no language here exposes a
 * machine-readable refusal code, so `allows` and `admitted` are read as two
 * separate questions instead. `allows=false` means the NAME was refused;
 * `allows=true` with `admitted=false` means the PIN was.
 *
 *   PRISM_HUMAN_PLUS_AUTOLOAD=../prism-human-plus/vendor/autoload.php php tools/generate-tool-admission.php
 *   PRISM_HUMAN_PLUS_AUTOLOAD=... php tools/generate-tool-admission.php --check
 */
$autoload = getenv('PRISM_HUMAN_PLUS_AUTOLOAD') ?: __DIR__.'/../../prism-human-plus/vendor/autoload.php';

if (! is_file($autoload)) {
    fwrite(STDERR, "No prism-human-plus autoloader at {$autoload}. Set PRISM_HUMAN_PLUS_AUTOLOAD.\n");
    exit(3);
}

require $autoload;

use Prism\HumanPlus\Data\ToolDefinition;
use Prism\HumanPlus\Exceptions\ToolRefused;
use Prism\HumanPlus\Security\TrustPolicy;

$check = in_array('--check', $argv, true);
$path = __DIR__.'/../suites/human-plus-tool-admission/cases.json';
$document = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);

/**
 * Drive the real TrustPolicy for one case.
 *
 * @param  array<string, mixed>  $case
 * @return array<string, mixed>
 */
function admit(array $case): array
{
    // The schema is parsed HERE, from the corpus's raw JSON text, by the
    // reference's own decoder. Carrying it decoded would have been the defect
    // this suite is looking for: PHP decodes `{}` and `[]` to the same value
    // and re-encodes both as `[]`, so writing this file back would silently
    // replace adm-0016's empty MAP with an empty LIST — and all three languages
    // would then agree, on an input none of them was asked about.
    $schema = json_decode($case['tool']['input_schema_json'], true, 512, JSON_THROW_ON_ERROR);

    $tool = new ToolDefinition(
        $case['tool']['name'],
        $case['tool']['description'],
        $schema,
    );

    $digest = $tool->digest();

    // `@digest` means "this tool's own digest", resolved per language. A
    // literal in the corpus would pin one encoder's output and call the other
    // two wrong before they had said anything.
    $pins = [];
    foreach ($case['policy']['pins'] ?? [] as $name => $pin) {
        $pins[$name] = $pin === '@digest' ? $digest : $pin;
    }

    $policy = match ($case['policy']['mode']) {
        'undeclared' => TrustPolicy::undeclared(),
        'everyTool' => TrustPolicy::everyTool($pins),
        default => TrustPolicy::allowing($case['policy']['tools'], $pins),
    };

    $declared = true;
    $message = null;

    try {
        $policy->assertDeclared();
    } catch (ToolRefused $e) {
        $declared = false;
        $message = $e->getMessage();
    }

    $admitted = true;

    try {
        $policy->assertAllows($tool);
    } catch (ToolRefused $e) {
        $admitted = false;
        $message ??= $e->getMessage();
    }

    return [
        'digest' => $digest,
        'declared' => $declared,
        'allows' => $policy->allows($tool->name),
        'admitted' => $admitted,
        'message' => $message,
    ];
}

$stale = [];

foreach ($document['cases'] as $index => $case) {
    $produced = admit($case);
    $recorded = $case['admission']['php'] ?? null;

    if ($recorded !== $produced) {
        $stale[] = sprintf(
            '%s: recorded %s, reference produces %s',
            $case['id'],
            json_encode($recorded, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            json_encode($produced, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        );
    }

    $document['cases'][$index]['admission']['php'] = $produced;
}

if ($check) {
    if ($stale !== []) {
        fwrite(STDERR, "Stale PHP rows in human-plus-tool-admission:\n  ".implode("\n  ", $stale)."\n");
        exit(1);
    }

    fwrite(STDERR, "human-plus-tool-admission: every PHP row matches the reference.\n");
    exit(0);
}

file_put_contents(
    $path,
    json_encode($document, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."\n",
);

fwrite(STDERR, $stale === []
    ? "human-plus-tool-admission: no change.\n"
    : sprintf("human-plus-tool-admission: rewrote %d row(s).\n  %s\n", count($stale), implode("\n  ", $stale)));
