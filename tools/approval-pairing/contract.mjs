import { isDeepStrictEqual } from 'node:util';

// What the cases schema cannot say about harness-approval-pairing: a decision
// is an [index, approved] pair (the schema validator has no tuple keyword),
// the index names an approval the first step issued, no approval is decided
// twice in one round, `ran` is sorted, and `agrees` matches the recorded
// outcomes rather than being asserted beside them.
export function approvalPairingFailures(document) {
  const failures = [];
  const seen = new Set();
  for (const row of document.cases ?? []) {
    if (seen.has(row.id)) failures.push(`duplicate approval-pairing case ${row.id}`);
    seen.add(row.id);
    const issued = row.expected?.approvals;
    (row.rounds ?? []).forEach((round, r) => {
      const decided = new Set();
      for (const decision of round) {
        const [index, approved] = Array.isArray(decision) ? decision : [];
        if (!Array.isArray(decision) || decision.length !== 2 || !Number.isInteger(index) || typeof approved !== 'boolean') {
          failures.push(`${row.id}: round ${r} decision ${JSON.stringify(decision)} is not an [index, approved] pair`);
          continue;
        }
        if (index < 0 || !Number.isInteger(issued) || index >= issued) {
          failures.push(`${row.id}: round ${r} decides approval ${index}, and the first step issued ${issued}`);
        }
        if (decided.has(index)) failures.push(`${row.id}: round ${r} decides approval ${index} twice`);
        decided.add(index);
      }
    });
    for (const [label, outcome] of [['expected', row.expected], ...Object.entries(row.result ?? {})]) {
      const ran = outcome?.ran;
      if (Array.isArray(ran) && !isDeepStrictEqual(ran, [...ran].sort((a, b) => a - b))) failures.push(`${row.id}: ${label}.ran is not sorted`);
    }
    const complete = ['php', 'ts', 'py'].every((language) => row.result?.[language] !== undefined && row.result?.[language] !== null);
    if (!complete) failures.push(`${row.id}: all three native outcomes are required`);
    else {
      const agrees = isDeepStrictEqual(row.result.php, row.result.ts) && isDeepStrictEqual(row.result.php, row.result.py);
      if (row.agrees !== agrees) failures.push(`${row.id}: agreement does not match the recorded outcomes`);
    }
  }
  return failures;
}
