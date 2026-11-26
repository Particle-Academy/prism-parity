// opentelemetry-span-attributes: an exception's message is content.
//
// The failure rows (otel-0024..0027) hand each bridge an exception whose
// message carries `content_marker`. This file is the check IN THIS REPOSITORY
// that a recorded capture-off span carries none of it, in all three columns,
// and that the schema keeps the failure fields where they belong. The bridges
// assert the same property in their own suites; without this, a leak
// regenerated into the corpus would pass every gate here.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compile } from '@particle-academy/fancy-schema';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const casesPath = join(root, 'suites', 'opentelemetry-span-attributes', 'cases.json');
const load = () => JSON.parse(readFileSync(casesPath, 'utf8'));
const corpus = load();
const failures = corpus.cases.filter((entry) => entry.generation.failure !== undefined);
const check = compile(JSON.parse(readFileSync(join(root, 'schema', 'cases.schema.json'), 'utf8')));

const FIXED = 'The generation failed.';
const EVENT_KEYS = new Set(['exception.type', 'exception.message', 'exception.stacktrace', 'exception.escaped']);
const WINDOW = 16;

// The only attributes a capture-off failure span may carry: what every span
// of a generation carries, with nothing derived from the failure. A new key is
// a new channel, and has to be added here on purpose.
const FAILURE_ATTRIBUTES = new Set([
  'gen_ai.operation.name',
  'gen_ai.request.model',
  'gen_ai.system',
  'llm.model_name',
  'llm.provider',
  'llm.system',
  'openinference.span.kind',
]);

/** Every string a recorded span holds, keys included, unescaped. */
function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]);
  }
  return [];
}

/**
 * What a capture-off failure span gives away, as a list of problems.
 *
 * One function, called by the row tests AND by the self-tests below, so a
 * check that stopped working would fail the self-tests too.
 */
function leaks(span, message, marker) {
  const problems = [];
  const exported = JSON.stringify(span);
  if (exported.includes(marker)) problems.push('marker exported');
  if (exported.includes('carries the content marker')) problems.push('stack trace carries the marker');

  const values = strings(span).join('\n');
  for (let start = 0; start + WINDOW <= message.length; start++) {
    const piece = message.slice(start, start + WINDOW);
    if (values.includes(piece)) {
      problems.push(`part of the message exported: ${JSON.stringify(piece)}`);
      break;
    }
  }

  const extra = Object.keys(span.attributes ?? {}).filter((key) => !FAILURE_ATTRIBUTES.has(key));
  if (extra.length > 0) problems.push(`unexpected span attributes: ${extra.join(', ')}`);
  if (span.status !== 'error') problems.push(`status ${span.status}`);
  if (span.status_description !== FIXED) problems.push(`description ${JSON.stringify(span.status_description)}`);
  if (!Array.isArray(span.events) || span.events.length !== 1) {
    problems.push('not exactly one exception event');
    return problems;
  }

  const attributes = span.events[0].attributes ?? {};
  if (typeof attributes['exception.type'] !== 'string') problems.push('no exception.type');
  const unknown = Object.keys(attributes).filter((key) => !EVENT_KEYS.has(key));
  if (unknown.length > 0) problems.push(`unexpected event attributes: ${unknown.join(', ')}`);
  if ((attributes['exception.message'] ?? '') !== '') problems.push('an exception message');
  if ((attributes['exception.stacktrace'] ?? 'type line only') !== 'type line only') problems.push('a stack trace');
  return problems;
}

test('the failure rows exist, with a capture-on control', () => {
  assert.ok(failures.length >= 4, `expected the failure rows, found ${failures.length}`);
  assert.ok(failures.some((entry) => entry.capture_content), 'no capture-on control row');
  assert.ok(failures.some((entry) => !entry.capture_content), 'no capture-off row');
  for (const entry of failures) {
    assert.ok(entry.generation.failure.message.length >= WINDOW * 2, `${entry.id}: message too short to search`);
  }
});

test('the leak check is not vacuous: it finds each kind of leak in a real span', () => {
  const entry = failures.find((row) => !row.capture_content);
  const { message, content_marker: marker } = entry.generation.failure;

  for (const language of ['php', 'ts', 'py']) {
    assert.deepEqual(leaks(entry.spans[language], message, marker), [], `${language} baseline`);
  }

  const injected = [
    ['a prefix cut before the marker', (span) => { span.events[0].attributes['exception.message'] = message.slice(0, 30); }],
    ['a piece from the middle in a new attribute', (span) => { span.attributes['error.detail'] = message.slice(20, 40); }],
    ['a new attribute holding nothing of the message', (span) => { span.attributes['error.type'] = 'X'; }],
    ['the message as the description', (span) => { span.status_description = message; }],
    ['a stack trace label', (span) => { span.events[0].attributes['exception.stacktrace'] = 'present'; }],
    ['a second event', (span) => { span.events.push(span.events[0]); }],
  ];
  for (const [name, inject] of injected) {
    const span = structuredClone(entry.spans.py);
    inject(span);
    assert.notDeepEqual(leaks(span, message, marker), [], `not caught: ${name}`);
  }
});

for (const entry of failures) {
  const { message, content_marker: marker } = entry.generation.failure;

  test(`${entry.id}: the marker is in what every bridge was handed`, () => {
    assert.ok(marker.length > 0 && message.includes(marker));
  });

  for (const language of ['php', 'ts', 'py']) {
    const span = entry.spans[language];

    test(`${entry.id}/${language}: ${entry.capture_content ? 'carries' : 'carries none of'} the exception content`, () => {
      if (entry.capture_content) {
        assert.equal(span.status, 'error');
        assert.ok(JSON.stringify(span).includes(marker), 'capture on: the marker is recorded');
        assert.ok(String(span.status_description).includes(marker), 'capture on: the description is the message');
        return;
      }
      assert.deepEqual(leaks(span, message, marker), []);
    });
  }
}

// The schema keeps the failure fields where they belong.
function failureRow(document) {
  return document.cases.find((row) => row.id === failures[0].id);
}
function successRow(document) {
  return document.cases.find((row) => row.generation.failure === undefined);
}

test('the corpus is accepted by the real cases schema', () => {
  assert.equal(check(load()).valid, true);
});

for (const [name, mutate] of [
  ['a failure row without events', (d) => { delete failureRow(d).spans.ts.events; }],
  ['a failure row without a status description', (d) => { delete failureRow(d).spans.php.status_description; }],
  ['a failure row with no exception event', (d) => { failureRow(d).spans.py.events = []; }],
  ['events on a row that did not fail', (d) => { successRow(d).spans.ts.events = failureRow(d).spans.ts.events; }],
  ['a status description on a row that did not fail', (d) => { successRow(d).spans.php.status_description = FIXED; }],
  ['a raw stack trace', (d) => { failureRow(d).spans.php.events[0].attributes['exception.stacktrace'] = 'RuntimeException: x'; }],
  ['an unknown event attribute', (d) => { failureRow(d).spans.php.events[0].attributes['exception.detail'] = 'x'; }],
  ['an event without a type', (d) => { delete failureRow(d).spans.ts.events[0].attributes['exception.type']; }],
  ['an event that is not an exception', (d) => { failureRow(d).spans.ts.events[0].name = 'log'; }],
  ['an empty content marker', (d) => { failureRow(d).generation.failure.content_marker = ''; }],
  ['an unknown failure field', (d) => { failureRow(d).generation.failure.stack = 'x'; }],
]) {
  test(`the schema rejects ${name}`, () => {
    const document = load();
    mutate(document);
    assert.equal(check(document).valid, false);
  });
}
