<?php

declare(strict_types=1);

// Native PHP execution for the cross-origin-redirect corpus. Every call enters
// through Prism::text()->using(...) with the provider's url and key read from
// the package's own config/prism.php against the row's environment, over
// Laravel's real HTTP client. A global middleware refuses any host that is not
// a 127.x literal. Nothing is observed here: the loopback servers are the
// observation.
//
// PRISM_PHP_SRC points at a prism checkout (its default branch in CI): the
// `Prism\Prism\` classes and the config file load from there ahead of the
// runner's installed reference. PRISM_AUTOLOAD replaces the runner's
// autoloader. Diagnostics go to stderr.
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
use Illuminate\Support\Facades\Facade;
use Illuminate\Support\Facades\Http;
use Prism\Prism\Prism;
use Prism\Prism\PrismManager;
use Psr\Http\Message\RequestInterface;

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

$environment = [];
foreach ($input['environment_names'] as $name) {
    $environment[$name] = [getenv($name), $_ENV[$name] ?? null, $_SERVER[$name] ?? null];
}
try {
    foreach ($input['rows'] as $row) {
        foreach ($input['environment_names'] as $name) {
            putenv($name);
            unset($_ENV[$name], $_SERVER[$name]);
        }
        foreach ($row['env'] as $name => $value) {
            if (! in_array($name, $approvedNames, true)) {
                throw new RuntimeException('Unapproved synthetic environment name.');
            }
            putenv($name.'='.$value);
            $_ENV[$name] = $_SERVER[$name] = $value;
        }
        // The package's own config file, read against this row's environment,
        // exactly as an application reads it.
        $config = require $package.'/config/prism.php';
        $config['request_timeout'] = 10;
        $app->instance('config', new Repository(['prism' => $config]));
        $manager = new PrismManager($app);
        $app->instance(PrismManager::class, $manager);

        $factory = new Factory;
        $factory->globalMiddleware(static fn (callable $handler): callable => static function (RequestInterface $request, array $options) use ($handler) {
            if (preg_match('/\A127\.\d+\.\d+\.\d+\z/', $request->getUri()->getHost()) !== 1) {
                throw new RuntimeException('Only loopback hosts may be contacted in this corpus.');
            }

            return $handler($request, $options);
        });
        Http::swap($factory);
        try {
            (new Prism)->text()->using($row['provider'], 'fixture-model')->withPrompt('hi')->asText();
        } catch (Throwable) {
            // Every fixture ends in a 500 or a refused redirect; the servers say which.
        }
    }
} finally {
    foreach ($environment as $name => [$value, $envValue, $serverValue]) {
        putenv($value === false ? $name : $name.'='.$value);
        if ($envValue === null) unset($_ENV[$name]); else $_ENV[$name] = $envValue;
        if ($serverValue === null) unset($_SERVER[$name]); else $_SERVER[$name] = $serverValue;
    }
}
echo "done\n";
