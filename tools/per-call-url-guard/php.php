<?php

declare(strict_types=1);

// Native PHP observations for the per-call-url-guard corpus. Every request
// enters through Prism::text()->using(...) and is captured by Laravel's HTTP
// fake with stray requests prevented. A row records WHETHER a request was sent
// and WHICH refusal code stopped it, never the message.
//
// PRISM_PHP_SRC points at a prism checkout (its default branch in CI, so the
// three columns are read from the same kind of tree): `Prism\Prism\` classes
// load from that checkout ahead of the runner's installed reference, and the
// config file is that checkout's. Every other class still comes from the
// runner's locked vendor. PRISM_AUTOLOAD replaces the runner's autoloader.
// Diagnostics go to stderr: stdout carries only the JSON rows.
ini_set('display_errors', 'stderr');

$source = getenv('PRISM_PHP_SRC');
if (is_string($source) && $source !== '') {
    $source = rtrim(str_replace('\\', '/', (string) realpath($source)), '/');
    if (! is_file($source.'/src/PrismManager.php')) {
        throw new RuntimeException('PRISM_PHP_SRC is not a prism checkout.');
    }
    spl_autoload_register(static function (string $class) use ($source): void {
        $prefix = 'Prism\\Prism\\';
        if (! str_starts_with($class, $prefix)) {
            return;
        }
        $file = $source.'/src/'.str_replace('\\', '/', substr($class, strlen($prefix))).'.php';
        if (is_file($file)) {
            require $file;
        }
    }, prepend: true);
}

require getenv('PRISM_AUTOLOAD') ?: __DIR__.'/../../runners/php/vendor/autoload.php';

if (is_string($source) && $source !== '') {
    // Composer prepends its own loader when the autoload file is required, so
    // ours has to go back in front of it.
    foreach (spl_autoload_functions() as $loader) {
        if ($loader instanceof Closure && (new ReflectionFunction($loader))->getStaticVariables()['source'] ?? null) {
            spl_autoload_unregister($loader);
            spl_autoload_register($loader, prepend: true);
        }
    }
}

use Illuminate\Config\Repository;
use Illuminate\Foundation\Application;
use Illuminate\Http\Client\Factory;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Support\Facades\Facade;
use Illuminate\Support\Facades\Http;
use Prism\Prism\Prism;
use Prism\Prism\PrismManager;

$input = json_decode(stream_get_contents(STDIN), true, flags: JSON_THROW_ON_ERROR);
$approvedNames = json_decode(file_get_contents(__DIR__.'/environment-names.json'), true, flags: JSON_THROW_ON_ERROR);
$declaredNames = $input['environment_names'];
sort($approvedNames);
sort($declaredNames);
if ($declaredNames !== $approvedNames) {
    throw new RuntimeException('Unapproved environment isolation names.');
}

$app = new Application(dirname(__DIR__, 2));
Facade::setFacadeApplication($app);
$package = dirname((new ReflectionClass(PrismManager::class))->getFileName(), 2);
if (is_string($source) && $source !== '' && str_replace('\\', '/', $package) !== $source) {
    throw new RuntimeException('PRISM_PHP_SRC was set but the manager loaded from elsewhere.');
}
$refusals = ['private_address_refused', 'scheme_not_allowed'];

$environment = [];
foreach ($input['environment_names'] as $name) {
    $environment[$name] = [getenv($name), $_ENV[$name] ?? null, $_SERVER[$name] ?? null];
}
$rows = [];
try {
    foreach ($input['cases'] as $entry) {
        $case = $entry['given'];
        foreach ($input['environment_names'] as $name) {
            putenv($name);
            unset($_ENV[$name], $_SERVER[$name]);
        }
        foreach ($case['env'] ?? [] as $name => $value) {
            if (! in_array($name, $approvedNames, true)) {
                throw new RuntimeException('Unapproved synthetic environment name.');
            }
            putenv($name.'='.$value);
            $_ENV[$name] = $_SERVER[$name] = $value;
        }
        // The package's own config file, read against this row's environment,
        // exactly as an application reads it.
        $config = require $package.'/config/prism.php';
        if ($case['kind'] === 'compatible') {
            $config['providers'][$case['provider']] = ['driver' => 'openai-compatible'] + $case['entry'];
        } elseif ($case['kind'] !== 'per-call') {
            throw new RuntimeException('Unknown per-call-url-guard fixture kind.');
        }
        $app->instance('config', new Repository(['prism' => $config]));
        $manager = new PrismManager($app);
        $app->instance(PrismManager::class, $manager);

        $sent = 0;
        $factory = new Factory;
        $factory->preventStrayRequests();
        $factory->fake(function (HttpRequest $request) use (&$sent) {
            $sent++;

            return Factory::response(['error' => ['message' => 'fixture']], 500);
        });
        Http::swap($factory);
        $refusal = null;
        try {
            (new Prism)->text()->using($case['provider'], 'fixture-model', $case['config'])->withPrompt('hi')->asText();
        } catch (Throwable $error) {
            // The fixture answers 500, which is not a refusal; only a refusal code is.
            $code = method_exists($error, 'code') ? $error->code() : null;
            if ($sent === 0 && in_array($code, $refusals, true)) {
                $refusal = $code;
            }
        }
        $rows[] = ['id' => $entry['id'], 'observed' => ['dispatched' => $sent > 0, 'refusal' => $refusal]];
    }
} finally {
    foreach ($environment as $name => [$value, $envValue, $serverValue]) {
        putenv($value === false ? $name : $name.'='.$value);
        if ($envValue === null) unset($_ENV[$name]); else $_ENV[$name] = $envValue;
        if ($serverValue === null) unset($_SERVER[$name]); else $_SERVER[$name] = $serverValue;
    }
}
echo json_encode($rows, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."\n";
