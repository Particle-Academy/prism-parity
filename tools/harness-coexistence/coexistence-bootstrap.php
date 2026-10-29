<?php

declare(strict_types=1);

require getenv('PRISM_HARNESS_AUTOLOAD');
$mutant = getenv('PRISM_COEXIST_PHP_MUTANT');
if ($mutant !== false && $mutant !== '') {
    $path = realpath($mutant);
    $work = realpath(getenv('PRISM_COEXIST_WORK'));
    if ($path === false || $work === false || !str_starts_with($path, $work.DIRECTORY_SEPARATOR)) {
        throw new RuntimeException('A sabotage class must be inside this owned run directory.');
    }
    require $path;
}
