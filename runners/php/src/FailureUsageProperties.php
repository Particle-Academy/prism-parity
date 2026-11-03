<?php

declare(strict_types=1);

namespace Prism\Conformance\Reference;

use Prism\Conformance\Canonical;

/** Independent fixture predictions, checked before producing or comparing PHP goldens. */
final class FailureUsageProperties
{
    public static function violations(array $trace, array $properties): array
    {
        $failed = [];
        $check = static function (string $name, bool $ok) use (&$failed): void {
            if (! $ok) {
                $failed[] = $name;
            }
        };
        // Object order stays untouched in traces/goldens; property maps compare structurally.
        $normalize = static function ($value) use (&$normalize) {
            if (! is_array($value)) {
                return $value;
            }
            if (! array_is_list($value)) {
                ksort($value);
            }
            foreach ($value as $key => $child) {
                $value[$key] = $normalize($child);
            }

            return $value;
        };
        $same = static fn ($a, $b): bool => Canonical::encode($normalize($a)) === Canonical::encode($normalize($b));
        $check('contract', ($properties['contract'] ?? null) === 'failure-usage');
        $check('requests', ($trace['requests'] ?? null) === ($properties['requests'] ?? null));
        $payload = static function ($actual, $expected, string $label) use ($check, $same, $properties): void {
            $check($label.'.shape', is_array($actual));
            if (! is_array($actual)) {
                return;
            }
            $keys = array_keys($actual);
            $required = ['usage', 'status', 'scope', 'step_index', 'reported_fields', 'includes_completed_steps'];
            sort($keys);
            sort($required);
            $check($label.'.keys', $keys === $required);
            $check($label.'.scope', ($actual['status'] ?? null) === 'provisional' && ($actual['scope'] ?? null) === 'attempt' && ($actual['includes_completed_steps'] ?? null) === false && is_int($actual['step_index'] ?? null) && $actual['step_index'] >= 0);
            $usageKeys = ['prompt_tokens', 'completion_tokens', 'cache_write_input_tokens', 'cache_read_input_tokens', 'thought_tokens', 'cost', 'cache_write_5m_input_tokens', 'cache_write_1h_input_tokens'];
            $numbers = $actual['usage'] ?? [];
            $numberKeys = is_array($numbers) ? array_keys($numbers) : [];
            $sorted = $usageKeys;
            sort($sorted);
            sort($numberKeys);
            $check($label.'.usage-keys', $numberKeys === $sorted);
            foreach ($usageKeys as $field) {
                $value = $numbers[$field] ?? null;
                $check($label.'.numeric.'.$field, ($value === null && ! in_array($field, ['prompt_tokens', 'completion_tokens'], true)) || (($field === 'cost' ? is_int($value) || is_float($value) : is_int($value)) && is_finite((float) $value) && $value >= 0 && $value <= 9007199254740991));
            }
            $fields = $actual['reported_fields'] ?? [];
            $check($label.'.mask', is_array($fields) && array_is_list($fields) && $fields !== [] && count(array_unique($fields)) === count($fields) && array_diff($fields, $usageKeys) === []);
            foreach ($fields as $field) {
                $check($label.'.reported.'.$field, isset($numbers[$field]) && (is_int($numbers[$field]) || is_float($numbers[$field])));
            }
            $check($label.'.expected', $same($actual, $expected));
            foreach ($properties['privacy_sentinels'] ?? [] as $sentinel) {
                $check($label.'.privacy', ! str_contains(Canonical::encode($actual), $sentinel));
            }
        };
        $serialized = static function ($actual, $expected, string $label) use ($check, $payload): void {
            $check($label.'.object', is_array($actual));
            if (! is_array($actual)) {
                return;
            }
            $check($label.'.no-private-field', ! array_key_exists('failureUsage', $actual));
            $check($label.'.presence', array_key_exists('failure_usage', $actual) === ($expected !== null));
            if ($expected !== null && array_key_exists('failure_usage', $actual)) {
                $payload($actual['failure_usage'], $expected, $label.'.failure_usage');
            }
        };
        if (isset($properties['serialization'])) {
            foreach (['event', 'event_json', 'exception_json'] as $field) {
                $serialized($trace[$field] ?? null, $properties['serialization']['failure_usage'], $field);
            }
            $check('exception.privacy', ! str_contains(Canonical::encode($trace['exception_json'] ?? null), 'private-exception-sentinel'));

            return $failed;
        }
        $check('attempt-count', count($trace['attempts'] ?? []) === count($properties['attempts'] ?? []));
        foreach ($properties['attempts'] ?? [] as $index => $expected) {
            $actual = $trace['attempts'][$index] ?? [];
            $label = 'attempt.'.$index;
            $check($label.'.requests', ($actual['requests'] ?? null) === $expected['requests']);
            $terminal = $actual['terminal'] ?? [];
            $check($label.'.terminal', ($terminal['status'] ?? null) === $expected['terminal']);
            $difference = $properties['native_differences']['php'] ?? null;
            if ($difference !== null) {
                $check($label.'.registered-difference', $difference === ['gap' => 'G-214', 'exception' => 'TypeError', 'transport_identity' => false]);
                $check($label.'.native-difference', ($terminal['exception'] ?? null) === 'TypeError');
            }
            $check($label.'.identity', ($terminal['injected_exception_preserved'] ?? null) === ($difference['transport_identity'] ?? $expected['transport_identity']));
            $check($label.'.owned-tools', ($actual['owned_tool_calls'] ?? null) === $expected['owned_tool_calls']);
            $events = $actual['events'] ?? [];
            $check($label.'.failure-only-metadata', array_filter($events, fn ($event) => $event['type'] !== 'error' && array_key_exists('failure_usage', $event['payload'])) === []);
            $errors = array_values(array_filter($events, fn ($event) => $event['type'] === 'error'));
            $ends = array_values(array_filter($events, fn ($event) => $event['type'] === 'stream_end'));
            $check($label.'.error-count', count($errors) === $expected['error_events']);
            $check($label.'.end-count', count($ends) === $expected['stream_ends']);
            $channels = [];
            foreach ($errors as $offset => $event) {
                $present = array_key_exists('failure_usage', $event['payload']);
                $check($label.'.event-presence', $present === ($expected['failure_usage'] !== null));
                if ($present) {
                    $channels[] = 'event';
                    $payload($event['payload']['failure_usage'], $expected['failure_usage'], $label.'.error.'.$offset);
                }
                $serialized($event['serialized_error'] ?? null, $expected['failure_usage'], $label.'.event-json.'.$offset);
            }
            if (($terminal['failure_usage'] ?? null) !== null) {
                $channels[] = 'exception';
                $payload($terminal['failure_usage'], $expected['failure_usage'], $label.'.exception');
            }
            $channels = array_values(array_unique($channels));
            $expectedChannels = $expected['channels'];
            sort($channels);
            sort($expectedChannels);
            $check($label.'.channels', $channels === $expectedChannels);
            if (in_array('exception', $expectedChannels, true)) {
                $check($label.'.exception-json-present', is_array($terminal['serialized_error'] ?? null));
            }
            if (($terminal['serialized_error'] ?? null) !== null) {
                $serialized($terminal['serialized_error'], in_array('exception', $expectedChannels, true) ? $expected['failure_usage'] : null, $label.'.exception-json');
            }
            $stops = array_filter($ends, fn ($event) => in_array($event['payload']['finish_reason'] ?? null, ['Stop', 'stop'], true));
            if ($expected['terminal'] === 'raised' || $expected['error_events'] > 0) {
                $check($label.'.no-success-end', $stops === []);
            }
            if ($expected['normal_completion'] ?? false) {
                $check($label.'.successful-baseline', count($ends) === 1 && count($stops) === 1);
            }
            foreach ($expected['final_usage'] ?? [] as $field => $value) {
                $check($label.'.final-usage.'.$field, count($ends) === 1 && array_key_exists($field, $ends[0]['payload']['usage'] ?? []) && $ends[0]['payload']['usage'][$field] === $value);
            }
            if ($expected['owned_tool_calls'] === 0) {
                $check($label.'.no-completed-tools', array_filter($events, fn ($event) => in_array($event['type'], ['tool_call', 'tool_result'], true)) === []);
            }
        }
        if (isset($properties['telemetry'])) {
            $events = $trace['telemetry'] ?? [];
            $started = array_values(array_filter($events, fn ($event) => $event['class'] === 'Prism\\Prism\\Events\\Telemetry\\GenerationStarted'));
            $check('telemetry.capture-default', count($started) === 1 && $started[0]['request_is_null'] === true);
            $check('telemetry.no-completed', array_filter($events, fn ($event) => $event['class'] === 'Prism\\Prism\\Events\\Telemetry\\GenerationCompleted') === []);
            $terminal = array_values(array_filter($events, fn ($event) => in_array($event['class'], ['Prism\\Prism\\Events\\Telemetry\\GenerationErrored', 'Prism\\Prism\\Events\\Telemetry\\GenerationFailed'], true)));
            $check('telemetry.one-terminal', count($terminal) === 1 && $terminal[0]['class'] === $properties['telemetry']['terminal']);
            if (count($terminal) === 1) {
                $payload($terminal[0]['failure_usage'], $properties['attempts'][0]['failure_usage'], 'telemetry.failure_usage');
            }
        }

        return array_values(array_unique($failed));
    }
}
