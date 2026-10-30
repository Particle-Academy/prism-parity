import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { embeddingDecodingFailures } from './embedding-decoding.mjs';

const root = path.resolve(import.meta.dirname, '..');
assert.equal(process.argv.length, 3, 'Pass the actual published-artifact acceptance receipt.');
const file = process.argv[2], bytes = fs.readFileSync(file);
const digest = createHash('sha256').update(bytes).digest('hex');
assert.equal(digest, 'a8dc61a655ab3865a046cd068864bd03a115a2b3d47b93dad4573be7b810d792', 'Use the reviewed actual-artifact acceptance receipt.');
const receipt = JSON.parse(bytes);
assert.equal(receipt.status, 'PASS');
assert.deepEqual(receipt.versions, { ts: '0.5.1', py: '0.5.1', php: '0.140.0' });
assert.equal(receipt.networkCalls, 0); assert.equal(receipt.artifactsUnchanged, true);
assert.equal(receipt.artifacts.ts.gitHead, 'ca9e9f57566c23b864aeb7c24221f09f9c613f9f');
assert.equal(receipt.reviewedRuntime.typescriptFiles, 464); assert.equal(receipt.reviewedRuntime.pythonFiles, 109);
const target = path.join(root, 'suites/embedding-decoding');
const document = JSON.parse(fs.readFileSync(path.join(target, 'cases.json')));
assert.equal(document.cases.length, 9); assert.equal(receipt.reference.length, 9); assert.equal(receipt.rows.length, 36);

function native(row, language) {
  if (row.threw) {
    assert(row.prismError); assert(!Object.hasOwn(row, 'value'), 'Refusal cannot return any vector or partial result.');
    if (language !== 'php') { assert.equal(row.errorCode, 'invalid_embedding'); assert.equal(row.noRawBody, true); }
    return { exception: row.errorType, ...(language === 'php' ? {} : { code: row.errorCode }) };
  }
  return row.value;
}

for (const row of document.cases) {
  const reference = receipt.reference.filter(r => r.id === row.id); assert.equal(reference.length, 1);
  assert.deepEqual(native(reference[0], 'php'), row.expected.php, 'Never rewrite an executed PHP golden.');
  for (const language of ['ts', 'py']) {
    const observed = receipt.rows.filter(r => r.id === row.id && r.language === language);
    assert.equal(observed.length, 2); assert.deepEqual(observed.map(r => r.provider).sort(), ['mistral', 'openai']);
    const outcomes = observed.map(r => native(r, language)); assert.deepEqual(outcomes[0], outcomes[1]);
    row.expected[language] = outcomes[0];
  }
  row.agrees = true;
  const identityNote = ' error identity is language-native; PHP carries no stable code (known reference gap); refusal behaviour is identical.';
  if (row.expected.php.exception && !row.notes.endsWith(identityNote)) row.notes += identityNote;
}
document.corpus_version = '0.1.13';
document.generated_by = 'PHP0.140.0 EmbeddingDecoder executed for all9 reference rows; actual primary-registry TS0.5.1/Python0.5.1 OpenAI and Mistral handlers executed all36 native rows. tools/record-embedding-decoding.mjs records actual identities under decision0023; recording.json binds the artifact evidence.';
assert.deepEqual(embeddingDecodingFailures(document), []);
const manifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json')));
manifest.comparison = { mode: 'embedding-behavior', decision: 'docs/decisions/0023-embedding-refusal-identity.md' };
manifest.findings = 'G65 published0.5.0 baseline returned empty vectors for valid base64 and all seven hostile inputs in both ports. Actual0.5.1 archives now pass all9 rows through both OpenAI/Mistral handlers. PHP0.140.0 reference was executed independently. Error identity is language-native; PHP carries no stable code (known reference gap); refusal behaviour is identical. Independent controls reject any empty/partial vector on every hostile row, even if all three languages return it. No live provider or broader provider capability is claimed.';
manifest.implementations.ts = { status: 'full', runner: 'prism-ts:tests/embedding-decoding.test.ts' };
manifest.implementations.py = { status: 'full', runner: 'prism-py:tests/test_embedding_decoding.py' };
const recording = { decision: '0023', acceptanceSha256: digest, versions: receipt.versions, archives: { ts: { sha256: receipt.artifacts.ts.sha256, integrity: receipt.artifacts.ts.integrity, release: receipt.artifacts.ts.gitHead }, py: { sha256: receipt.artifacts.py.sha256, release: 'ebfa4044f624c4aff457a7ba0d27a6abe2451f44' }, php: { release: receipt.artifacts.php.release, verifiedRuntimeFiles: receipt.artifacts.php.verifiedRuntimeFiles } }, executed: receipt.groups, runtimeFiles: receipt.reviewedRuntime, networkCalls: 0 };
for (const [name, value] of [['cases.json', document], ['manifest.json', manifest], ['recording.json', recording]]) fs.writeFileSync(path.join(target, name), JSON.stringify(value, null, 2) + '\n');
console.log('Embedding recording passed: 9 PHP rows; 36 native port rows; actual identities; no PHP golden changes.');
