import { isDeepStrictEqual } from 'node:util';

// `agrees` is derived evidence, not a substitute for comparing the observations.
export function providerConfigurationFailures(document) {
  const failures = [];
  const seen = new Set();
  for (const row of document.cases ?? []) {
    if (seen.has(row.id)) failures.push(`duplicate configuration case ${row.id}`);
    seen.add(row.id);
    const complete = ['php', 'ts', 'py'].every(language => row.result?.[language] !== null && row.result?.[language] !== undefined);
    const agrees = complete && isDeepStrictEqual(row.result.php, row.result.ts) && isDeepStrictEqual(row.result.php, row.result.py);
    if (!complete) failures.push(`${row.id}: all three native observations are required`);
    if (row.agrees !== agrees) failures.push(`${row.id}: agreement does not match native observations`);
  }
  return failures;
}
