import { isDeepStrictEqual } from 'node:util';

// What the cases schema cannot say about harness-approval-pairing: a decision
// is an [index, approved] pair (the schema validator has no tuple keyword),
// the index names an approval the first step issued, no approval is decided
// twice in one round, `ran` is sorted, and `agrees` matches the recorded
// outcomes rather than being asserted beside them.
const SELF_DECIDING = new Set(['altered_copy_after_approval', 'denial_after_run']);

export function approvalPairingFailures(document) {
  const failures = [];
  const seen = new Set();
  for (const row of document.cases ?? []) {
    if (seen.has(row.id)) failures.push(`duplicate approval-pairing case ${row.id}`);
    seen.add(row.id);
    const issued = row.expected?.approvals;
    // A row decides its approvals in rounds, except the supersede kinds whose own
    // setup records the decisions and then only resumes: `altered_copy_after_approval`
    // (0.4.0) and `denial_after_run` (0.5.0). The schema allows an empty `rounds`
    // list; only these may use it.
    if (!Array.isArray(row.rounds) || (row.rounds.length === 0 && !SELF_DECIDING.has(row.supersede))) {
      failures.push(`${row.id}: a row decides its approvals in at least one round (only ${[...SELF_DECIDING].join(' and ')} have none)`);
    }
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
    // SEGMENT OWNERSHIP rows (0.2.0): a later round or an approved index
    // names an approval the later step issued (one per `echo` call).
    if (row.later) {
      const laterIssued = (row.later.calls ?? []).filter((call) => call.name === 'echo').length;
      (row.later.rounds ?? []).forEach((round, r) => {
        const decided = new Set();
        for (const decision of round) {
          const [index, approved] = Array.isArray(decision) ? decision : [];
          if (!Array.isArray(decision) || decision.length !== 2 || !Number.isInteger(index) || typeof approved !== 'boolean') {
            failures.push(`${row.id}: later round ${r} decision ${JSON.stringify(decision)} is not an [index, approved] pair`);
            continue;
          }
          if (index < 0 || index >= laterIssued) failures.push(`${row.id}: later round ${r} decides approval ${index}, and the later step issued ${laterIssued}`);
          if (decided.has(index)) failures.push(`${row.id}: later round ${r} decides approval ${index} twice`);
          decided.add(index);
        }
      });
      for (const index of row.later.result?.approved ?? []) {
        if (!Number.isInteger(index) || index < 0 || index >= laterIssued) failures.push(`${row.id}: later.result approves ${index}, and the later step issued ${laterIssued}`);
      }
    }
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
