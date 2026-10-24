// A skipped verdict is visible coverage debt, never verified agreement.
import { violations } from '../tools/streaming/ts.mjs';

export function coverage(reports) {
  const byLanguage = [...reports].map(([language, documents]) => [
    language,
    new Map(documents.flatMap((document) => document.results.map((result) => [
      `${document.suite}/${result.id}`, result,
    ]))),
  ]);
  const keys = new Set(byLanguage.flatMap(([, rows]) => [...rows.keys()]));
  const verified = [];
  const skips = [];
  const traceDivergences = [];

  for (const key of [...keys].sort()) {
    if (byLanguage.every(([, rows]) => rows.get(key)?.status === 'pass')) verified.push(key);

    for (const [language, rows] of byLanguage) {
      const result = rows.get(key);
      if (result?.status === 'pass' && result.trace_comparison?.status === 'known-divergence') {
        traceDivergences.push({ key, language, gap: result.trace_comparison.gap });
      }
      if (result?.status === 'skip') {
        skips.push({ key, language, reason: result.reason ?? 'No reason reported.' });
      }
    }
  }

  return { verified, skips, skippedCases: new Set(skips.map(({ key }) => key)).size, traceDivergences };
}

/** Recheck properties from the actual trace; a pass claim is not evidence. */
export function streamTraceFailures(reports, manifests, fixtures) {
  const failures = [];
  for (const [language, documents] of reports) {
    for (const document of documents) {
      if (manifests.get(document.suite)?.kind !== 'stream-parse') continue;
      for (const result of document.results) {
        if (result.status === 'skip') continue;
        const key = `${document.suite}/${result.id} [${language}]`;
        const testCase = fixtures.get(document.suite)?.cases.find(row => row.id === result.id);
        const comparison = result.trace_comparison;
        if (!testCase || !comparison || comparison.expected !== testCase.expect.result_json || typeof comparison.actual !== 'string') {
          failures.push(`${key}: missing or wrong native trace evidence`);
          continue;
        }
        const match = comparison.actual === comparison.expected;
        if (comparison.status !== (match ? 'match' : 'known-divergence') || comparison.gap !== (match ? null : 'G-125') || (!match && language === 'php')) {
          failures.push(`${key}: unregistered or false trace equality claim`);
        }
        try {
          // PHP's public completion event has message_id, not a text field.
          const failed = violations(JSON.parse(comparison.actual), testCase.properties, { completionTextRequired: language !== 'php' });
          if (failed.length > 0) failures.push(`${key}: native trace violates ${failed.join(', ')}`);
        } catch {
          failures.push(`${key}: invalid native trace`);
        }
      }
    }
  }
  return failures;
}
