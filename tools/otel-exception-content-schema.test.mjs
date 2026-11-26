// opentelemetry-span-attributes: an exception's message is content.
//
// The failure rows (otel-0024..0027) hand each bridge an exception whose
// message carries `content_marker`. This file is the check IN THIS REPOSITORY
// that a recorded capture-off span carries none of it, in all three columns.
// The bridges assert the same thing in their own suites; without this, a leak
// regenerated into the corpus would pass every gate here.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const corpus = JSON.parse(readFileSync(join(root, 'suites', 'opentelemetry-span-attributes', 'cases.json'), 'utf8'));
const failures = corpus.cases.filter((entry) => entry.generation.failure !== undefined);
const FIXED = 'The generation failed.';
const EVENT_KEYS = new Set(['exception.type', 'exception.message', 'exception.stacktrace', 'exception.escaped']);
const WINDOW = 16;

/** Every string a recorded span holds, keys included, unescaped. */
function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]);
  }
  return [];
}

test('the piece check is not vacuous: it finds a cut message', () => {
  const message = failures[0].generation.failure.message;
  const cut = { attributes: { 'error.message': message.slice(0, 40) } };
  const values = strings(cut).join('\n');
  assert.ok(values.includes(message.slice(0, WINDOW)));
});

test('the failure rows exist, with a capture-on control', () => {
  assert.ok(failures.length >= 4, `expected the failure rows, found ${failures.length}`);
  assert.ok(failures.some((entry) => entry.capture_content), 'no capture-on control row');
  assert.ok(failures.some((entry) => !entry.capture_content), 'no capture-off row');
});

for (const entry of failures) {
  const { message, content_marker: marker } = entry.generation.failure;

  test(`${entry.id}: the marker is in what every bridge was handed`, () => {
    assert.ok(marker.length > 0 && message.includes(marker));
  });

  for (const language of ['php', 'ts', 'py']) {
    const span = entry.spans[language];

    test(`${entry.id}/${language}: ${entry.capture_content ? 'carries' : 'carries none of'} the exception content`, () => {
      assert.equal(span.status, 'error');
      assert.ok(Array.isArray(span.events) && span.events.length === 1, 'exactly one exception event');
      const exported = JSON.stringify(span);

      if (entry.capture_content) {
        assert.ok(exported.includes(marker), 'capture on: the marker is recorded');
        return;
      }

      assert.ok(!exported.includes(marker), 'capture off: marker exported');
      // Not only the marker: no 16-character piece of the message either, so a
      // message cut before the marker, or quoted in part, is still caught.
      const values = strings(span).join('\n');
      for (let start = 0; start + WINDOW <= message.length; start++) {
        const piece = message.slice(start, start + WINDOW);
        assert.ok(!values.includes(piece), `capture off: part of the message exported: ${JSON.stringify(piece)}`);
      }
      assert.ok(!exported.includes('carries the content marker'), 'capture off: stack trace carries the marker');
      assert.equal(span.status_description, FIXED);
      const attributes = span.events[0].attributes;
      assert.equal(typeof attributes['exception.type'], 'string');
      assert.deepEqual(Object.keys(attributes).filter((key) => !EVENT_KEYS.has(key)), []);
      assert.equal(attributes['exception.message'] ?? '', '');
      assert.equal(attributes['exception.stacktrace'] ?? 'type line only', 'type line only');
    });
  }
}
