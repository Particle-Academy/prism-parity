import { isDeepStrictEqual } from 'node:util';

export const census = Object.freeze({ browser: 44, 'browser-serialization': 1, 'relay-classifier': 84, 'relay-call': 24, 'relay-dns': 43, 'relay-literal': 30, 'relay-native': 6 });

export function satellitePolicyFailures(document) {
  const failures = [];
  const seen = new Set();
  for (const [kind, count] of Object.entries(census)) {
    if (document.cases?.filter(row => row.given?.kind === kind).length !== count) failures.push(kind+': incomplete native coverage');
  }
  for (const row of document.cases ?? []) {
    if (seen.has(row.id)) failures.push(row.id+': duplicate satellite identity');
    seen.add(row.id);
    const complete = ['php', 'ts', 'py'].every(language => row.result?.[language] !== null && row.result?.[language] !== undefined);
    if (!complete) failures.push(row.id+': all native observations are required');
    const agrees = complete && isDeepStrictEqual(row.result.php, row.result.ts) && isDeepStrictEqual(row.result.php, row.result.py);
    if (agrees !== row.agrees) failures.push(row.id+': agreement differs from native observations');
    for (const language of ['php', 'ts', 'py']) {
      if (!isDeepStrictEqual(row.result?.[language], row.prediction)) failures.push(row.id+'/'+language+': independent prediction failed');
    }
    if (row.given?.kind === 'browser' && row.prediction?.outcome === 'refused' && row.prediction.engineCalls !== 0) failures.push(row.id+': refusal must precede engine calls');
    if (row.prediction?.private === false) failures.push(row.id+': remote diagnostics must remain private');
  }
  return failures;
}
