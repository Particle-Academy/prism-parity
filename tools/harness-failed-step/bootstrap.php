<?php

declare(strict_types=1);

$autoload = getenv('PRISM_HARNESS_AUTOLOAD') ?: __DIR__.'/../../runners/php/vendor/autoload.php';
if (! is_file($autoload)) {
    throw new RuntimeException('Install the published PHP runner dependencies first.');
}
$loader = require $autoload;
$loader->addPsr4('Prism\\Conformance\\', __DIR__.'/../../loaders/php/src');
