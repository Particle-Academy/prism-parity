import { Buffer } from 'node:buffer';

const languages = ['php', 'ts', 'py'];
const ids = Array.from({ length: 9 }, (_, index) => `emb-${String(index + 1).padStart(4, '0')}`);
const hostile = new Set(ids.slice(2));
const phpException = 'Prism\\Prism\\Exceptions\\PrismException';
const keys = value => Object.keys(value).sort().join(',');

export function isEmbeddingComparison(manifest) {
  return manifest.id === 'embedding-decoding' && manifest.kind === 'security-corpus' && manifest.reference === 'php' && manifest.comparison?.mode === 'embedding-behavior' && manifest.comparison?.decision === 'docs/decisions/0023-embedding-refusal-identity.md';
}

function numericBytes(values) {
  const bytes = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => bytes.writeDoubleLE(value, index * 8));
  return bytes;
}

/** Independent G65 oracle: an empty vector can NEVER satisfy a hostile row. */
export function embeddingDecodingFailures(document, { allowUnrecorded = false } = {}) {
  const failures = [];
  const unrecorded = new Set(Array.isArray(allowUnrecorded) ? allowUnrecorded : allowUnrecorded ? ['ts', 'py'] : []);
  if (document.suite !== 'embedding-decoding' || !Array.isArray(document.cases)) {
    return ['Expected the embedding-decoding document.'];
  }
  if (document.cases.map(row => row.id).join(',') !== ids.join(',')) {
    failures.push('All nine canonical embedding rows must remain present and ordered.');
  }
  for (const row of document.cases) {
    const prefix = row.id + ': ';
    if (row.skip !== undefined) failures.push(prefix + 'embedding rows cannot be skipped.');
    let complete = true;
    const vectors = [];
    for (const language of languages) {
      const outcome = row.expected?.[language];
      if (outcome === null && unrecorded.has(language) && language !== 'php') {
        complete = false;
        continue;
      }
      if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
        failures.push(prefix + language + ' lacks a native observation.');
        continue;
      }
      if (hostile.has(row.id)) {
        const requiredKeys = language === 'php' ? 'exception' : 'code,exception';
        if (keys(outcome) !== requiredKeys || outcome.exception !== (language === 'php' ? phpException : 'PrismError') || (language !== 'php' && outcome.code !== 'invalid_embedding')) {
          failures.push(prefix + language + ' must refuse with its actual native exception, with no vector or partial data.');
        }
      } else if (keys(outcome) !== 'embedding' || !Array.isArray(outcome.embedding) || outcome.embedding.length !== 4 || !outcome.embedding.every(value => typeof value === 'number' && Number.isFinite(value))) {
        failures.push(prefix + language + ' must return the complete finite control vector.');
      } else {
        vectors.push({ language, bytes: numericBytes(outcome.embedding) });
      }
    }
    if (!hostile.has(row.id)) {
      // Independent fixed-byte controls reject an identically wrong decoder.
      const control = numericBytes([1, -2.5, 0.5, 0]);
      for (const vector of vectors) if (!vector.bytes.equals(control)) failures.push(prefix + vector.language + ' decoded different numeric bytes.');
    }
    if (row.agrees !== complete) failures.push(prefix + 'agreement must reflect complete native observations under decision0023.');
  }
  return failures;
}
