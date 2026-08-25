<?php

declare(strict_types=1);

namespace Prism\Conformance\Reference;

use Illuminate\Config\Repository;
use Illuminate\Container\Container;
use Illuminate\Events\Dispatcher;
use Illuminate\Foundation\Application;
use Illuminate\Http\Client\Factory;
use Illuminate\Support\Facades\Facade;
use Prism\Prism\Enums\ToolChoice;
use Prism\Prism\Prism;
use Prism\Prism\PrismManager;
use Prism\Prism\Providers\OpenAI\Handlers\Text as OpenAITextHandler;
use Prism\Prism\Schema\BooleanSchema;
use Prism\Prism\Schema\NumberSchema;
use Prism\Prism\Schema\StringSchema;
use Prism\Prism\Tool;
use Prism\Prism\ValueObjects\Messages\AssistantMessage;
use Prism\Prism\ValueObjects\Messages\SystemMessage;
use Prism\Prism\ValueObjects\Messages\ToolResultMessage;
use Prism\Prism\ValueObjects\Messages\UserMessage;
use Prism\Prism\ValueObjects\ProviderTool;
use Prism\Prism\ValueObjects\ToolCall;
use Prism\Prism\ValueObjects\ToolResult;
use RuntimeException;

/**
 * Drives the REFERENCE implementation from a corpus builder script.
 *
 * The builder script names the canonical (PHP) method spelling. Every language's
 * runner maps those names to its own idiom — with_prompt in Python, withPrompt
 * in TypeScript. The call SEQUENCE is the contract; the spelling is not.
 */
final class Driver
{
    private static bool $booted = false;

    public static function boot(): void
    {
        if (self::$booted) {
            return;
        }

        $app = new Application(sys_get_temp_dir());
        Container::setInstance($app);
        $app->instance('app', $app);
        $app->instance('config', new Repository([
            'prism' => [
                'providers' => [
                    'openai' => [
                        // Fixed on purpose: the corpus pins the request BODY, and
                        // a body must not vary with whoever's environment ran it.
                        'url' => 'https://api.openai.com/v1',
                        'api_key' => 'sk-conformance',
                        'organization' => null,
                        'project' => null,
                        'api_format' => 'responses',
                    ],
                ],
            ],
        ]));
        $app->singleton('events', fn ($a): Dispatcher => new Dispatcher($a));
        $app->singleton(PrismManager::class, fn ($a): PrismManager => new PrismManager($a));
        Facade::setFacadeApplication($app);

        self::$booted = true;
    }

    /**
     * @param  array<int, array<string, mixed>>  $script
     */
    public static function pending(array $script): \Prism\Prism\Text\PendingRequest
    {
        self::boot();

        $pending = (new Prism)->text();

        foreach ($script as $step) {
            $call = $step['call'];
            $args = array_map(self::hydrate(...), $step['args'] ?? []);

            if (! method_exists($pending, $call)) {
                throw new RuntimeException(sprintf('The reference builder has no method %s.', $call));
            }

            $pending = $pending->{$call}(...$args);
        }

        return $pending;
    }

    /**
     * @param  array<int, array<string, mixed>>  $script
     * @return array<string, mixed>
     */
    public static function requestBody(array $script): array
    {
        $request = self::pending($script)->toRequest();

        $builder = new class
        {
            use \Prism\Prism\Providers\OpenAI\Concerns\BuildsRequestBody;

            /** @return array<string, mixed> */
            public function build(\Prism\Prism\Text\Request $request): array
            {
                return $this->buildRequestBody($request);
            }
        };

        return $builder->build($request);
    }

    /**
     * @param  array<int, array<string, mixed>>  $script
     * @param  array<string, mixed>  $response
     * @return array<string, mixed>
     */
    public static function parseResponse(array $script, array $response): array
    {
        self::boot();

        $factory = new Factory(Container::getInstance()->make('events'));
        $factory->fake(['*' => $factory->response($response, 200)]);

        $handler = new OpenAITextHandler($factory->baseUrl('https://api.openai.com/v1'));

        return $handler->handle(self::pending($script)->toRequest())->toArray();
    }

    /**
     * @param  array<string, mixed>  $subject
     * @return array<string, mixed>
     */
    public static function serialize(array $subject): array
    {
        self::boot();

        $object = self::hydrate($subject);

        if (! method_exists($object, 'toArray')) {
            throw new RuntimeException(sprintf('%s is not serializable in the reference.', $object::class));
        }

        return $object->toArray();
    }

    /**
     * Does THIS language's JSON parser consider two raw strings equal?
     *
     * Answered from the raw text, because there is nothing else to answer from:
     * a decoded input authored by running PHP could not have carried the
     * distinction in the first place.
     */
    public static function containerIdentity(string $left, string $right): bool
    {
        return json_decode($left, true) === json_decode($right, true);
    }

    /**
     * Map a reference failure onto a corpus error CODE.
     *
     * This adapter should not exist. particle-academy/prism identifies its
     * failures by an English sentence and nothing else — PrismException carries
     * no code, so the only way to tell "prompt and messages were both set" from
     * "the provider returned an error" is to match on prose. Every consumer that
     * needs to branch on a failure is therefore string-matching, and every
     * wording improvement is a silent breaking change for them.
     *
     * Recorded as finding F-1. Until the reference grows codes, this map is
     * where the translation lives, and it is deliberately in the runner rather
     * than in the loader so it is obvious that it is a shim.
     *
     * @param  array<int, array<string, mixed>>  $script
     */
    public static function errorCode(array $script): string
    {
        try {
            self::requestBody($script);
        } catch (\Throwable $e) {
            $message = $e->getMessage();

            return match (true) {
                str_contains($message, 'You can only use `prompt` or `messages`') => 'prompt_and_messages',
                str_contains($message, 'are not valid JSON') => 'malformed_tool_call_arguments',
                str_contains($message, 'Could not map message type') => 'unknown_message_type',
                str_contains($message, 'is not supported by') => 'unsupported_provider_action',
                default => 'unmapped:'.$message,
            };
        }

        return 'no_error';
    }

    private static function hydrate(mixed $value): mixed
    {
        if (is_array($value) && array_is_list($value)) {
            return array_map(self::hydrate(...), $value);
        }

        if (! is_array($value) || ! isset($value['$'])) {
            return $value;
        }

        return match ($value['$']) {
            'UserMessage' => new UserMessage(
                content: $value['content'],
                additionalContent: array_map(self::hydrate(...), $value['additionalContent'] ?? []),
                additionalAttributes: $value['additionalAttributes'] ?? [],
            ),
            'AssistantMessage' => new AssistantMessage(
                content: $value['content'],
                toolCalls: array_map(self::hydrate(...), $value['toolCalls'] ?? []),
                additionalContent: $value['additionalContent'] ?? [],
            ),
            'SystemMessage' => new SystemMessage($value['content']),
            'ToolResultMessage' => new ToolResultMessage(
                toolResults: array_map(self::hydrate(...), $value['toolResults'] ?? []),
            ),
            'ToolCall' => new ToolCall(
                id: $value['id'],
                name: $value['name'],
                arguments: $value['arguments'],
                resultId: $value['resultId'] ?? null,
                reasoningId: $value['reasoningId'] ?? null,
                reasoningSummary: $value['reasoningSummary'] ?? null,
            ),
            'ToolResult' => new ToolResult(
                toolCallId: $value['toolCallId'],
                toolName: $value['toolName'],
                args: $value['args'] ?? [],
                result: $value['result'],
                toolCallResultId: $value['toolCallResultId'] ?? null,
            ),
            'Usage' => new \Prism\Prism\ValueObjects\Usage(
                promptTokens: $value['promptTokens'],
                completionTokens: $value['completionTokens'],
                cacheWriteInputTokens: $value['cacheWriteInputTokens'] ?? null,
                cacheReadInputTokens: $value['cacheReadInputTokens'] ?? null,
                thoughtTokens: $value['thoughtTokens'] ?? null,
                cost: $value['cost'] ?? null,
            ),
            'Meta' => new \Prism\Prism\ValueObjects\Meta(
                id: $value['id'],
                model: $value['model'],
                rateLimits: $value['rateLimits'] ?? [],
                serviceTier: $value['serviceTier'] ?? null,
            ),
            'ProviderTool' => new ProviderTool(
                type: $value['type'],
                name: $value['name'] ?? null,
                options: $value['options'] ?? [],
            ),
            'ToolChoice' => match ($value['case']) {
                'Auto' => ToolChoice::Auto,
                'Any' => ToolChoice::Any,
                'None' => ToolChoice::None,
                default => throw new RuntimeException('Unknown ToolChoice case '.$value['case']),
            },
            'Tool' => self::tool($value),
            default => throw new RuntimeException('Unknown construct '.$value['$']),
        };
    }

    /**
     * @param  array<string, mixed>  $spec
     */
    private static function tool(array $spec): Tool
    {
        $tool = (new Tool)->as($spec['as'])->for($spec['for']);

        foreach ($spec['parameters'] ?? [] as $parameter) {
            $schema = match ($parameter['type']) {
                'string' => new StringSchema($parameter['name'], $parameter['description']),
                'number' => new NumberSchema($parameter['name'], $parameter['description']),
                'boolean' => new BooleanSchema($parameter['name'], $parameter['description']),
                default => throw new RuntimeException('Unknown parameter type '.$parameter['type']),
            };

            $tool = $tool->withParameter($schema, $parameter['required'] ?? true);
        }

        if (isset($spec['providerOptions'])) {
            $tool = $tool->withProviderOptions($spec['providerOptions']);
        }

        // A tool needs a handler to be a tool, but the corpus never invokes one:
        // these suites pin mapping, not execution.
        return $tool->using(fn (): string => 'conformance');
    }
}
