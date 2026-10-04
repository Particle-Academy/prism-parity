import { createHash } from 'node:crypto';

// Corpus copies are byte-for-byte artifacts, not semantically equivalent JSON.
// Shared by the local synchronizer and the remote contents audit.
export function corpusDigest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function compareCorpusContent(expected, actual) {
  return { matches: Buffer.from(expected).equals(Buffer.from(actual)), expected: corpusDigest(expected), actual: corpusDigest(actual) };
}
