<?php

declare(strict_types=1);

// Native PHP observations for the credential-scope corpus. A normally installed
// reference, without application bootstrap or dotenv. Every request enters
// through Prism::text()->using(...) and is captured by Laravel's HTTP fake with
// stray requests prevented. A row records WHETHER a credential was sent, never
// which value.
// Diagnostics go to stderr: stdout carries only the JSON rows.
ini_set('display_errors', 'stderr');
require getenv('PRISM_AUTOLOAD') ?: __DIR__.'/../../runners/php/vendor/autoload.php';

use Illuminate\Config\Repository;
use Illuminate\Foundation\Application;
use Illuminate\Http\Client\Factory;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Support\Facades\Facade;
use Illuminate\Support\Facades\Http;
use Prism\Prism\Prism;
use Prism\Prism\PrismManager;
use Prism\Prism\Providers\Anthropic\Anthropic;
use Prism\Prism\Providers\Mistral\Mistral;
use Prism\Prism\Providers\OpenAI\OpenAI;
use Prism\Prism\Providers\Provider;

$input = json_decode(stream_get_contents(STDIN), true, flags: JSON_THROW_ON_ERROR);
$approvedNames = json_decode(file_get_contents(__DIR__.'/environment-names.json'), true, flags: JSON_THROW_ON_ERROR);
$fixture = json_decode(file_get_contents(__DIR__.'/fixture-values.json'), true, flags: JSON_THROW_ON_ERROR);
$declaredNames = $input['environment_names'];
sort($approvedNames);
sort($declaredNames);
if ($declaredNames !== $approvedNames) {
    throw new RuntimeException('Unapproved environment isolation names.');
}

$app = new Application(dirname(__DIR__, 2));
Facade::setFacadeApplication($app);
$package = dirname((new ReflectionClass(PrismManager::class))->getFileName(), 2);
$builtIns = ['openai' => OpenAI::class, 'anthropic' => Anthropic::class, 'mistral' => Mistral::class];

$classify = static function (array $wires) use ($fixture): array {
    $text = implode("\n", $wires);
    $inherited = str_contains($text, $fixture['inherited_key']);
    $explicit = str_contains($text, $fixture['explicit_key']);

    return [
        'dispatched' => $wires !== [],
        'credential' => $inherited && $explicit ? 'both' : ($inherited ? 'inherited' : ($explicit ? 'explicit' : 'none')),
        'account' => str_contains($text, $fixture['organization']) || str_contains($text, $fixture['project']) ? 'inherited' : 'none',
    ];
};

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
        // The package's own config file, read against this row's environment:
        // the environment key and URL reach the manager exactly as in an app.
        $app->instance('config', new Repository(['prism' => require $package.'/config/prism.php']));
        $manager = new PrismManager($app);
        $app->instance(PrismManager::class, $manager);

        if ($case['kind'] === 'endpoint') {
            $wires = [];
            $factory = new Factory;
            $factory->preventStrayRequests();
            $factory->fake(function (HttpRequest $request) use (&$wires) {
                $headers = [];
                foreach ($request->headers() as $key => $values) {
                    $headers[] = $key.': '.implode(',', $values);
                }
                $wires[] = $request->url()."\n".implode("\n", $headers)."\n".$request->body();

                return Factory::response(['error' => ['message' => 'fixture']], 500);
            });
            Http::swap($factory);
            try {
                (new Prism)->text()->using($case['provider'], 'fixture-model', $case['config'])->withPrompt('hi')->asText();
            } catch (Throwable) {
                // The fixture answers 500; only the outgoing request matters.
            }
            $observed = $classify($wires);
        } elseif ($case['kind'] === 'register') {
            $stub = fn (): Provider => new class extends Provider {};
            if (array_key_exists('preregistered', $case)) {
                $manager->extend($case['preregistered'], $stub);
            }
            $refused = false;
            try {
                if ($case['replace'] ?? false) {
                    $manager->extend($case['name'], $stub, replace: true);
                } else {
                    $manager->extend($case['name'], $stub);
                }
            } catch (InvalidArgumentException $error) {
                if (! str_contains($error->getMessage(), 'already registered')) {
                    throw $error;
                }
                $refused = true;
            } catch (Error $error) {
                // A reference without explicit replacement: nothing was
                // registered, which the row then records as a stale observation.
                if (! str_contains($error->getMessage(), 'Unknown named parameter $replace')) {
                    throw $error;
                }
            }
            $intact = true;
            foreach ($builtIns as $key => $class) {
                $intact = $intact && $manager->resolve($key, ['api_key' => 'x']) instanceof $class;
            }
            $observed = ['refused' => $refused, 'builtins_intact' => $intact];
        } else {
            throw new RuntimeException('Unknown credential-scope fixture kind.');
        }
        $rows[] = ['id' => $entry['id'], 'observed' => $observed];
    }
} finally {
    foreach ($environment as $name => [$value, $envValue, $serverValue]) {
        putenv($value === false ? $name : $name.'='.$value);
        if ($envValue === null) unset($_ENV[$name]); else $_ENV[$name] = $envValue;
        if ($serverValue === null) unset($_SERVER[$name]); else $_SERVER[$name] = $serverValue;
    }
}
echo json_encode($rows, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."\n";
