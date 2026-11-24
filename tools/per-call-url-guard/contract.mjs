import { isDeepStrictEqual } from 'node:util';

// The refusal message is outside the contract; the code is the contract. An
// observation that carried the refused host would also show that a message
// echoed it, which the guard promises never to do -- so the contract refuses
// any observation field it does not know.
const OBSERVED_KEYS = ['dispatched', 'refusal'];

// `agrees` is derived evidence, not a substitute for comparing the observations.
export function perCallUrlGuardFailures(document, { allowIncomplete = false } = {}) {
  const failures = [];
  const seen = new Set();
  for (const row of document.cases ?? []) {
    if (seen.has(row.id)) failures.push(`duplicate per-call-url-guard case ${row.id}`);
    seen.add(row.id);
    for (const language of ['php', 'ts', 'py']) {
      const observed = row.result?.[language];
      if (observed === null || observed === undefined) continue;
      const extra = Object.keys(observed).filter(key => !OBSERVED_KEYS.includes(key));
      if (extra.length > 0) failures.push(`${row.id}: the ${language} observation carries ${extra.join(', ')}; record only dispatched and refusal`);
      if (observed.dispatched === true && observed.refusal !== null) {
        failures.push(`${row.id}: the ${language} observation was both dispatched and refused`);
      }
    }
    const complete = ['php', 'ts', 'py'].every(language => row.result?.[language] !== null && row.result?.[language] !== undefined);
    const agrees = complete && isDeepStrictEqual(row.result.php, row.result.ts) && isDeepStrictEqual(row.result.php, row.result.py);
    if (!complete && !allowIncomplete) failures.push(`${row.id}: all three native observations are required`);
    if (complete && row.agrees !== agrees) failures.push(`${row.id}: agreement does not match native observations`);
  }
  return failures;
}
