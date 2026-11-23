import { isDeepStrictEqual } from 'node:util';

// Every fixture credential starts with one of these. An observation is a
// classification of what was sent, never the value that was sent.
const SECRET_MARKERS = ['sk-test-', 'org-test-', 'proj-test-'];

// `agrees` is derived evidence, not a substitute for comparing the observations.
export function credentialScopeFailures(document, { allowIncomplete = false } = {}) {
  const failures = [];
  const seen = new Set();
  for (const row of document.cases ?? []) {
    if (seen.has(row.id)) failures.push(`duplicate credential-scope case ${row.id}`);
    seen.add(row.id);
    const recorded = JSON.stringify(row.result ?? {});
    for (const marker of SECRET_MARKERS) {
      if (recorded.includes(marker)) failures.push(`${row.id}: an observation carries a credential value; record whether it was sent, never what`);
    }
    const complete = ['php', 'ts', 'py'].every(language => row.result?.[language] !== null && row.result?.[language] !== undefined);
    const agrees = complete && isDeepStrictEqual(row.result.php, row.result.ts) && isDeepStrictEqual(row.result.php, row.result.py);
    if (!complete && !allowIncomplete) failures.push(`${row.id}: all three native observations are required`);
    if (complete && row.agrees !== agrees) failures.push(`${row.id}: agreement does not match native observations`);
  }
  return failures;
}
