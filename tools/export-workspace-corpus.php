<?php

declare(strict_types=1);

use Prism\Workspace\Security\EscapeCorpus;

if ($argc !== 3) {
    fwrite(STDERR, "Usage: php export-workspace-corpus.php <workspace-package> <output>\n");
    exit(2);
}

$package = realpath($argv[1]);
if ($package === false || ! is_file($package.'/vendor/autoload.php')) {
    fwrite(STDERR, "Workspace package is missing or Composer dependencies are not installed.\n");
    exit(2);
}

require $package.'/vendor/autoload.php';

$cases = array_map(static fn ($case): array => [
    'id' => $case->id,
    // Base64 is deliberate: invalid UTF-8 paths are part of the security
    // corpus and JSON strings cannot preserve their bytes.
    'path_base64' => base64_encode($case->path),
    'hazard' => $case->hazard->value,
    'refusal' => $case->refusal->value,
    'on_posix' => $case->onPosix->value,
    'on_windows' => $case->onWindows->value,
    'note' => $case->note,
], EscapeCorpus::all());

$document = [
    'schema_version' => 1,
    'corpus_version' => EscapeCorpus::VERSION,
    'encoding' => 'base64-bytes',
    'cases' => $cases,
];

$json = json_encode($document, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)."\n";
$output = $argv[2];
if (file_put_contents($output, $json) === false) {
    fwrite(STDERR, "Could not write corpus to [{$output}].\n");
    exit(1);
}

fwrite(STDOUT, sprintf("Exported %d workspace escape cases.\n", count($cases)));
