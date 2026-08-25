<?php

declare(strict_types=1);

namespace Prism\Conformance;

/**
 * The conformance corpus, loaded from the fixtures shipped INSIDE this package.
 *
 * Two rules decide how the root is found, and both exist because of real silent
 * failures elsewhere:
 *
 *  1. The default root is discovered by walking UP from this file until a
 *     directory containing `suites/` is found. Never a fixed `../..`, never a
 *     sibling checkout. A hard-coded relative path works in exactly one
 *     directory layout and silently no-ops in every other — including CI, which
 *     checks out one repo.
 *
 *  2. The root is still an EXPLICIT parameter. Tests exercise the guards through
 *     this same code with a temporary root, rather than re-implementing the
 *     guard inside the test — which would assert nothing at all.
 */
final class Corpus
{
    /** @var array<string, Suite> */
    private array $suites = [];

    private ?string $digest = null;

    private function __construct(
        public readonly string $root,
        public readonly string $version,
    ) {}

    public static function open(?string $root = null): self
    {
        $root = $root !== null ? rtrim($root, "/\\") : self::discoverRoot();

        $versionFile = $root.DIRECTORY_SEPARATOR.'VERSION';

        if (! is_file($versionFile)) {
            throw CorpusError::make(
                'corpus_not_installed',
                sprintf('No VERSION file at %s. The corpus ships inside this package; if it is missing, the package was assembled without running the sync step.', $root)
            );
        }

        return new self($root, trim((string) file_get_contents($versionFile)));
    }

    private static function discoverRoot(): string
    {
        $dir = __DIR__;

        while (true) {
            if (is_dir($dir.DIRECTORY_SEPARATOR.'suites')) {
                return $dir;
            }

            $parent = dirname($dir);

            if ($parent === $dir) {
                throw CorpusError::make(
                    'corpus_not_installed',
                    'Walked to the filesystem root without finding a directory containing suites/.'
                );
            }

            $dir = $parent;
        }
    }

    /** @return string[] */
    public function suiteIds(): array
    {
        $ids = [];

        foreach ((array) scandir($this->root.DIRECTORY_SEPARATOR.'suites') as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }

            if (is_file($this->root.DIRECTORY_SEPARATOR.'suites'.DIRECTORY_SEPARATOR.$entry.DIRECTORY_SEPARATOR.'cases.json')) {
                $ids[] = $entry;
            }
        }

        sort($ids);

        return $ids;
    }

    public function suite(string $id): Suite
    {
        return $this->suites[$id] ??= Suite::load($this->root, $id);
    }

    /**
     * A content hash of every fixture this corpus ships.
     *
     * The VERSION number answers "which release is this?". It does not answer
     * "are we all running the same bytes?", and those come apart: an installed
     * copy mirrored before a suite was added reported one suite fewer and looked
     * perfectly green, with the version unchanged because the CONTENT moved
     * without the number moving. The digest is what cross-check.mjs compares so
     * a stale artifact is a failure rather than a smaller pass.
     *
     * Files are read as RAW BYTES. Line endings are deliberately not normalised:
     * if a checkout mangles them the digest SHOULD differ, because the files
     * really are different.
     */
    public function digest(): string
    {
        if ($this->digest !== null) {
            return $this->digest;
        }

        $paths = [];

        if (is_file($this->root.DIRECTORY_SEPARATOR.'VERSION')) {
            $paths[] = 'VERSION';
        }

        foreach (['suites', 'probes'] as $directory) {
            $paths = [...$paths, ...self::walk($this->root, $directory)];
        }

        // Vacuity guard. A discovery check that silently succeeds over an empty
        // set is worse than no check: it reports agreement it never looked for.
        if ($paths === []) {
            throw CorpusError::make(
                'corpus_not_installed',
                sprintf('Found no fixture files under %s, so there is nothing to digest.', $this->root)
            );
        }

        // Byte-wise ascending, with forward slashes on every platform. A digest
        // that differs by path separator between a Windows checkout and a Linux
        // CI runner is worse than no digest.
        usort($paths, strcmp(...));

        $hash = hash_init('sha256');

        foreach ($paths as $path) {
            hash_update($hash, $path);
            hash_update($hash, "\n");
            hash_update($hash, (string) file_get_contents(
                $this->root.DIRECTORY_SEPARATOR.str_replace('/', DIRECTORY_SEPARATOR, $path)
            ));
            hash_update($hash, "\n");
        }

        return $this->digest = 'sha256:'.hash_final($hash);
    }

    /** @return string[] */
    private static function walk(string $root, string $relative): array
    {
        $full = $root.DIRECTORY_SEPARATOR.str_replace('/', DIRECTORY_SEPARATOR, $relative);

        if (is_file($full)) {
            return [$relative];
        }

        if (! is_dir($full)) {
            return [];
        }

        $paths = [];

        foreach ((array) scandir($full) as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }

            $paths = [...$paths, ...self::walk($root, $relative.'/'.$entry)];
        }

        return $paths;
    }

    /** @return array<string, mixed> */
    public function probes(): array
    {
        $path = $this->root.DIRECTORY_SEPARATOR.'probes'.DIRECTORY_SEPARATOR.'probes.json';

        if (! is_file($path)) {
            throw CorpusError::make('corpus_not_installed', 'probes/probes.json is missing from the corpus.');
        }

        /** @var array<string, mixed> $decoded */
        $decoded = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);

        return $decoded;
    }
}
