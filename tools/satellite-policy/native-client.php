<?php
declare(strict_types=1);

use GuzzleHttp\Client;
use Prism\HumanPlus\Data\Participant;
use Prism\HumanPlus\Data\SurfaceAttachment;
use Prism\HumanPlus\Data\SurfaceInvitation;
use Prism\HumanPlus\Exceptions\HumanPlusException;
use Prism\HumanPlus\Transport\SsePostRelayTransport;

$autoload = getenv('PRISM_POLICY_HUMAN_AUTOLOAD');
if (!is_string($autoload) || !is_file($autoload)) throw new RuntimeException('Verified Human+ autoloader required.');
require $autoload;
$origin = $argv[1];
if (parse_url($origin, PHP_URL_HOST) !== '127.0.0.1' || parse_url($origin, PHP_URL_SCHEME) !== 'http') throw new RuntimeException('Only the disposable loopback fixture is allowed.');
$attachment = new SurfaceAttachment('surface_x', 'session:one', new SurfaceInvitation($origin, 'b3session', str_repeat('T', 32), 'board:fixture', 'Fixture', true), new Participant('agent:b3', 'Fixture', '#fff'), 'b3_client');
$transport = new SsePostRelayTransport(new Client, ['127.0.0.1'], timeoutSeconds: 3, allowedRelayPorts: [(int) parse_url($origin, PHP_URL_PORT)], allowUnverifiedEgress: true, useNativeCurl: true);
try {
    $reply = $transport->exchange($attachment, ['jsonrpc' => '2.0', 'id' => 'probe', 'method' => 'tools/call', 'params' => (object) []]);
    if (($reply['result'] ?? null) !== ['fixture' => true]) throw new RuntimeException('Correlated reply not observed.');
    $outcome = ['category' => 'success', 'private' => true];
} catch (HumanPlusException $error) {
    $name = basename(str_replace('\\', '/', $error::class));
    $outcome = ['category' => $name === 'HumanPlusException' ? 'HumanPlusError' : $name, 'private' => !str_contains($error->getMessage(), 'PRIVATE-B3')];
}
echo json_encode($outcome, JSON_THROW_ON_ERROR);
