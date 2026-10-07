// Verdicts come from each tool, not from the wrapper. Positive work counts
// prevent an empty discovery from looking like a successful invocation.
export const gates = {
  guards: { verdict: /^Corpus guards passed \([1-9]\d* files scanned\)\.$/m },
  parity: { verdict: /^Parity check passed: [1-9]\d* languages, [1-9]\d* mirrors enforced\.$/m },
  copies: { verdict: /^Corpus copies are current\.$/m },
  // The hazard count is a POSITIVE WORK COUNT. Criterion 8 is claim-gated:
  // strip the padded identifiers AND every claim to them and it goes quiet
  // rather than red, so the rubric alone can exit zero having checked nothing.
  // Requiring at least one here means the corpora cannot ALL stop fuzzing
  // identifiers and still report success. Measured, not assumed: scrubbing every
  // security corpus leaves the rubric green at 0 and fails this gate. It is a
  // corpus-wide floor and not a per-suite one — scrubbing only the three suites
  // that claim a hazard leaves three rows elsewhere and passes.
  rubric: { verdict: /^Trust rubric passed: [1-9]\d* security corpus\/corpora, [1-9]\d* adversarial row\(s\), [1-9]\d* identifier value\(s\) wearing a hazard\.$/m },
  nodeTests: { verdict: /^# pass [1-9]\d*$/m },
  phpTests: { verdict: /^[1-9]\d* passed, 0 failed$/m },
  pythonTests: { verdict: /(?:^|\s)[1-9]\d* passed(?:,| in |\s*={2,})/m },
  mypy: { verdict: /^Success: no issues found in [1-9]\d* source files?$/m },
  ruff: { verdict: /^All checks passed!$/m },
  goldens: { verdict: /^All goldens current\.$/m },
  reference: { verdict: /^Reference runner completed: [1-9]\d* executed, \d+ skipped\.$/m },
  crossCheck: { verdict: /^Cross-check passed: [1-9]\d* cases passed in every language .+; \d+ cases have skips and are not counted as verified /m },
  factcheck: { verdict: /^PASS \(\d+ warning\(s\)\)$/m },
  allowlist: { verdict: /\b[1-9]\d* direct dependencies, all approved\b/m },
  remote: { verdict: /^Remote alignment passed\.$/m },
};
