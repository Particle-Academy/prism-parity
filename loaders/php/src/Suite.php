<?php

declare(strict_types=1);

namespace Prism\Conformance;

/**
 * One suite: its manifest, its rows, and every guard that runs at LOAD time.
 *
 * The guards are the reason the loader is a published package rather than a
 * snippet each consumer copies. Two of the copies elsewhere read a per-language
 * skip as a truthy scalar — which skipped every language at once AND made the
 * blank-reason guard unreachable, because a non-empty map is never blank. Both
 * effects were silent and both builds stayed green.
 */
final class Suite
{
    public const LANGUAGES = ['php', 'ts', 'py'];

    /**
     * @param  array<string, mixed>  $manifest
     * @param  array<int, array<string, mixed>>  $cases
     */
    private function __construct(
        public readonly string $id,
        public readonly array $manifest,
        private readonly array $cases,
    ) {}

    public static function load(string $root, string $id): self
    {
        $dir = $root.DIRECTORY_SEPARATOR.'suites'.DIRECTORY_SEPARATOR.$id;

        $manifest = self::readJson($dir.DIRECTORY_SEPARATOR.'manifest.json', $id);
        $document = self::readJson($dir.DIRECTORY_SEPARATOR.'cases.json', $id);

        if (($document['suite'] ?? null) !== $id) {
            throw CorpusError::make(
                'suite_id_mismatch',
                sprintf('cases.json for %s declares suite %s.', $id, var_export($document['suite'] ?? null, true))
            );
        }

        /** @var array<int, array<string, mixed>> $cases */
        $cases = $document['cases'] ?? [];

        self::guardCases($id, $cases);

        return new self($id, $manifest, $cases);
    }

    /**
     * @param  array<int, array<string, mixed>>  $cases
     */
    private static function guardCases(string $suiteId, array $cases): void
    {
        if ($cases === []) {
            throw CorpusError::make('empty_suite', sprintf('Suite %s has no cases.', $suiteId));
        }

        $seen = [];
        $lastInFamily = [];

        foreach ($cases as $case) {
            $id = $case['id'] ?? null;

            if (! is_string($id) || $id === '') {
                throw CorpusError::make('missing_case_id', sprintf('A case in %s has no id.', $suiteId));
            }

            if (isset($seen[$id])) {
                throw CorpusError::make('duplicate_case_id', sprintf('Case id %s appears more than once in %s.', $id, $suiteId));
            }

            $seen[$id] = true;

            // Ids are unique AND ascend WITHIN THEIR FAMILY. That is what makes
            // "a new case goes at the END" a rule a machine enforces rather than
            // a habit: file order is not chronology, and inserting between two
            // existing rows would renumber ids that other repos' skip lists
            // point at.
            //
            // Per-family rather than global, because a suite may group its cases
            // by what they probe — `workspace-path-guard` runs eight hazard
            // families (trv-, abs-, unc-, hom-, dev-, ads-, enc-, byt-) and
            // reads as eight blocks. A global rule would force those into one
            // alphabetical run, which reorders the file for no benefit: the
            // renumbering hazard the rule exists to prevent is entirely WITHIN a
            // family, since that is the only place a number can shift.
            $family = self::familyOf($id);
            $previous = $lastInFamily[$family] ?? null;

            if ($previous !== null && strcmp($id, $previous) <= 0) {
                throw CorpusError::make(
                    'unsorted_case_ids',
                    sprintf(
                        'Case id %s follows %s in %s; ids must ascend within the %s- family. New cases go at the end of theirs.',
                        $id,
                        $previous,
                        $suiteId,
                        $family
                    )
                );
            }

            $lastInFamily[$family] = $id;

            if (! isset($case['notes']) || ! is_string($case['notes']) || trim($case['notes']) === '') {
                throw CorpusError::make(
                    'missing_case_notes',
                    sprintf('Case %s has no notes. A case without a stated purpose gets deleted by someone later.', $id)
                );
            }

            self::guardSkip($id, $case['skip'] ?? null);
        }
    }

    private static function guardSkip(string $caseId, mixed $skip): void
    {
        if ($skip === null) {
            return;
        }

        // Pinned from BOTH directions: a scalar is rejected here, and the
        // blank-reason guard below is reachable because we never treat the map
        // itself as the answer.
        if (! is_array($skip) || array_is_list($skip)) {
            throw CorpusError::make(
                'skip_must_be_a_map',
                sprintf('Case %s has a non-map skip. A skip is keyed by language; a scalar skips every language at once.', $caseId)
            );
        }

        foreach ($skip as $language => $reason) {
            if (! in_array($language, self::LANGUAGES, true)) {
                throw CorpusError::make(
                    'unknown_skip_language',
                    sprintf('Case %s is skipped for unknown language %s.', $caseId, (string) $language)
                );
            }

            if (! is_string($reason) || trim($reason) === '') {
                throw CorpusError::make(
                    'blank_skip_reason',
                    sprintf('Case %s skips %s with no reason. A skip that does not say why becomes permanent silently.', $caseId, (string) $language)
                );
            }
        }
    }

    /**
     * Rows for one language, each annotated with whether it is skipped and why.
     *
     * Skipped rows are RETURNED rather than filtered out, so a runner reports
     * them and a skip stays visible instead of quietly shrinking the suite.
     *
     * @return array<int, array<string, mixed>>
     */
    public function cases(string $language): array
    {
        if (! in_array($language, self::LANGUAGES, true)) {
            throw CorpusError::make('unknown_language', sprintf('Unknown language %s.', $language));
        }

        return array_map(function (array $case) use ($language): array {
            $reason = $case['skip'][$language] ?? null;

            return $case + ['skipped' => is_string($reason), 'skip_reason' => $reason];
        }, $this->cases);
    }

    /** @return string[] */
    public function skippedIds(string $language): array
    {
        return array_values(array_map(
            fn (array $case): string => (string) $case['id'],
            array_filter($this->cases($language), fn (array $case): bool => $case['skipped'] === true)
        ));
    }

    /**
     * The id's FAMILY — everything before the last hyphen.
     *
     * `trv-0023` and `trv-0024` are the same family; `trv-0023` and `abs-0001`
     * are not. An id with no hyphen is its own family, so a suite that numbers
     * every case in one sequence behaves exactly as it did before families
     * existed.
     */
    private static function familyOf(string $id): string
    {
        $cut = strrpos($id, '-');

        return $cut === false ? $id : substr($id, 0, $cut);
    }

    /**
     * @return array<string, mixed>
     */
    private static function readJson(string $path, string $suiteId): array
    {
        if (! is_file($path)) {
            throw CorpusError::make('corpus_not_installed', sprintf('%s is missing for suite %s.', basename($path), $suiteId));
        }

        /** @var array<string, mixed> $decoded */
        $decoded = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);

        return $decoded;
    }
}
