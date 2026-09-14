<?php

declare(strict_types=1);

/**
 * Regenerate the PHP verdicts in suites/harness-turn-attachments/cases.json.
 *
 * Driven through the real `TurnAttachments::admit()`, the function
 * `AgentRuntime::send()` and `stream()` call, with media built by Prism's own
 * factories. A generator that re-implemented the rules would pin what the
 * generator believes rather than what the harness does.
 *
 * The case file is rewritten by replacing each `"php": ...` verdict in the TEXT,
 * never by decoding and re-encoding the document. Re-encoding through PHP would
 * be the recording tool changing the rows it records (trust rubric, criterion 7).
 *
 *   PRISM_HARNESS_AUTOLOAD=../prism-harness/vendor/autoload.php php tools/generate-turn-attachments.php
 *   PRISM_HARNESS_AUTOLOAD=... php tools/generate-turn-attachments.php --check
 */
$autoload = getenv('PRISM_HARNESS_AUTOLOAD') ?: __DIR__.'/../../prism-harness/vendor/autoload.php';

if (! is_file($autoload)) {
    fwrite(STDERR, "No prism-harness autoloader at {$autoload}. Set PRISM_HARNESS_AUTOLOAD.\n");
    exit(3);
}

require $autoload;

use Prism\Harness\Exceptions\UnacceptableAttachment;
use Prism\Harness\Support\TurnAttachments;
use Prism\Prism\ValueObjects\Media\Document;
use Prism\Prism\ValueObjects\Media\Image;
use Prism\Prism\ValueObjects\Media\Text;

$check = in_array('--check', $argv, true);
$path = __DIR__.'/../suites/harness-turn-attachments/cases.json';
$raw = (string) file_get_contents($path);
$document = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);

/** @param array<string, mixed> $spec */
function attachment(array $spec): mixed
{
    return match ($spec['$']) {
        'Text' => new Text($spec['text']),
        'String' => $spec['value'],
        'Image', 'Document' => media($spec),
        default => throw new RuntimeException('Unknown attachment construct '.$spec['$']),
    };
}

/** @param array<string, mixed> $spec */
function media(array $spec): Image|Document
{
    $document = $spec['$'] === 'Document';
    $class = $document ? Document::class : Image::class;
    $title = $spec['title'] ?? null;

    return match ($spec['from']) {
        'base64' => $class::fromBase64($spec['base64'], $spec['mimeType'] ?? null),
        'url' => $class::fromUrl($spec['url']),
        // Built by the constructor so the bytes are in hand without a fetch.
        'urlWithBytes' => new $class($spec['url'], $spec['base64']),
        'localPath' => (function () use ($class, $spec): Image|Document {
            $file = tempnam(sys_get_temp_dir(), 'att');
            file_put_contents($file, $spec['bytes']);

            try {
                return $class::fromLocalPath($file, $spec['mimeType']);
            } finally {
                @unlink($file);
            }
        })(),
        'fileId' => $document ? Document::fromFileId($spec['fileId'], $title) : Image::fromFileId($spec['fileId']),
        'chunks' => Document::fromChunks($spec['chunks'], $title),
        'text' => Document::fromText($spec['text'], $title),
        'nothing' => new $class,
        default => throw new RuntimeException('Unknown media source '.$spec['from']),
    };
}

$stale = [];

foreach ($document['cases'] as $case) {
    try {
        TurnAttachments::admit($case['prompt'], array_map(attachment(...), $case['attachments']));
        $verdict = 'admitted';
    } catch (UnacceptableAttachment $refused) {
        $verdict = $refused->code();
    }

    if ($case['verdict']['php'] !== $verdict) {
        $stale[] = $case['id'];
    }

    // Replace this case's php verdict in the text. The id is unique and the
    // verdict object follows it, so the first `"php": "..."` after the id is it.
    $at = strpos($raw, '"id": "'.$case['id'].'"');
    $verdictAt = strpos($raw, '"php": ', $at);
    $end = strpos($raw, '"', $verdictAt + strlen('"php": "'));
    $raw = substr($raw, 0, $verdictAt).'"php": "'.$verdict.substr($raw, $end);
}

if ($check) {
    if ($stale !== []) {
        fwrite(STDERR, 'Stale php verdicts: '.implode(', ', $stale)."\n");
        exit(1);
    }

    fwrite(STDERR, "PHP verdicts current.\n");
    exit(0);
}

file_put_contents($path, $raw);
fwrite(STDERR, sprintf("Wrote %d php verdict(s); %d changed.\n", count($document['cases']), count($stale)));
