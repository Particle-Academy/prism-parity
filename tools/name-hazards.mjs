// Read the BYTES of identifier-shaped values in a corpus.
//
// This exists because of the gap between trust-rubric criterion 2 and
// criterion 8. Criterion 2 is satisfied by notes PROSE, and that is deliberate:
// a boolean on a case would be set to true by whoever wanted the suite green.
// But prose is a claim ABOUT a row, not a reading OF one. Delete every padded
// tool name from human-plus-tool-admission, leave the word "homoglyph" in the
// notes, and criterion 2 stays green. G-36 was a trailing SPACE, so the thing
// that has to survive a refactor is the bytes.
//
// It lives in its own module so the discriminators below can be tested. Each
// one suppresses a false positive found against the real corpora, and each was
// confirmed load-bearing by mutation: removing it turns a green run red on a
// suite that is not actually at fault, or inflates the reported count.

// Fields whose value is a machine identifier rather than prose. An INCLUDE
// list, not an exclude list: a field nobody listed is simply not counted, so
// the error runs toward under-reporting coverage rather than inventing it.
// Reading every string instead flagged `Read this`, `Ship it` and an em dash
// in a note. The vacuity check in the rubric is what keeps a stale list loud
// rather than silent.
//
// PRECISION LIVES HERE, not in hazardMarks. That function is deliberately
// permissive and on its own flags prose — `unknown field: search_mode` and a
// sentence carrying an em dash both come back marked. Adding a prose-bearing
// field to this set therefore buys false positives, which is the dangerous
// direction: a suite would report as fuzzing identifiers while carrying nothing
// but a sentence. name-hazards.test.mjs pins that boundary.
export const IDENTIFIER_FIELDS = new Set([
  'name', 'names', 'tool', 'tools', 'tool_name', 'kind', 'type',
  'worker', 'outcome', 'method', 'verb', 'handle', 'actor_type', 'operation',
]);

const IDENTIFIER = /^[A-Za-z0-9_.:\\/-]+$/;

// A well-formed token starts and ends alphanumeric. `gpt-4o` does, and so does
// `image_generation`; `terminal_` does not, and no naming convention produces
// it. This is the whole of the interior-whitespace discriminator.
const WELL_FORMED = /^[A-Za-z0-9](?:[A-Za-z0-9_.:\\/-]*[A-Za-z0-9])?$/;

const CONTROL = /[\p{Cf}\p{Cc}]/u;
const NON_ASCII = /[^\x00-\x7F]/u;
const STRIPPABLE = /[\p{Cf}\p{Cc}\s]|[^\x00-\x7F]/gu;

// The hazard vocabulary, and the subject it has to be about. Both are matched
// on WORD BOUNDARIES: `filename` is not a claim about a `name`, and that one
// substring alone had workspace-path-guard — a PATH suite with no identifier
// field in it at all — claiming a tool-name hazard.
export const HAZARD_CLAIMS = [
  'homoglyph', 'zero-width', 'zero width', 'byte order mark',
  'non-breaking space', 'ideographic space', 'control character',
  'trailing space', 'trailing newline', 'leading space',
  'interior whitespace', 'codepoint',
];

// 'invisible' is deliberately ABSENT. provider-rate-limits uses it about a
// failure mode — "the failure is invisible at the moment it happens" — not
// about a character. Including it turns THREE suites red that never asserted a
// name hazard. Criterion 2 still counts the word; this must not.
export const HAZARD_SUBJECTS = [
  'name', 'names', 'tool', 'tools', 'verb', 'verbs', 'identifier', 'kind', 'type',
];

export function mentions(prose, term) {
  return new RegExp(`(?<![A-Za-z0-9_])${term.replace(/[-+.]/g, '\\$&')}(?![A-Za-z0-9_])`, 'i').test(prose);
}

// The marks an identifier-shaped value wears, or null when the value is not an
// identifier at all (prose, a JSON blob, a URL) or wears nothing.
export function hazardMarks(value) {
  if (typeof value !== 'string') return null;

  const core = value.replace(STRIPPABLE, '');
  if (core.length === 0 || !IDENTIFIER.test(core)) return null;

  const marks = [];
  if (value !== value.trim()) marks.push('edge-ws');
  if (CONTROL.test(value)) marks.push('control');
  if (NON_ASCII.test(value)) marks.push('non-ascii');

  // Interior whitespace is a hazard only when a token it separates is not
  // itself well formed. OpenTelemetry span names legitimately read
  // `chat gpt-4o`; counting those reported 87 hazards across the corpora where
  // 18 are real, and would have let a suite look name-fuzzed on the strength
  // of a naming convention.
  if (
    /\S\s+\S/.test(value) &&
    value.trim().split(/\s+/).some((token) => !WELL_FORMED.test(token.replace(STRIPPABLE, '')))
  ) {
    marks.push('inner-ws');
  }

  return marks.length > 0 ? marks : null;
}

// Every string in `cases` that sits at an identifier-named field, by path leaf.
export function identifierValues(cases) {
  const values = [];

  const walk = (node, path) => {
    if (typeof node === 'string') {
      if (IDENTIFIER_FIELDS.has(path.split('.').pop().replace(/\[\]$/, ''))) values.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, `${path}[]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      Object.entries(node).forEach(([key, item]) => walk(item, path ? `${path}.${key}` : key));
    }
  };

  cases.forEach((testCase) => walk(testCase, ''));

  return values;
}

// Whether the suite CLAIMS an identifier-shaped hazard anywhere.
//
// Read from the MANIFEST as well as the cases, and the manifest is the stronger
// half: deleting the padded rows AND their notes still leaves `pins` asserting
// the coverage, and rewriting `pins` to stop asserting it is a scope change
// visible in the diff. It is also the only place opentelemetry-span-attributes
// claims one, and it carries three.
export function claimsIdentifierHazard(manifest, cases) {
  const claims = (prose) =>
    HAZARD_CLAIMS.some((term) => mentions(prose, term)) &&
    HAZARD_SUBJECTS.some((term) => mentions(prose, term));

  const manifestProse = [manifest.pins, manifest.scope, manifest.findings, manifest.conclusion]
    .filter((value) => typeof value === 'string')
    .join('\n');

  if (claims(manifestProse)) return true;

  // Per CASE, never pooled across them. A hazard word in one row and the word
  // "name" in another is not a claim; pooling produced exactly that false
  // positive on workspace-path-guard.
  return cases.some((testCase) => claims(`${testCase.title ?? ''} ${testCase.notes ?? ''}`));
}
