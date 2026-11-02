<?php

declare(strict_types=1);

namespace Prism\Conformance\Reference;

use Illuminate\Config\Repository;
use Illuminate\Container\Container;
use Illuminate\Events\Dispatcher;
use Illuminate\Foundation\Application;
use Illuminate\Http\Client\Factory;
use Illuminate\Support\Facades\Facade;
use Illuminate\Support\Carbon;
use Prism\Prism\Enums\ToolChoice;
use Prism\Prism\Prism;
use Prism\Prism\PrismManager;
use Prism\Prism\Providers\Anthropic\Handlers\Text as AnthropicTextHandler;
use Prism\Prism\Providers\Anthropic\Handlers\Structured as AnthropicStructuredHandler;
use Prism\Prism\Providers\Mistral\Handlers\Structured as MistralStructuredHandler;
use Prism\Prism\Providers\OpenAI\Concerns\BuildsRequestBody;
use Prism\Prism\Providers\OpenAI\Handlers\Text as OpenAITextHandler;
use Prism\Prism\Providers\OpenAI\Handlers\Structured as OpenAIStructuredHandler;
use Prism\Prism\Providers\OpenRouter\Handlers\Text as OpenRouterTextHandler;
use Prism\Prism\Schema\BooleanSchema;
use Prism\Prism\Schema\NumberSchema;
use Prism\Prism\Schema\ObjectSchema;
use Prism\Prism\Schema\StringSchema;
use Prism\Prism\Structured\PendingRequest as StructuredPendingRequest;
use Prism\Prism\Structured\Request as StructuredRequest;
use Prism\Prism\Text\PendingRequest;
use Prism\Prism\Text\Request;
use Prism\Prism\Tool;
use Prism\Prism\ValueObjects\Media\Audio;
use Prism\Prism\ValueObjects\Media\Document;
use Prism\Prism\ValueObjects\Media\Image;
use Prism\Prism\ValueObjects\Media\Media;
use Prism\Prism\ValueObjects\Media\Video;
use Prism\Prism\ValueObjects\Messages\AssistantMessage;
use Prism\Prism\ValueObjects\Messages\SystemMessage;
use Prism\Prism\ValueObjects\Messages\ToolResultMessage;
use Prism\Prism\ValueObjects\Messages\UserMessage;
use Prism\Prism\ValueObjects\Meta;
use Prism\Prism\ValueObjects\ProviderTool;
use Prism\Prism\ValueObjects\ToolCall;
use Prism\Prism\ValueObjects\ToolResult;
use Prism\Prism\ValueObjects\Usage;
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
                    'mistral' => [
                        'url' => 'https://conformance.invalid/v1',
                        'api_key' => 'conformance-only',
                    ],
                    'openrouter' => [
                        'url' => 'https://openrouter.ai/api/v1',
                        'api_key' => 'conformance-only',
                    ],
                    'openai' => [
                        // Fixed on purpose: the corpus pins the request BODY, and
                        // a body must not vary with whoever's environment ran it.
                        'url' => 'https://api.openai.com/v1',
                        'api_key' => 'sk-conformance',
                        'organization' => null,
                        'project' => null,
                        'api_format' => 'responses',
                    ],
                    'anthropic' => [
                        // Fixed for the same reason as OpenAI's above: a golden
                        // must not vary with whoever's environment generated it.
                        'url' => 'https://api.anthropic.com/v1',
                        'api_key' => 'sk-ant-conformance',
                        // Key is `version`, not `anthropic_version`: PrismManager reads
                        // $config['version'] unguarded, so a wrong name here is a
                        // null-argument TypeError rather than a default.
                        'version' => '2023-06-01',
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
    public static function pending(array $script): PendingRequest|StructuredPendingRequest
    {
        self::boot();

        $structured = ($script[0]['call'] ?? null) === 'structured';
        if ($structured && ($script[0]['args'] ?? []) !== []) {
            throw new RuntimeException('The structured factory takes no arguments.');
        }
        $pending = $structured ? (new Prism)->structured() : (new Prism)->text();
        if ($structured) {
            array_shift($script);
        }

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

        if ($request->provider() === 'anthropic') {
            return AnthropicTextHandler::buildHttpRequestPayload($request);
        }

        $builder = new class
        {
            use BuildsRequestBody;

            /** @return array<string, mixed> */
            public function build(Request $request): array
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

        $request = self::pending($script)->toRequest();

        // Dispatched on the provider the BUILDER names, rather than assuming
        // OpenAI. It assumed OpenAI until 2026-09-05, which is why no Anthropic
        // row could exist in the corpus and why G-48 -- reasoning tokens dropped
        // in all three languages -- was invisible to every cross-language check.
        //
        // The two handlers do NOT share a shape: OpenAI takes the client and
        // receives the request in handle(), Anthropic takes both up front and
        // handle() takes nothing. Each branch mirrors what that provider's own
        // Provider::text() does, so the corpus exercises the same construction
        // the library performs rather than an approximation of it.
        //
        // Deliberately NOT routed through PrismManager::resolve(), which would
        // be the generic call: it builds its own HTTP client, so the fake above
        // would have to become a global facade fake for every response-parse
        // suite at once. That is a change to the green OpenAI path in service of
        // a new one, which is the wrong trade.
        $parsed = match ($provider = self::providerFrom($script)) {
            'openai' => $request instanceof StructuredRequest
                ? (new OpenAIStructuredHandler($factory->baseUrl('https://conformance.invalid/v1')))->handle($request)->toArray()
                : (new OpenAITextHandler($factory->baseUrl('https://api.openai.com/v1')))->handle($request)->toArray(),
            'anthropic' => $request instanceof StructuredRequest
                ? (new AnthropicStructuredHandler($factory->baseUrl('https://conformance.invalid/v1'), $request))->handle()->toArray()
                : (new AnthropicTextHandler($factory->baseUrl('https://api.anthropic.com/v1'), $request))->handle()->toArray(),
            'openrouter' => (new OpenRouterTextHandler($factory->baseUrl('https://openrouter.ai/api/v1')))
                ->handle($request)
                ->toArray(),
            'mistral' => $request instanceof StructuredRequest
                ? self::parseMistralStructured($factory, $request)
                : throw new RuntimeException('No Mistral text response-parse handler is wired.'),
            default => throw new RuntimeException(
                sprintf('No response-parse handler wired for provider %s.', $provider)
            ),
        };

        if ($request instanceof StructuredRequest && $factory->recorded()->count() !== 1) {
            throw new RuntimeException('The structured fixture must make exactly one request.');
        }

        return $parsed;
    }

    /** @return array<string, mixed> */
    private static function parseMistralStructured(Factory $factory, StructuredRequest $request): array
    {
        // Keep rate-limit metadata on the documented fixture clock and restore
        // the caller's clock. Since 0.144.2, absent headers yield no bucket.
        $previous = Carbon::getTestNow();
        try {
            Carbon::setTestNow('2026-01-01T00:00:00+00:00');

            return (new MistralStructuredHandler($factory->baseUrl('https://conformance.invalid/v1')))
                ->handle($request)
                ->toArray();
        } finally {
            Carbon::setTestNow($previous);
        }
    }

    /** Execute the native stream and enforce properties before golden equality. */
    public static function parseStream(array $script, array $stream, array $properties): array
    {
        require_once __DIR__.'/StreamDriver.php';
        $trace = StreamDriver::parse($script, $stream);
        $violations = StreamDriver::violations($trace, $properties);
        if ($violations !== []) {
            throw new RuntimeException('Independent stream properties failed: '.implode(', ', $violations));
        }

        return $trace;
    }

    /**
     * The provider a case's builder selects, read from its `using` call.
     *
     * Read from the SCRIPT rather than from the built request, so the three
     * languages answer this the same way -- a request object exposes the
     * provider differently in each, and the script is one shared artifact.
     *
     * @param  array<int, array<string, mixed>>  $script
     */
    private static function providerFrom(array $script): string
    {
        foreach ($script as $step) {
            if (($step['call'] ?? null) === 'using') {
                return (string) ($step['args'][0] ?? '');
            }
        }

        throw new RuntimeException('The case builder never calls using(), so no provider is named.');
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

    /** Execute the public response builder and independently check billing facts. */
    private static function aggregateCacheWriteUsage(array $value): Usage
    {
        $builder = new \Prism\Prism\Text\ResponseBuilder;
        foreach ($value['steps'] as $subject) {
            $usage = self::hydrate($subject);
            self::assertCacheWriteConserved($usage);
            $builder->addStep(new \Prism\Prism\Text\Step(
                text: '{}', finishReason: \Prism\Prism\Enums\FinishReason::Stop,
                toolCalls: [], toolResults: [], providerToolCalls: [], usage: $usage,
                meta: new Meta('', ''), messages: [], systemPrompts: [],
            ));
        }
        $usage = $builder->toResponse()->usage;
        self::assertCacheWriteConserved($usage);
        foreach ($value['expected'] as $key => $expected) {
            if ($usage->toArray()[$key] !== $expected) {
                throw new RuntimeException('Independent cache-write aggregate failed: '.$key);
            }
        }

        return $usage;
    }

    private static function assertCacheWriteConserved(Usage $usage): void
    {
        if ($usage->cacheWrite5mInputTokens !== null && $usage->cacheWrite1hInputTokens !== null
            && $usage->cacheWriteInputTokens !== $usage->cacheWrite5mInputTokens + $usage->cacheWrite1hInputTokens) {
            throw new RuntimeException('Reported cache-write total disagrees with lifetime split.');
        }
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
            'UsageAggregate' => self::aggregateCacheWriteUsage($value),
            'StringSchema' => new StringSchema($value['name'], $value['description']),
            'ObjectSchema' => new ObjectSchema(
                $value['name'],
                $value['description'],
                array_map(self::hydrate(...), $value['properties'] ?? []),
                $value['requiredFields'] ?? [],
            ),
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
            'Usage' => new Usage(
                promptTokens: $value['promptTokens'],
                completionTokens: $value['completionTokens'],
                cacheWriteInputTokens: $value['cacheWriteInputTokens'] ?? null,
                cacheReadInputTokens: $value['cacheReadInputTokens'] ?? null,
                thoughtTokens: $value['thoughtTokens'] ?? null,
                cost: $value['cost'] ?? null,
                cacheWrite5mInputTokens: $value['cacheWrite5mInputTokens'] ?? null,
                cacheWrite1hInputTokens: $value['cacheWrite1hInputTokens'] ?? null,
            ),
            'Meta' => new Meta(
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
            'Image' => self::media(Image::class, $value),
            'Audio' => self::media(Audio::class, $value),
            'Video' => self::media(Video::class, $value),
            'Document' => self::media(Document::class, $value),
            default => throw new RuntimeException('Unknown construct '.$value['$']),
        };
    }

    /**
     * Build media the way a caller would, dispatching on the case's `from`.
     *
     * Never from a local or storage path: a golden generated that way would
     * record bytes read off the machine that generated it, and a case that
     * needs a file on every runner is not a case about serialisation. Raw
     * content is carried as a UTF-8 string, which is enough to prove the bytes
     * reach the stored form.
     *
     * A document's title rides where the REFERENCE puts it — the factory's
     * title argument. The ports set it with `titled()`; the corpus names the
     * value, not the call.
     *
     * @param  class-string<Media>  $class
     * @param  array<string, mixed>  $spec
     */
    private static function media(string $class, array $spec): Media
    {
        $mimeType = $spec['mimeType'] ?? null;
        $title = $spec['title'] ?? null;
        $document = $class === Document::class;

        if (! $document && $title !== null) {
            throw new RuntimeException('Only a Document has a title.');
        }

        $media = match ($spec['from']) {
            'url' => $document
                ? ($mimeType === null ? Document::fromUrl($spec['url'], $title) : throw new RuntimeException('The reference cannot give a url Document a mime type: Document::fromUrl() takes a title there.'))
                : $class::fromUrl($spec['url'], $mimeType),
            'base64' => $document ? Document::fromBase64($spec['base64'], $mimeType, $title) : $class::fromBase64($spec['base64'], $mimeType),
            'rawContent' => $document ? Document::fromRawContent($spec['rawContent'], $mimeType, $title) : $class::fromRawContent($spec['rawContent'], $mimeType),
            'fileId' => $document ? Document::fromFileId($spec['fileId'], $title) : $class::fromFileId($spec['fileId']),
            'text' => $document ? Document::fromText($spec['text'], $title) : throw new RuntimeException('Only a Document is built from text.'),
            'chunks' => $document ? Document::fromChunks($spec['chunks'], $title) : throw new RuntimeException('Only a Document is built from chunks.'),
            default => throw new RuntimeException('Unknown media source '.$spec['from']),
        };

        if (isset($spec['filename'])) {
            $media->as($spec['filename']);
        }

        return $media;
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
