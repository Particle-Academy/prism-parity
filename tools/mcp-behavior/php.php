<?php

declare(strict_types=1);

// No application bootstrap, dotenv or real transport. Public native discovery
// and RemoteTool execute against a fixture at the protocol-reply boundary.
$autoload = getenv('PRISM_MCP_AUTOLOAD');
if (! is_string($autoload) || ! is_file($autoload)) {
    throw new RuntimeException('Set PRISM_MCP_AUTOLOAD to the verified MCP reference autoloader.');
}
require $autoload;

use Illuminate\Cache\ArrayStore;
use Illuminate\Cache\CacheManager;
use Illuminate\Cache\Repository;
use Illuminate\Config\Repository as Config;
use Illuminate\Foundation\Application;
use Illuminate\Http\Client\Factory;
use Illuminate\Support\Facades\Facade;
use Prism\Mcp\Client\Client;
use Prism\Mcp\Client\PendingConnection;
use Prism\Mcp\Client\Protocol;
use Prism\Mcp\Client\ServerConfig;
use Prism\Mcp\Client\ToolResult;
use Prism\Mcp\Exceptions\McpException;
use Prism\Mcp\Gates\AllowAll;
use Prism\Mcp\Support\ToolDefinition;
use Prism\Mcp\Tools\RemoteTool;
use Prism\Mcp\Transport\HttpTransport;
use Prism\Mcp\Trust\ResultGuard;
use Psr\Log\AbstractLogger;

class McpCorpusLog extends AbstractLogger
{
    public array $warnings = [];

    public function log($level, string|Stringable $message, array $context = []): void
    {
        if ($level === 'warning') {
            $this->warnings[] = (string) $message;
        }
    }
}

class McpCorpusClient extends Client
{
    public int $dispatches = 0;

    public function __construct(ServerConfig $config, public array $fixture)
    {
        $http = new Factory;
        $http->preventStrayRequests();
        parent::__construct($config, new Protocol(new HttpTransport($http, 'https://owned.invalid', 'configured'), []), new Repository(new ArrayStore));
    }

    protected function negotiateAndFetch(): array
    {
        $this->dispatches++;

        return [$this->fixture['tools'], null, null];
    }

    public function callTool(string $tool, array $arguments, array $headers = []): ToolResult
    {
        $this->dispatches++;

        return ToolResult::from('configured', $this->fixture);
    }
}

class McpCorpusConnection extends PendingConnection
{
    public McpCorpusClient $fixtureClient;

    public function client(): Client
    {
        return $this->fixtureClient;
    }
}

$input = json_decode(stream_get_contents(STDIN), true, flags: JSON_THROW_ON_ERROR);
$app = new Application(dirname(__DIR__, 2));
$app->instance('config', new Config(['cache' => ['default' => 'array', 'stores' => ['array' => ['driver' => 'array']]]]));
$logger = new McpCorpusLog;
$app->instance('log', $logger);
Facade::setFacadeApplication($app);
$rows = [];
$payload = ['name' => 'owned', 'description' => 'Owned fixture', 'inputSchema' => ['type' => 'object', 'properties' => []]];
foreach ($input['cases'] as $entry) {
    $given = $entry['given'];
    $kind = $given['kind'];
    $logger->warnings = [];
    if ($kind === 'flag') {
        $reply = ['content' => []];
        if ($given['present']) {
            $reply['isError'] = $given['value'];
        }
        $observed = ['isError' => ToolResult::from('configured', $reply)->isError];
    } elseif ($kind === 'content' || $kind === 'cap') {
        $content = $kind === 'content' ? $given['content'] : [['type' => 'text', 'text' => str_repeat($given['unit'], $given['repeat'])]];
        $config = ServerConfig::fromArray('configured', ['url' => 'https://owned.invalid', 'trust' => ['tools' => '*']]);
        $client = new McpCorpusClient($config, ['content' => $content, 'isError' => $given['isError'] ?? false]);
        $guard = new ResultGuard($given['maxBytes'] ?? $config->maxResultBytes, false);
        $remote = new RemoteTool($client, ToolDefinition::from('configured', $payload), new AllowAll, $guard, 'owned');
        try {
            $text = $remote->__invoke();
            $observed = $kind === 'content' ? ['text' => $text] : ['status' => 'returned', 'bytes' => strlen($text)];
        } catch (McpException $error) {
            $observed = ['status' => $error->code()];
        }
    } else {
        if (! in_array($kind, ['trust', 'mirror', 'diagnostic'], true)) {
            throw new RuntimeException('Unknown MCP corpus operation.');
        }
        $settings = ['url' => 'https://owned.invalid', 'cache_ttl' => 0];
        if ($given['trust'] !== 'missing') {
            $settings['trust'] = ['tools' => $given['trust']];
        }
        $config = ServerConfig::fromArray('configured', $settings);
        $client = new McpCorpusClient($config, ['tools' => $given['tools']]);
        $connection = new McpCorpusConnection($app, new Factory, new CacheManager($app), $config, []);
        $connection->fixtureClient = $client;
        $connection->withoutCache();
        try {
            // PHP namespaces public Tool names; normalize only that fixed prefix.
            $offered = array_map(fn ($tool): string => substr($tool->name(), strlen('mcp__configured__')), $connection->tools());
            if ($kind === 'trust') {
                $observed = ['dispatches' => $client->dispatches, 'offered' => $offered];
            } elseif ($kind === 'mirror') {
                $excluded = array_keys($client->excluded());
                sort($excluded);
                $observed = ['offered' => $offered, 'excluded' => $excluded];
            } else {
                $observed = ['offered' => $offered, 'warned' => $logger->warnings !== [], 'private' => ! str_contains(implode("\n", $logger->warnings), 'REMOTE_')];
            }
        } catch (McpException $error) {
            $observed = $kind === 'trust' ? ['dispatches' => $client->dispatches, 'error' => $error->code(), 'empty' => str_contains($error->getMessage(), 'empty')] : ['error' => $error->code()];
        }
    }
    $rows[] = ['id' => $entry['id'], 'observed' => $observed];
}
echo json_encode($rows, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), PHP_EOL;
