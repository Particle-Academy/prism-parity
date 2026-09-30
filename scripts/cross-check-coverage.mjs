// A skipped verdict is visible coverage debt, never verified agreement.
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

  for (const key of [...keys].sort()) {
    if (byLanguage.every(([, rows]) => rows.get(key)?.status === 'pass')) verified.push(key);

    for (const [language, rows] of byLanguage) {
      const result = rows.get(key);
      if (result?.status === 'skip') {
        skips.push({ key, language, reason: result.reason ?? 'No reason reported.' });
      }
    }
  }

  return { verified, skips, skippedCases: new Set(skips.map(({ key }) => key)).size };
}
