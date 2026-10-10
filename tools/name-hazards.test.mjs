// Tests for criterion 8's reader.
//
// Every case here is a value or a sentence that appears in the real corpora.
// The negative cases matter more than the positive ones: each discriminator in
// name-hazards.mjs exists because reading the obvious way produced a false
// positive, and a false positive here is the dangerous direction — it reports a
// suite as fuzzing identifiers when it is only following a naming convention.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  claimsIdentifierHazard,
  hazardMarks,
  identifierValues,
  mentions,
  HAZARD_CLAIMS,
  HAZARD_SUBJECTS,
} from './name-hazards.mjs';

test('mentions preserves the captured behavior for every existing claim/subject pair', () => {
  // Recorded by executing the original matcher BEFORE changing its escaping.
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/mentions-before.json', import.meta.url), 'utf8'));
  assert.deepEqual(HAZARD_CLAIMS, baseline.claims);
  assert.deepEqual(HAZARD_SUBJECTS, baseline.subjects);
  const pairs = new Set();
  for (const sample of baseline.samples) {
    pairs.add(JSON.stringify([sample.claim, sample.subject]));
    assert.equal(mentions(sample.prose, sample.claim), sample.claimMentioned, JSON.stringify(sample));
    assert.equal(mentions(sample.prose, sample.subject), sample.subjectMentioned, JSON.stringify(sample));
  }
  assert.equal(baseline.samples.length, 864);
  assert.equal(pairs.size, HAZARD_CLAIMS.length * HAZARD_SUBJECTS.length);
});

test('mentions treats hostile regex terms literally, without throwing', () => {
  for (const [term, regexOnlyMatch] of [
    ['\\', 'no backslash'], ['a|b', 'a'], ['(x)', 'x'],
    ['a.*', 'alphabet'], ['[a-z]', 'q'], ['a\\b', 'a\bb'],
    ['x+y', 'xxxy'], ['x?y', 'y'], ['a{2}', 'aa'], ['^x$', 'x'],
    ['.', 'x'], ['-+.', '--+x'],
  ]) {
    assert.doesNotThrow(() => mentions(`Before ${term} after`, term), term);
    assert.equal(mentions(`Before ${term} after`, term), true, term);
    assert.equal(mentions(regexOnlyMatch, term), false, term);
    assert.equal(mentions(`prefix${term}`, term), false, `${term}: left boundary`);
    assert.equal(mentions(`${term}suffix`, term), false, `${term}: right boundary`);
  }
});

test('the G-36 family is flagged, with the mark naming the hazard', () => {
  // Exactly the eleven shapes human-plus-tool-admission carries.
  const expected = [
    ['terminal_confirm\n', ['edge-ws', 'control']],
    ['terminal_confirm ', ['edge-ws']],
    ['terminal_confirm\n\n', ['edge-ws', 'control']],
    ['terminal_confirm ', ['edge-ws', 'non-ascii']], // non-breaking space
    ['terminal_confirm　', ['edge-ws', 'non-ascii']], // ideographic space
    ['terminal_confirm​', ['control', 'non-ascii']], // zero-width space
    ['terminal_confirm﻿', ['edge-ws', 'control', 'non-ascii']], // BOM
    [' confirm', ['edge-ws']],
    ['сonfirm', ['non-ascii']], // Cyrillic es homoglyph
    ['terminal_ confirm', ['inner-ws']],
    ['surface\u0007write', ['control']],
  ];

  for (const [value, marks] of expected) {
    assert.deepEqual(hazardMarks(value), marks, `marks for ${JSON.stringify(value)}`);
  }
});

test('a clean identifier wears nothing', () => {
  for (const value of ['terminal_confirm', 'surface_write', 'App\\Models\\User', 'gpt-4o', 'w-1', 'done']) {
    assert.equal(hazardMarks(value), null, value);
  }
});

test('interior whitespace is NOT a hazard when every token is well formed', () => {
  // OpenTelemetry span names read `<operation> <model>` by convention. Counting
  // these inflated the corpus-wide total from 18 to 87 and would have let
  // opentelemetry-span-attributes look name-fuzzed on its naming convention
  // alone, when its three real rows are padded rate-limit bucket names.
  for (const value of [
    'chat gpt-4o',
    'text claude-sonnet-4-5',
    'embeddings text-embedding-3-small',
    'image_generation dall-e-3',
  ]) {
    assert.equal(hazardMarks(value), null, value);
  }
});

test('interior whitespace IS a hazard when it leaves a malformed token', () => {
  // `terminal_` ends on an underscore; no convention produces that.
  assert.deepEqual(hazardMarks('terminal_ confirm'), ['inner-ws']);
  assert.deepEqual(hazardMarks('surface_ delete'), ['inner-ws']);
});

test('ordinary prose, JSON and whitespace are not identifier-shaped', () => {
  for (const value of [
    'Read this',
    'Ship it',
    'hi there',
    'not a url',
    'created_at as a numeric STRING',
    '{"type":"object","title":"日本語"}',
    '    ',
    '',
  ]) {
    assert.equal(hazardMarks(value), null, JSON.stringify(value));
  }
});

test('PRECISION COMES FROM THE FIELD FILTER, not the value shape', () => {
  // hazardMarks is deliberately permissive, and on its own it flags all three
  // of these -- every one a real string from a real corpus. What keeps them out
  // is that `message`, `notes` and `description` are not identifier fields.
  //
  // This is the test to read before adding anything to IDENTIFIER_FIELDS: add a
  // prose-bearing field and these become false positives, which is the
  // dangerous direction -- a suite reported as fuzzing identifiers when it is
  // only carrying a sentence with an em dash in it.
  const prose = [
    'unknown field: search_mode',
    'Extended-length UNC — remote and un-normalised at once.',
    'Écrire — see https://example.test/a/b',
  ];

  for (const value of prose) {
    assert.notEqual(hazardMarks(value), null, `${JSON.stringify(value)} is shaped like an identifier`);
  }

  const cases = prose.map((value, index) => ({
    id: `c-${index}`,
    notes: value,
    description: value,
    body: { error: { message: value } },
  }));

  assert.deepEqual(identifierValues(cases), [], 'no prose field is collected');
});

test('a non-string is not an identifier', () => {
  for (const value of [null, undefined, 42, true, {}, []]) {
    assert.equal(hazardMarks(value), null, String(value));
  }
});

test('values are collected from identifier-named fields only', () => {
  const cases = [
    {
      id: 'c-1',
      title: 'a title with spaces',
      notes: 'prose that mentions a tool name',
      tool: { name: 'terminal_confirm ', description: 'Write to the surface.' },
      policy: { tools: ['surface_write', 'terminal_confirm'] },
      when: { worker: 'w-1 ', outcome: 'done' },
    },
  ];

  assert.deepEqual(identifierValues(cases).sort(), [
    'done',
    'surface_write',
    'terminal_confirm',
    'terminal_confirm ',
    'w-1 ',
  ]);
});

test('values are collected through arrays and nesting', () => {
  const cases = [{ generation: { rate_limits: [{ name: 'tokens ' }, { name: 'requests' }] } }];

  assert.deepEqual(identifierValues(cases), ['tokens ', 'requests']);
});

test('mentions matches on word boundaries, not substrings', () => {
  // `filename` carrying the substring `name` had workspace-path-guard -- a PATH
  // suite with no identifier field at all -- claiming a tool-name hazard.
  assert.equal(mentions('Illegal in a Windows filename', 'name'), false);
  assert.equal(mentions('a reserved verb followed by a SPACE', 'verb'), true);
  assert.equal(mentions('the tool name is padded', 'name'), true);
  assert.equal(mentions('zero-width space appended', 'zero-width'), true);
});

test('a claim is recognised from the manifest alone', () => {
  // opentelemetry-span-attributes claims only here, and carries three rows.
  const manifest = { pins: 'A rate-limit bucket name with a trailing space must still be read.' };

  assert.equal(claimsIdentifierHazard(manifest, [{ title: 'ordinary', notes: 'nothing to see' }]), true);
});

test('a claim is recognised from a single case', () => {
  const manifest = { pins: 'nothing relevant' };
  const cases = [{ title: 'a homoglyph of a reserved verb', notes: 'Cyrillic es.' }];

  assert.equal(claimsIdentifierHazard(manifest, cases), true);
});

test('hazard and subject must co-occur in the SAME case, never pooled', () => {
  // Pooling the prose of every case made a hazard word in one row and the word
  // `name` in another read as a claim. That is how workspace-path-guard
  // claimed one it never made.
  const manifest = { pins: 'nothing relevant' };
  const cases = [
    { notes: 'A control character. Illegal in a Windows filename, legal on Linux.' },
    { notes: 'The allowed host is named in the policy.' },
  ];

  assert.equal(claimsIdentifierHazard(manifest, cases), false);
});

test('a metaphorical "invisible" is not a claim about a character', () => {
  // provider-rate-limits: "the failure is invisible at the moment it happens"
  // sits next to the word `names`. Counting `invisible` turned three suites red
  // that never asserted an identifier hazard.
  const manifest = {
    pins: 'HTTP field names are case-insensitive, and the failure is invisible at the moment it happens.',
  };

  assert.equal(claimsIdentifierHazard(manifest, []), false);
});

test('a suite that claims nothing is not held to criterion 8', () => {
  const manifest = { pins: 'Vector components are compared as bytes.', scope: 'Float64 only.' };

  assert.equal(claimsIdentifierHazard(manifest, [{ title: 'exact binary fractions', notes: 'The control.' }]), false);
});
