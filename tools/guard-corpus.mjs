#!/usr/bin/env node
// Invariants that hold across the whole corpus, checked mechanically.
//
// Each of these exists because the alternative — a sentence in a README saying
// the invariant holds — is a claim, and a claim is not a test. If you write that
// something is covered, make something fail when it is not.
//
//   node tools/guard-corpus.mjs

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];
const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git', 'dist', '__pycache__', '.venv', 'build', '.parity']);

function fail(check, message) {
  failures.push(`${check}: ${message}`);
}

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    if (SKIP_DIRS.has(entry)) return [];
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const allFiles = walk(root);

// ---------------------------------------------------------------------------
// 1. No shipped golden may carry an integer outside JavaScript's safe range.
//
// Read AS TEXT. Parsing the files first would destroy the evidence using the
// very defect being looked for: this checker runs on Node, and JSON.parse would
// round 9007199254740993 to ...992 and then report it safe. Worse, comparing the
// rounded value against the original literal returns TRUE, so the language
// cannot see its own error even when asked directly.
//
// Generalise: when checking for a defect, do not use a tool subject to that
// defect.
// ---------------------------------------------------------------------------
{
  const caseFiles = allFiles.filter((file) => file.endsWith(`${'cases'}.json`) && file.includes(`${'suites'}`));

  if (caseFiles.length === 0) {
    fail('safe-integers', 'found no case files to scan — a discovery check that passes over an empty set is worse than no check');
  }

  const MAX_SAFE = 9007199254740991n;

  // Only UNQUOTED numeric literals are a hazard. A long digit run inside a JSON
  // string is text and survives any parser intact — which is exactly why
  // suites/json-container-identity carries its 2^53 boundary values as raw
  // strings, and why it needs no exemption here.
  //
  // The scanner tracks string boundaries itself, honouring backslash escapes.
  // A regex cannot: the raw strings contain escaped quotes, and every
  // character-window heuristic reads those wrongly.
  for (const file of caseFiles) {
    const text = readFileSync(file, 'utf8');
    const reported = new Set();

    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char !== '-' && (char < '0' || char > '9')) continue;

      let end = char === '-' ? i + 1 : i;
      while (end < text.length && text[end] >= '0' && text[end] <= '9') end++;

      const literal = text.slice(i, end);
      // A fraction or exponent makes it a float, which is a different hazard and
      // not this one.
      const isInteger = end > i + (char === '-' ? 1 : 0) && !'.eE'.includes(text[end] ?? '');
      i = end - 1;

      if (!isInteger) continue;

      const value = BigInt(literal);

      if ((value > MAX_SAFE || value < -MAX_SAFE) && !reported.has(literal)) {
        reported.add(literal);
        fail(
          'safe-integers',
          `${relative(root, file)} carries the unquoted integer ${literal}, which JavaScript cannot represent exactly ` +
            'and cannot detect that it cannot. Carry it as a string.',
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Every declaration of the corpus version agrees.
//
// The copies are DISCOVERED, never listed. A hand-maintained list is the same
// failure one level up: elsewhere, a fifth copy of a version number sat three
// releases stale while the test written to catch exactly that drift enumerated
// only four, and its own comment said adding a fifth means adding it here —
// which is precisely what nobody did.
// ---------------------------------------------------------------------------
{
  const declarations = [];

  for (const file of allFiles) {
    const name = file.split(/[\\/]/).pop();

    if (name === 'VERSION') {
      declarations.push([relative(root, file), readFileSync(file, 'utf8').trim()]);
    } else if (name === 'package.json') {
      const version = JSON.parse(readFileSync(file, 'utf8')).version;
      if (version) declarations.push([relative(root, file), version]);
    } else if (name === 'pyproject.toml') {
      const match = readFileSync(file, 'utf8').match(/^version\s*=\s*"([^"]+)"/m);
      if (match) declarations.push([relative(root, file), match[1]]);
    } else if (name === 'composer.json') {
      const version = JSON.parse(readFileSync(file, 'utf8')).version;
      if (version) declarations.push([relative(root, file), version]);
    }
  }

  // Vacuity guard. A broken discovery must FAIL rather than pass over nothing.
  if (declarations.length < 4) {
    fail(
      'version-agreement',
      `discovered only ${declarations.length} version declaration(s); expected at least 4 (the root VERSION plus one per loader package). ` +
        'Discovery is broken, which would otherwise look identical to agreement.',
    );
  }

  const distinct = new Set(declarations.map(([, version]) => version));

  if (distinct.size > 1) {
    fail(
      'version-agreement',
      `version declarations disagree:\n    ${declarations.map(([path, version]) => `${version}  ${path}`).join('\n    ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Every suite has a manifest, and every partial status states its gap.
//
// A status of "partial" without a gap is a green tick waiting to be misread.
// ---------------------------------------------------------------------------
{
  const suiteDir = join(root, 'suites');
  const suites = readdirSync(suiteDir).filter((entry) => statSync(join(suiteDir, entry)).isDirectory());

  if (suites.length === 0) fail('suite-manifests', 'found no suites — discovery is broken');

  for (const id of suites) {
    const manifestPath = join(suiteDir, id, 'manifest.json');

    if (!existsSync(manifestPath)) {
      fail('suite-manifests', `suites/${id} has no manifest.json`);
      continue;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

    if (manifest.id !== id) fail('suite-manifests', `suites/${id}/manifest.json declares id ${manifest.id}`);
    if (!manifest.reference) fail('suite-manifests', `suites/${id} does not name a reference implementation`);
    if (manifest.comparison?.mode !== 'canonical-json-string') {
      fail('suite-manifests', `suites/${id} declares an unknown comparison mode`);
    }

    for (const [language, implementation] of Object.entries(manifest.implementations ?? {})) {
      if (implementation.status !== 'full' && !implementation.gap?.trim()) {
        fail('suite-manifests', `suites/${id} marks ${language} as ${implementation.status} without stating the gap`);
      }
    }

    if (manifest.discrimination && manifest.discrimination.status !== 'probed' && !manifest.discrimination.gap?.trim()) {
      fail('suite-manifests', `suites/${id} is unprobed without stating why — an unprobed suite's green tick means less`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Every probe names a real suite and real case ids, and a control exists.
// ---------------------------------------------------------------------------
{
  const { probes } = JSON.parse(readFileSync(join(root, 'probes', 'probes.json'), 'utf8'));

  if (!probes?.length) fail('probes', 'no probes declared — the conformance table would be decoration');
  if (!probes.some((probe) => probe.kind === 'control')) {
    fail('probes', 'no control probe — without an implementation that passes everything, the mutants prove only that the port is broken');
  }

  for (const probe of probes) {
    if (!probe.hazard?.trim()) fail('probes', `probe ${probe.id} does not say what hazard it represents`);

    for (const [suiteId, ids] of Object.entries(probe.must_fail ?? {})) {
      const casesPath = join(root, 'suites', suiteId, 'cases.json');

      if (!existsSync(casesPath)) {
        fail('probes', `probe ${probe.id} names suite ${suiteId}, which does not exist`);
        continue;
      }

      const known = new Set(JSON.parse(readFileSync(casesPath, 'utf8')).cases.map((testCase) => testCase.id));

      for (const id of ids) {
        if (!known.has(id)) fail('probes', `probe ${probe.id} names case ${id}, which is not in ${suiteId}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// N. Every suite manifest matches schema/suite-manifest.schema.json.
//
// The schema existed for months and NOTHING LOADED IT. It had drifted so far
// that it would have rejected almost every manifest here: nine known keys with
// `additionalProperties: false` against manifests carrying thirteen, and a
// `kind` enum with no `security-corpus` in it -- the kind of nine suites.
//
// So it was worse than absent. Wired up on the day it was found, it would have
// reported the MANIFESTS as broken, and the natural response to a validator
// that fails everything is to delete the validator.
//
// It is enforced here now, which is the only thing that makes it trustworthy.
// A schema nothing runs is a description of the past.
//
// The validator is a deliberate SUBSET of JSON Schema -- type, required,
// properties, additionalProperties, enum, minProperties -- because this
// repository ships zero npm dependencies and a real one would be the first.
// It covers exactly what this schema uses; anything it cannot express does not
// belong in the schema until it can.
// ---------------------------------------------------------------------------
const manifestSchema = JSON.parse(readFileSync(join(root, 'schema', 'suite-manifest.schema.json'), 'utf8'));

function validate(value, schema, where) {
  const problems = [];

  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return [`${where} must be an object`];
    }

    for (const key of schema.required ?? []) {
      if (!(key in value)) problems.push(`${where} is missing required key \`${key}\``);
    }

    if (schema.minProperties && Object.keys(value).length < schema.minProperties) {
      problems.push(`${where} needs at least ${schema.minProperties} entr(y|ies)`);
    }

    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[key];

      if (childSchema) {
        problems.push(...validate(child, childSchema, `${where}.${key}`));
        continue;
      }

      if (schema.additionalProperties === false) {
        problems.push(`${where} carries unknown key \`${key}\` — add it to the schema, or remove it`);
      } else if (typeof schema.additionalProperties === 'object') {
        problems.push(...validate(child, schema.additionalProperties, `${where}.${key}`));
      }
    }

    return problems;
  }

  if (schema.type === 'string' && typeof value !== 'string') {
    problems.push(`${where} must be a string`);
  }

  if (schema.enum && !schema.enum.includes(value)) {
    problems.push(`${where} is ${JSON.stringify(value)}, which is not one of: ${schema.enum.join(', ')}`);
  }

  return problems;
}

for (const suiteId of readdirSync(join(root, 'suites'))) {
  const manifestPath = join(root, 'suites', suiteId, 'manifest.json');

  if (!existsSync(manifestPath)) continue;

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  for (const problem of validate(manifest, manifestSchema, suiteId)) {
    fail('manifest-schema', problem);
  }

  if (manifest.id !== suiteId) {
    fail('manifest-schema', `${suiteId} declares id "${manifest.id}", which is not its directory name`);
  }

  // A `partial` that does not say WHOSE gap it is reads as no gap at all. This
  // is the same rule tools/parity-gaps.mjs enforces, asserted here so a manifest
  // cannot be committed without it and discovered later by a report.
  for (const [language, entry] of Object.entries(manifest.implementations ?? {})) {
    if (entry.status === 'partial' && !entry.cause) {
      fail('manifest-schema', `${suiteId}/${language} is partial and states no \`cause\``);
    }
  }
}

if (failures.length > 0) {
  console.error(`Corpus guards failed:\n\n  ${failures.join('\n  ')}\n`);
  process.exit(1);
}

console.error(`Corpus guards passed (${allFiles.length} files scanned).`);
