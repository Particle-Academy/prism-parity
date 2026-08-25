<?php

declare(strict_types=1);

namespace Prism\Conformance;

use RuntimeException;

/**
 * Every load-time guard throws this, and every guard has a CODE.
 *
 * The code is the contract; the sentence is not. Loaders in three languages
 * word these differently on purpose — a test that pins the prose holds every
 * implementation to a translation and goes red on a wording improvement that
 * changed nothing.
 */
class CorpusError extends RuntimeException
{
    public function __construct(public readonly string $errorCode, string $message)
    {
        parent::__construct($message);
    }

    public static function make(string $code, string $message): self
    {
        return new self($code, $message);
    }
}
