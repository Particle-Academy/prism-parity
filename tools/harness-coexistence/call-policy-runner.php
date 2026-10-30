<?php

declare(strict_types=1);

require $argv[1];

use Illuminate\Contracts\Auth\Access\Gate;
use Prism\Harness\Exceptions\UnsafeAuthorizationConfiguration;
use Prism\Harness\Sessions\Session;
use Prism\Harness\Tools\ToolAuthorizer;
use Prism\Prism\Tool;

$gate = Mockery::mock(Gate::class);
$gate->shouldReceive('has')->andReturnUsing(fn (string $ability): bool => $ability === ToolAuthorizer::CALL_ABILITY);
$callbacks = 0;
$result = ['refused' => false, 'callbacks' => 0, 'offered' => 0, 'allows_call' => null, 'code' => null];
try {
    $authorizer = new ToolAuthorizer($gate, false);
    $session = Mockery::mock(Session::class);
    if (method_exists(Session::class, 'agent')) {
        $session->shouldReceive('agent')->andReturnNull();
    }
    $tool = (new Tool)->as('guarded_fixture')->for('Synthetic guarded capability')->using(function () use (&$callbacks): string {
        $callbacks++;

        return 'executed';
    });
    $offered = $authorizer->allowed($session, ['guarded_fixture' => $tool]);
    $result['offered'] = count($offered);
    $result['allows_call'] = $authorizer->allowsCall($session, $tool, []);
    if ($offered !== []) {
        $offered[0]->handle();
    }
} catch (UnsafeAuthorizationConfiguration $failure) {
    $result['refused'] = true;
    $result['code'] = 'unsafe_authorization_configuration';
    $result['native_error'] = ['class' => $failure::class, 'message' => $failure->getMessage()];
}
$result['callbacks'] = $callbacks;
Mockery::close();
echo json_encode($result, JSON_THROW_ON_ERROR), PHP_EOL;
