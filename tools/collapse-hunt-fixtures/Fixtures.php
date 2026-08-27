<?php

declare(strict_types=1);

namespace Fixtures;

/**
 * Two known shapes, so the rule can be checked against something that does not
 * move. A rule getting quieter looks EXACTLY like the code getting better, and
 * nothing in a real repository tells those apart.
 */
class Fixtures
{
    /** MUST be reported: three failure modes, one bit, nothing announced. */
    public function collapses(): bool
    {
        if ($this->a === null) {
            return false;
        }

        if ($this->b < 0) {
            return false;
        }

        try {
            $this->run();
        } catch (\Throwable) {
            return false;
        }

        return true;
    }

    /** MUST NOT be reported: every state is announced before it is returned. */
    public function announces(): bool
    {
        if ($this->a === null) {
            $this->skip('no subject');

            return false;
        }

        // The SINGLE-LINE form. More idiomatic in PHP than the two-line one,
        // and the form that slipped through the Fancy team's first discount.
        if ($this->b < 0) { $this->skip('negative amount'); return false; }

        try {
            $this->run();
        } catch (\Throwable $e) {
            Log::warning('run failed', ['error' => $e->getMessage()]);

            return false;
        }

        return true;
    }

    /** MUST be reported: announcing SOME states does not excuse hiding three. */
    public function partiallyAnnounces(): bool
    {
        if ($this->a === null) {
            $this->skip('no subject');

            return false;
        }

        if ($this->b < 0) {
            return false;
        }

        if ($this->c === '') {
            return false;
        }

        try {
            $this->run();
        } catch (\Throwable) {
            return false;
        }

        return true;
    }
}
