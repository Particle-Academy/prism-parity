import { isDeepStrictEqual } from 'node:util';

export function mcpBehaviorFailures(document) {
  const failures = [];
  const seen = new Set();
  if (!document.cases?.length) failures.push('no MCP behavior cases');
  for (const row of document.cases ?? []) {
    if (seen.has(row.id)) failures.push(`${row.id}: duplicate MCP behavior identity`);
    seen.add(row.id);
    const complete = ['php', 'ts', 'py'].every(language => row.result?.[language] !== null && row.result?.[language] !== undefined);
    if (!complete) failures.push(`${row.id}: all native observations are required`);
    const agrees = complete && isDeepStrictEqual(row.result.php, row.result.ts) && isDeepStrictEqual(row.result.php, row.result.py);
    if (agrees !== row.agrees) failures.push(`${row.id}: agreement differs from native observations`);
    for (const language of ['php', 'ts', 'py']) {
      if (!isDeepStrictEqual(row.result?.[language], row.prediction)) failures.push(`${row.id}/${language}: independent prediction failed`);
    }
  }
  return failures;
}
