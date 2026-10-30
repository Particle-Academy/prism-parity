import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { embeddingDecodingFailures, isEmbeddingComparison } from './embedding-decoding.mjs';

const source = JSON.parse(readFileSync(new URL('../suites/embedding-decoding/cases.json', import.meta.url), 'utf8'));

function recordedFixture() {
  // Oracle-test data only: never persisted as executed observations or goldens.
  const document = structuredClone(source);
  for (const row of document.cases) {
    for (const language of ['ts', 'py']) row.expected[language] = row.expected.php.exception
      ? { exception: 'PrismError', code: 'invalid_embedding' }
      : structuredClone(row.expected.php);
    row.agrees = true;
  }
  return document;
}

test('the independent oracle accepts complete native identity and behavior', () => {
  assert.deepEqual(embeddingDecodingFailures(recordedFixture()), []);
});

for (const language of ['php', 'ts', 'py']) {
  for (const id of source.cases.slice(2).map(row => row.id)) {
    for (const vector of [[], [1]]) {
      test(`${language}/${id}: a ${vector.length ? 'partial' : 'empty'} vector never counts as refusal`, () => {
        const document = recordedFixture();
        document.cases.find(row => row.id === id).expected[language] = { embedding: vector };
        assert(embeddingDecodingFailures(document).some(error => error.includes(`${id}: ${language} must refuse`)));
      });
    }
  }
  test(`${language}: a wrong control vector cannot agree by majority`, () => {
    const document = recordedFixture(); document.cases[1].expected[language].embedding[0] = 2;
    assert(embeddingDecodingFailures(document).some(error => error.includes('different numeric bytes')));
  });
  test(`${language}: an exception plus partial data is a refusal failure`, () => {
    const document = recordedFixture(); document.cases[2].expected[language].embedding = [];
    assert(embeddingDecodingFailures(document).length > 0);
  });
}

for (const language of ['ts', 'py']) {
  for (const mutate of [outcome => { outcome.exception = 'Prism\\Prism\\Exceptions\\PrismException'; }, outcome => { outcome.code = 'provider_response_error'; }, outcome => { delete outcome.code; }]) {
    test(`${language}: native identity and exact refusal code cannot be projected away`, () => {
      const document = recordedFixture(); mutate(document.cases[2].expected[language]);
      assert(embeddingDecodingFailures(document).length > 0);
    });
  }
}

test('all three identically returning empty vectors is still wrong', () => {
  const document = recordedFixture();
  for (const language of ['php', 'ts', 'py']) document.cases[2].expected[language] = { embedding: [] };
  assert.equal(embeddingDecodingFailures(document).length, 3);
});

test('unrecorded columns cannot claim agreement or full execution', () => {
  const document = recordedFixture(); document.cases[2].expected.ts = null;
  assert(embeddingDecodingFailures(document).length > 0);
  assert(embeddingDecodingFailures(document, { allowUnrecorded: true }).length > 0);
  document.cases[2].agrees = false;
  assert.deepEqual(embeddingDecodingFailures(document, { allowUnrecorded: true }), []);
});

test('deleting a hostile row cannot shrink the oracle', () => {
  const document = recordedFixture(); document.cases.pop();
  assert(embeddingDecodingFailures(document).length > 0);
});

test('one partial language cannot excuse a missing observation in a full language', () => {
  const document = recordedFixture(); document.cases[2].expected.ts = null; document.cases[2].agrees = false;
  assert(embeddingDecodingFailures(document, { allowUnrecorded: ['py'] }).length > 0);
});

for (const field of ['id', 'kind', 'reference', 'decision']) {
  test(`embedding comparison cannot be borrowed with a different ${field}`, () => {
    const manifest = JSON.parse(readFileSync(new URL('../suites/embedding-decoding/manifest.json', import.meta.url), 'utf8'));
    assert.equal(isEmbeddingComparison(manifest), true);
    if (field === 'decision') manifest.comparison.decision = 'another-decision';
    else manifest[field] = 'another-suite';
    assert.equal(isEmbeddingComparison(manifest), false);
  });
}
