<?php

declare(strict_types=1);

/**
 * Loader guards, exercised against the SHIPPED corpus.
 *
 * Every assertion below runs against the corpus this package ships, or against a
 * copy of it that has been deliberately corrupted. None of them run against
 * hand-written example rows. A loader can assert something the reference
 * language cannot express, and no amount of green ticks will surface it — and
 * this loader's language is the reference, which makes it the likeliest place
 * for such an assertion to hide.
 *
 * Deliberately dependency-free: the loader package has no dev dependencies, so
 * this runs anywhere PHP does, which is the point. A test suite that needs a
 * toolchain nobody installed is a test suite that runs nowhere.
 *
 *   php tests/run.php
 */

foreach (['CorpusError', 'Canonical', 'Suite', 'Corpus'] as $class) {
    require_once __DIR__."/../src/{$class}.php";
}

use Prism\Conformance\Canonical;
use Prism\Conformance\Corpus;
use Prism\Conformance\CorpusError;
use Prism\Conformance\Suite;

$passed = 0;
$failed = [];

function test(string $name, callable $body): void
{
    global $passed, $failed;

    try {
        $body();
        $passed++;
        fwrite(STDOUT, "  ok  {$name}\n");
    } catch (Throwable $e) {
        $failed[] = "{$name}: ".$e->getMessage();
        fwrite(STDOUT, "  FAIL  {$name} — {$e->getMessage()}\n");
    }
}

function assertTrue(bool $condition, string $message): void
{
    if (! $condition) {
        throw new RuntimeException($message);
    }
}

function assertSame(mixed $expected, mixed $actual, string $message): void
{
    if ($expected !== $actual) {
        throw new RuntimeException(sprintf('%s (expected %s, got %s)', $message, var_export($expected, true), var_export($actual, true)));
    }
}

/**
 * A copy of the SHIPPED corpus with one deliberate corruption.
 *
 * The guards are exercised through the real Corpus code with an explicit root,
 * rather than re-implemented inside the test — a re-implemented guard asserts
 * nothing at all, which is the exact bug this repository exists to catch.
 */
function corruptedCorpus(callable $mutate): string
{
    $dir = sys_get_temp_dir().DIRECTORY_SEPARATOR.'prism-parity-'.bin2hex(random_bytes(6));

    copyTree(dirname(__DIR__), $dir);

    $path = $dir.'/suites/openai-text-request/cases.json';
    $document = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    $mutate($document);
    file_put_contents($path, json_encode($document, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));

    return $dir;
}

function copyTree(string $from, string $to): void
{
    @mkdir($to, 0o777, true);

    foreach ((array) scandir($from) as $entry) {
        if ($entry === '.' || $entry === '..' || $entry === 'vendor' || $entry === 'node_modules') {
            continue;
        }

        $source = $from.DIRECTORY_SEPARATOR.$entry;
        $target = $to.DIRECTORY_SEPARATOR.$entry;

        is_dir($source) ? copyTree($source, $target) : copy($source, $target);
    }
}

function removeTree(string $dir): void
{
    if (! is_dir($dir)) {
        return;
    }

    foreach ((array) scandir($dir) as $entry) {
        if ($entry === '.' || $entry === '..') {
            continue;
        }

        $path = $dir.DIRECTORY_SEPARATOR.$entry;
        is_dir($path) ? removeTree($path) : unlink($path);
    }

    rmdir($dir);
}

function expectLoadError(string $code, callable $mutate): void
{
    $dir = corruptedCorpus($mutate);

    try {
        Corpus::open($dir)->suite('openai-text-request');
        throw new RuntimeException("expected load to fail with code {$code}, but it succeeded");
    } catch (CorpusError $e) {
        assertSame($code, $e->errorCode, 'wrong error code');
    } finally {
        removeTree($dir);
    }
}

fwrite(STDOUT, "prism-conformance PHP loader\n");

test('the shipped corpus loads and every suite passes its own guards', function (): void {
    $corpus = Corpus::open();

    assertTrue((bool) preg_match('/^\d+\.\d+\.\d+$/', $corpus->version), 'version is not a semver');
    assertTrue($corpus->suiteIds() !== [], 'no suites found');

    foreach ($corpus->suiteIds() as $id) {
        $suite = $corpus->suite($id);
        assertSame($id, $suite->manifest['id'], "manifest id mismatch for {$id}");
        assertTrue($suite->cases('php') !== [], "suite {$id} has no cases");
    }
});

test('a duplicate case id is a load error', function (): void {
    expectLoadError('duplicate_case_id', function (array &$document): void {
        $document['cases'][] = $document['cases'][0];
    });
});

test('case ids must ascend, so a new case goes at the end', function (): void {
    expectLoadError('unsorted_case_ids', function (array &$document): void {
        [$document['cases'][0], $document['cases'][1]] = [$document['cases'][1], $document['cases'][0]];
    });
});

test('a case without notes is a load error', function (): void {
    expectLoadError('missing_case_notes', function (array &$document): void {
        $document['cases'][0]['notes'] = '   ';
    });
});

// The skip guard, pinned from BOTH directions. A loader that reads the skip as
// truthy skips the row for every language at once AND makes the blank-reason
// guard unreachable, because a non-empty map is never blank. Both silent.
test('a scalar skip is a load error', function (): void {
    expectLoadError('skip_must_be_a_map', function (array &$document): void {
        $document['cases'][0]['skip'] = true;
    });
});

test('a list skip is a load error', function (): void {
    expectLoadError('skip_must_be_a_map', function (array &$document): void {
        $document['cases'][0]['skip'] = ['php'];
    });
});

test('a blank skip reason is a load error', function (): void {
    expectLoadError('blank_skip_reason', function (array &$document): void {
        $document['cases'][0]['skip'] = ['php' => ''];
    });
});

test('a skip for an unknown language is a load error', function (): void {
    expectLoadError('unknown_skip_language', function (array &$document): void {
        $document['cases'][0]['skip'] = ['rust' => 'no rust port exists yet'];
    });
});

test('a skip applies to its own language only', function (): void {
    $suite = Corpus::open()->suite('openai-text-request');

    $find = fn (string $language): array => array_values(array_filter(
        $suite->cases($language),
        fn (array $case): bool => $case['id'] === 'trq-0025'
    ))[0];

    assertSame(true, $find('py')['skipped'], 'trq-0025 should be skipped for py');
    assertSame(false, $find('ts')['skipped'], 'trq-0025 should not be skipped for ts');
    assertSame(false, $find('php')['skipped'], 'trq-0025 should not be skipped for php');
    assertSame(null, $find('ts')['skip_reason'], 'a non-skipped row carries no reason');
});

test('skipped rows are returned rather than filtered away', function (): void {
    $suite = Corpus::open()->suite('openai-text-request');

    assertSame(count($suite->cases('ts')), count($suite->cases('py')), 'skips must not shrink the suite');
    assertTrue(in_array('trq-0025', $suite->skippedIds('py'), true), 'trq-0025 missing from py skips');
    assertTrue(! in_array('trq-0025', $suite->skippedIds('ts'), true), 'trq-0025 should not be a ts skip');
});

test('an unknown language is rejected', function (): void {
    try {
        Corpus::open()->suite('openai-text-request')->cases('rust');
        throw new RuntimeException('expected unknown_language');
    } catch (CorpusError $e) {
        assertSame('unknown_language', $e->errorCode, 'wrong error code');
    }
});

test('a root with no VERSION file reports corpus_not_installed', function (): void {
    $dir = sys_get_temp_dir().DIRECTORY_SEPARATOR.'prism-parity-empty-'.bin2hex(random_bytes(6));
    mkdir($dir, 0o777, true);

    try {
        Corpus::open($dir);
        throw new RuntimeException('expected corpus_not_installed');
    } catch (CorpusError $e) {
        assertSame('corpus_not_installed', $e->errorCode, 'wrong error code');
    } finally {
        removeTree($dir);
    }
});

// The comparator, exercised against every golden the corpus actually ships
// rather than against invented pairs. Verdicts are judged with PHP's own ===,
// never with Canonical::equals — using a comparator to judge its own output is
// circular, and a broken one could pass its own table.
test('the comparator accepts each shipped golden and rejects any byte change', function (): void {
    $corpus = Corpus::open();
    $checked = 0;

    foreach ($corpus->suiteIds() as $suiteId) {
        foreach ($corpus->suite($suiteId)->cases('php') as $case) {
            foreach ($case['expect'] as $value) {
                if (! is_string($value)) {
                    continue;
                }

                assertTrue(Canonical::equals($value, $value) === true, $case['id'].' should match itself');
                assertTrue(Canonical::equals($value, $value.' ') === false, $case['id'].' should reject a byte change');
                $checked++;

                break;
            }
        }
    }

    assertTrue($checked >= 40, "expected the corpus to carry goldens, checked {$checked}");
});

test('no shipped case declares a tolerance, so every comparison is exact', function (): void {
    $corpus = Corpus::open();

    foreach ($corpus->suiteIds() as $suiteId) {
        foreach ($corpus->suite($suiteId)->cases('php') as $case) {
            assertTrue(
                ! isset($case['tolerance']),
                $case['id'].' declares a tolerance; if that is deliberate, TEST the justification before relying on it'
            );
        }
    }
});

test('every language the corpus knows about is one a loader can be asked for', function (): void {
    $suite = Corpus::open()->suite('openai-text-request');

    foreach (Suite::LANGUAGES as $language) {
        assertTrue($suite->cases($language) !== [], "no cases for {$language}");
    }
});

test('every probe names only real suites and cases, and a control exists', function (): void {
    $corpus = Corpus::open();
    $probes = $corpus->probes()['probes'];

    assertTrue($probes !== [], 'no probes declared — the conformance table would be decoration');
    assertTrue(
        array_filter($probes, fn (array $probe): bool => $probe['kind'] === 'control') !== [],
        'no control probe — without one, the mutants prove only that the port is broken'
    );

    foreach ($probes as $probe) {
        foreach ($probe['must_fail'] ?? [] as $suiteId => $ids) {
            $known = array_column($corpus->suite($suiteId)->cases('php'), 'id');

            foreach ($ids as $id) {
                assertTrue(in_array($id, $known, true), "probe {$probe['id']} names {$id}, not in {$suiteId}");
            }
        }
    }
});

fwrite(STDOUT, sprintf("\n%d passed, %d failed\n", $passed, count($failed)));

exit($failed === [] ? 0 : 1);
