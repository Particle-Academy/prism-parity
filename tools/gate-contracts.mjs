// Verdicts come from each tool, not from the wrapper. Positive work counts
// prevent an empty discovery from looking like a successful invocation.
export const gates = {
  guards: { verdict: /^Corpus guards passed \([1-9]\d* files scanned\)\.$/m },
  parity: { verdict: /^Parity check passed: [1-9]\d* languages, [1-9]\d* mirrors enforced\.$/m },
  copies: { verdict: /^Corpus copies are current\.$/m },
  rubric: { verdict: /^Trust rubric passed: [1-9]\d* security corpus\/corpora, [1-9]\d* adversarial row\(s\)\.$/m },
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
