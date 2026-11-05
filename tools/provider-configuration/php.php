<?php

declare(strict_types=1);

// A normally installed reference, without application bootstrap or dotenv.
require getenv('PRISM_AUTOLOAD') ?: __DIR__.'/../../runners/php/vendor/autoload.php';

use Illuminate\Config\Repository;
use Illuminate\Foundation\Application;
use Illuminate\Http\Client\Factory;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Facade;
use Illuminate\Support\Facades\Http;
use Prism\Prism\PrismManager;
use Prism\Prism\Providers\Anthropic\Maps\RequestPayloadMap;
use Prism\Prism\Text\Request;

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
$environment = [];
foreach ($input['environment_names'] as $name) {
    $environment[$name] = [getenv($name), $_ENV[$name] ?? null, $_SERVER[$name] ?? null];
}
$zone = date_default_timezone_get();
date_default_timezone_set('UTC');
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
        $app->instance('config', new Repository(['prism' => require $package.'/config/prism.php']));
        if ($case['kind'] === 'config') {
            try {
                $provider = (new PrismManager($app))->resolve($case['provider'], $case['config']);
                $observed = ['value' => $provider->{$case['property']}];
            } catch (TypeError) {
                $observed = ['error' => 'TypeError'];
            }
        } elseif ($case['kind'] === 'thinking') {
            if (array_key_exists('defaultConfig', $case)) {
                config(['prism.providers.anthropic.default_thinking_budget' => $case['defaultConfig']]);
            }
            $request = new Request(model: 'fixture', providerOptions: ['thinking' => $case['thinking']], reasoningEnabled: $case['reasoning'] ?? null);
            $body = RequestPayloadMap::project($request, 'text');
            $observed = ['thinking' => $body['thinking'] ?? null];
        } elseif ($case['kind'] === 'fim') {
            Carbon::setTestNow(Carbon::createFromTimestamp($case['now'], 'UTC'));
            $factory = new Factory;
            $factory->preventStrayRequests();
            $count = 0;
            $factory->fake(function ($request) use (&$count, $case) {
                if ($request->url() !== 'https://offline.invalid/v1/fim/completions') {
                    throw new RuntimeException('Unexpected fixture destination.');
                }
                $count++;
                return Factory::response(['id' => 'fixture', 'model' => 'fixture', 'choices' => [['message' => ['content' => 'ok'], 'finish_reason' => 'stop']], 'usage' => ['prompt_tokens' => 1, 'completion_tokens' => 1]], 200, $case['headers']);
            });
            Http::swap($factory);
            $response = (new Prism\Prism\Providers\Mistral\Mistral('synthetic', 'https://offline.invalid/v1'))->fim(new Prism\Prism\Fim\Request('fixture', 'mistral', 'prefix', null, null, null, null, [], [], [0]));
            $observed = ['count' => $count, 'text' => $response->text, 'rates' => array_map(static fn ($rate) => $rate->toArray(), $response->meta->rateLimits)];
        } else {
            throw new RuntimeException('Unknown configuration fixture kind.');
        }
        $rows[] = ['id' => $entry['id'], 'observed' => $observed];
    }
} finally {
    Carbon::setTestNow();
    date_default_timezone_set($zone);
    foreach ($environment as $name => [$value, $envValue, $serverValue]) {
        putenv($value === false ? $name : $name.'='.$value);
        if ($envValue === null) unset($_ENV[$name]); else $_ENV[$name] = $envValue;
        if ($serverValue === null) unset($_SERVER[$name]); else $_SERVER[$name] = $serverValue;
    }
}
echo json_encode($rows, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES)."\n";
