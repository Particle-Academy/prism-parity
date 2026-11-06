<?php

declare(strict_types=1);

namespace Prism\HumanPlus\Transport {
    function dns_get_record(string $host, int $type): array|false
    {
        $state = &$GLOBALS['policy_dns'];
        $index = $state['dnsCalls']++;
        $answer = $state['answers'][min($index, count($state['answers']) - 1)];
        if ($answer === false) return false;
        return array_map(fn ($address) => [str_contains($address, ':') ? 'ipv6' : 'ip' => $address], $answer);
    }
}

namespace {
    use GuzzleHttp\Client;
    use GuzzleHttp\Handler\MockHandler;
    use GuzzleHttp\HandlerStack;
    use GuzzleHttp\Middleware;
    use GuzzleHttp\Psr7\Response;
    use Prism\Browser\BrowserManager;
    use Prism\Browser\Contracts\BrowserEngine;
    use Prism\Browser\Data\BrowserAction;
    use Prism\Browser\Data\Observation;
    use Prism\Browser\Exceptions\BrowserRefused;
    use Prism\Browser\Security\BrowserPolicy;
    use Prism\Browser\Stores\InMemoryAttachmentStore;
    use Prism\HumanPlus\Data\Participant;
    use Prism\HumanPlus\Data\SurfaceAttachment;
    use Prism\HumanPlus\Data\SurfaceInvitation;
    use Prism\HumanPlus\Exceptions\HumanPlusException;
    use Prism\HumanPlus\Transport\RelayEndpoint;
    use Prism\HumanPlus\Transport\SsePostRelayTransport;

    $browserAutoload = getenv('PRISM_POLICY_BROWSER_AUTOLOAD');
    $humanAutoload = getenv('PRISM_POLICY_HUMAN_AUTOLOAD');
    if (!is_string($browserAutoload) || !is_file($browserAutoload) || !is_string($humanAutoload) || !is_file($humanAutoload)) throw new \RuntimeException('Verified Browser and Human+ autoloaders are required.');
    // The later human autoloader takes precedence over any old dependency copy.
    require $browserAutoload;
    require $humanAutoload;
    require __DIR__.'/native.php';

    final class PolicyEngine implements BrowserEngine {
        public int $calls = 0;
        public function open(string $attachmentId, ?string $checkpoint = null): void {}
        public function navigate(string $attachmentId, string $url): Observation { $this->calls++; return new Observation('policy-observation', $url, 'https://fixture', 'Fixture', [], []); }
        public function observe(string $attachmentId): Observation { throw new \LogicException('Unexpected observe'); }
        public function act(string $attachmentId, BrowserAction $action): Observation { throw new \LogicException('Unexpected action'); }
        public function checkpoint(string $attachmentId): ?string { return 'policy-checkpoint'; }
        public function close(string $attachmentId): void {}
    }

    function policyCapture(callable $action): array {
        try { $action(); return ['category' => 'success', 'private' => true]; }
        catch (HumanPlusException $error) {
            $name = basename(str_replace('\\', '/', $error::class));
            return ['category' => $name === 'HumanPlusException' ? 'HumanPlusError' : $name, 'private' => !str_contains($error->getMessage(), 'PRIVATE-B3')];
        }
    }

    $document = json_decode(stream_get_contents(STDIN), true, flags: JSON_THROW_ON_ERROR);
    $rows = [];
    $frame = ['jsonrpc' => '2.0', 'id' => 'probe', 'method' => 'tools/call', 'params' => (object) []];
    $rpc = "data: {\"jsonrpc\":\"2.0\",\"id\":\"probe\",\"result\":{\"fixture\":true}}\n\n";
    foreach ($document['cases'] as $entry) {
        $given = $entry['given']; $kind = $given['kind'];
        if ($kind === 'browser-serialization') {
            $keys = array_keys((new BrowserPolicy(['example.com']))->toArray()); sort($keys);
            $rows[] = ['id' => $entry['id'], 'observed' => ['keys' => $keys]];
            continue;
        }
        if ($kind === 'browser') {
            $engine = new PolicyEngine; $outcome = 'returned';
            try {
                $policy = $given['mode'] === 'constructor' ? new BrowserPolicy(allowedHosts: $given['allowedHosts'], allowPrivateAddresses: $given['value']) : new BrowserPolicy($given['allowedHosts']);
                if ($given['mode'] === 'property') $policy->allowPrivateAddresses = true;
                $manager = new BrowserManager($engine, new InMemoryAttachmentStore, $policy);
                $attachment = $manager->open('policy-owner');
                $manager->navigate('policy-owner', $attachment->id, $given['url']);
            } catch (BrowserRefused $error) { $outcome = 'refused'; }
            catch (\Error $error) {
                if (!str_contains($error->getMessage(), 'allowPrivateAddresses')) throw $error;
                $outcome = 'refused';
            }
            $rows[] = ['id' => $entry['id'], 'observed' => ['outcome' => $outcome, 'engineCalls' => $engine->calls]];
            continue;
        }
        if ($kind === 'relay-native') {
            $rows[] = ['id' => $entry['id'], 'observed' => policyNative($given)];
            continue;
        }
        $GLOBALS['policy_dns'] = ['answers' => $given['answers'] ?? [['8.8.8.8']], 'dnsCalls' => 0];
        $postStatus = $kind === 'relay-call' && $given['operation'] !== 'stream' ? $given['status'] : 200;
        $getStatus = $kind === 'relay-call' ? $given['status'] : 200;
        $history = [];
        $stack = HandlerStack::create(new MockHandler([new Response($postStatus, [], $given['body'] ?? ''), new Response($getStatus, [], $kind === 'relay-call' ? ($given['body'] ?? '') : $rpc)]));
        $stack->push(Middleware::history($history));
        $client = new Client(['handler' => $stack]);
        if ($kind === 'relay-classifier') {
            $endpoint = new RelayEndpoint($client, ['8.8.8.8'], egressProxy: 'http://proxy.fixture:3128');
            $observed = policyCapture(fn () => $endpoint->assertLive(new Response($given['status'], [], $given['body']), $given['operation'] === 'detach'));
        } else {
            if (!in_array($kind, ['relay-call', 'relay-dns', 'relay-literal'], true)) throw new \RuntimeException('Unknown satellite operation.');
            $observed = policyCapture(function () use ($given, $client, $frame): void {
                $invitation = new SurfaceInvitation($given['url'] ?? 'https://8.8.8.8', 'b3session', str_repeat('T', 32), 'board:fixture', 'Fixture', $given['allowInsecureLoopback'] ?? false);
                $attachment = new SurfaceAttachment('surface_x', 'session:one', $invitation, new Participant('agent:b3', 'Fixture', '#fff'), 'b3_client');
                $transport = new SsePostRelayTransport($client, $given['allowedHosts'] ?? ['8.8.8.8'], allowedRelayPorts: $given['allowedPorts'] ?? [443], egressProxy: array_key_exists('proxy', $given) && $given['proxy'] === null ? null : 'http://proxy.fixture:3128', allowUnverifiedEgress: $given['allowUnverified'] ?? false);
                if (($given['operation'] ?? '') === 'detach') $transport->detach($attachment);
                elseif (($given['operation'] ?? '') === 'notify') $transport->notify($attachment, $frame);
                else {
                    $reply = $transport->exchange($attachment, $frame);
                    if (($reply['result'] ?? null) !== ['fixture' => true]) throw new \RuntimeException('Correlated reply not observed.');
                }
            });
            $posts = count(array_filter($history, fn ($item) => $item['request']->getMethod() === 'POST'));
            $observed += ['posts' => $posts, 'streams' => count($history) - $posts, 'dnsCalls' => $GLOBALS['policy_dns']['dnsCalls']];
        }
        $rows[] = ['id' => $entry['id'], 'observed' => $observed];
    }
    echo json_encode($rows, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), PHP_EOL;
}
