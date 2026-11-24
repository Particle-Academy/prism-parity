import { isDeepStrictEqual } from 'node:util';

// What the servers saw, and nothing else. The error each language raises is
// outside the contract: PHP and TypeScript throw redirect_refused, Python
// returns the redirect as the answer and reports provider_response_error. The
// property this corpus pins is what reached another origin, and every
// observation field is read off the loopback servers, not off the SDK.
const OBSERVED_KEYS = ['endpoint_requests', 'reached_elsewhere', 'credential_elsewhere'];

// `agrees` is derived evidence, not a substitute for comparing the observations.
export function crossOriginRedirectFailures(document, { allowIncomplete = false } = {}) {
  const failures = [];
  const seen = new Set();
  for (const row of document.cases ?? []) {
    if (seen.has(row.id)) failures.push(`duplicate cross-origin-redirect case ${row.id}`);
    seen.add(row.id);
    for (const language of ['php', 'ts', 'py']) {
      const observed = row.result?.[language];
      if (observed === null || observed === undefined) continue;
      const keys = Object.keys(observed).sort();
      if (!isDeepStrictEqual(keys, [...OBSERVED_KEYS].sort())) {
        failures.push(`${row.id}: the ${language} observation must carry exactly ${OBSERVED_KEYS.join(', ')}`);
      }
      if (observed.credential_elsewhere === true && observed.reached_elsewhere !== true) {
        failures.push(`${row.id}: the ${language} observation leaked a credential without reaching another origin`);
      }
      if (observed.endpoint_requests < 1) {
        failures.push(`${row.id}: the ${language} call never reached its configured endpoint, so the row asked nothing`);
      }
    }
    const complete = ['php', 'ts', 'py'].every(language => row.result?.[language] !== null && row.result?.[language] !== undefined);
    const agrees = complete && isDeepStrictEqual(row.result.php, row.result.ts) && isDeepStrictEqual(row.result.php, row.result.py);
    if (!complete && !allowIncomplete) failures.push(`${row.id}: all three native observations are required`);
    if (complete && row.agrees !== agrees) failures.push(`${row.id}: agreement does not match native observations`);
  }
  return failures;
}
