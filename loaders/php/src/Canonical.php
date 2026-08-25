<?php

declare(strict_types=1);

namespace Prism\Conformance;

/**
 * The corpus has exactly one comparison mode: the canonical JSON string.
 *
 * There is deliberately no float epsilon. Loaders that each choose their own
 * tolerance are not one contract, they are N contracts that agree by accident;
 * the moment two of them disagree about how close is close enough, the
 * repository whose product is agreement has stopped producing it.
 *
 * Canonical form:
 *   - UTF-8, no insignificant whitespace
 *   - forward slashes NOT escaped
 *   - non-ASCII NOT escaped
 *   - object keys in insertion order, never sorted (key order is part of what
 *     the corpus pins, because it is part of what a port can silently change)
 */
final class Canonical
{
    public const FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;

    public static function encode(mixed $value): string
    {
        return json_encode($value, self::FLAGS | JSON_THROW_ON_ERROR);
    }

    public static function equals(string $expected, string $actual): bool
    {
        return $expected === $actual;
    }
}
