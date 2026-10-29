<?php

declare(strict_types=1);

namespace Prism\Harness {
    // Serial fixture only. Process, ownership and nonce probes use real entropy.
    function random_bytes(int $length): string { return str_repeat("\x07", $length); }
}

namespace {
    require getenv('PRISM_HARNESS_AUTOLOAD');
}
