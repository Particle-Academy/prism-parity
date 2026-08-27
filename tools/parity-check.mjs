#!/usr/bin/env node
// The EXISTENCE half of parity, and the drift report.
//
// A conformance corpus guards drift, not existence: it compares two
// implementations and reports that they disagree, but it can never fail on
// ABSENCE, because a missing mirror has nothing to run the rows against. This is
// the other mechanism. See docs/decisions/0003-drift-and-existence.md.
//
//   node tools/parity-check.mjs            # fail on a missing mirror
//   node tools/parity-check.mjs --report   # also print the drift report

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, 'manifest', 'packages.json'), 'utf8'));
const failures = [];
const report = process.argv.includes('--report');

const directories = (path) =>
  existsSync(path) ? readdirSync(path).filter((entry) => statSync(join(path, entry)).isDirectory()) : [];

// ---------------------------------------------------------------------------
// DISCOVER the languages in play. Never a hand-maintained list.
//
// A list is the same failure one level up: add a fourth port, forget the
// manifest entry, and the check that exists to catch exactly that omission is
// the thing that misses it. Elsewhere, a fifth copy of a version number sat
// three releases stale beneath a test that enumerated four, with a comment
// saying adding a fifth means adding it here.
// ---------------------------------------------------------------------------
const discovered = new Set([
  ...directories(join(root, 'loaders')),
  ...directories(join(root, 'runners')).filter((entry) => entry !== 'README.md'),
]);

for (const suiteId of directories(join(root, 'suites'))) {
  const suiteManifest = JSON.parse(readFileSync(join(root, 'suites', suiteId, 'manifest.json'), 'utf8'));

  for (const language of Object.keys(suiteManifest.implementations ?? {})) discovered.add(language);
}

// Vacuity guard. A discovery that finds nothing must FAIL, not pass: silently
// succeeding over an empty set is indistinguishable from working, and strictly
// worse than not checking at all.
if (discovered.size < 3) {
  failures.push(
    `discovery found only ${discovered.size} language(s) (${[...discovered].join(', ') || 'none'}); ` +
      'expected at least 3. Discovery is broken, which would otherwise look identical to full coverage.',
  );
}

const declared = new Map(Object.entries(manifest.packages).map(([name, pkg]) => [pkg.language, { name, ...pkg }]));

for (const language of discovered) {
  if (!declared.has(language)) {
    failures.push(
      `the repository contains an implementation for '${language}' that manifest/packages.json does not list. ` +
        'Add it to packages, and decide which mirrors it is required to carry.',
    );
  }
}

for (const [language, pkg] of declared) {
  if (!discovered.has(language)) {
    failures.push(`manifest/packages.json declares ${pkg.name} for '${language}', but nothing in the repository runs it.`);
  }
}

// ---------------------------------------------------------------------------
// The mirrors: units we have COMMITTED to keeping in step. A missing one is a
// build failure — this is the check a fixture table structurally cannot make.
// ---------------------------------------------------------------------------
if (!manifest.mirrors?.length) failures.push('no mirrors declared — the existence check would assert nothing');

for (const mirror of manifest.mirrors ?? []) {
  const [, value] = mirror.unit.split(':');

  for (const language of mirror.required_in) {
    const pkg = declared.get(language);

    if (!pkg) {
      failures.push(`mirror ${mirror.unit} requires '${language}', which is not a declared package.`);
      continue;
    }

    if (!(pkg.surface?.[mirror.kind] ?? []).includes(value)) {
      failures.push(
        `MIRROR MISSING: ${mirror.unit} is required in '${language}' and ${pkg.name} does not have it. ` +
          'Either implement it, or move it to `deferred` with a reason.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The drift report: everything the reference has that a port does not.
//
// Informational, not enforced. What separates a decision from an oversight is
// the `deferred` list — a listed absence is the plan, an unlisted one is drift.
// ---------------------------------------------------------------------------
const reference = [...declared.values()].find((pkg) => pkg.role === 'reference');

// ---------------------------------------------------------------------------
// IS THE MANIFEST TRUE?
//
// Everything below compares one DECLARATION against another: the reference's
// declared surface against a port's declared surface. Nothing checked either
// against the code, so the registry of what exists could be -- and was --
// wrong about what exists. Anthropic shipped in both ports and this file went
// on saying they had only OpenAI, which then travelled into an agent's
// reasoning and came out as a filed finding.
//
// That is the failure this file's own $comment warns about, one level up: a
// hand-maintained list going stale beneath the check written to catch drift.
//
// Only runs where the port is checked out beside this repo. Where it is not,
// the package is COUNTED as unverified rather than passed over -- an
// unverifiable declaration must not read like a verified one.
// ---------------------------------------------------------------------------
let surfaceVerified = 0;
const surfaceUnverified = [];

for (const pkg of declared.values()) {
  const dir = pkg.surface_paths?.providers;
  if (!dir) continue;

  const repo = join(dirname(root), pkg.repository.split('/').pop());
  const providersPath = join(repo, dir);

  if (!existsSync(providersPath)) {
    surfaceUnverified.push(pkg.name);
    continue;
  }

  surfaceVerified += 1;

  const onDisk = new Set(
    readdirSync(providersPath)
      .filter((entry) => statSync(join(providersPath, entry)).isDirectory())
      .filter((entry) => !entry.startsWith('__') && entry !== 'Support')
      .map((entry) => entry.toLowerCase()),
  );

  const stated = new Set((pkg.surface?.providers ?? []).map((name) => name.toLowerCase()));

  for (const provider of onDisk) {
    if (!stated.has(provider)) {
      failures.push(
        `${pkg.name}: [${provider}] is implemented on disk and missing from the manifest. ` +
          'A registry that under-reports is worse than none, because it is read as authoritative.',
      );
    }
  }

  for (const provider of stated) {
    if (!onDisk.has(provider)) {
      failures.push(`${pkg.name}: the manifest claims provider [${provider}]; no such directory under ${dir}.`);
    }
  }
}

if (!reference) failures.push('no package is marked as the reference — the drift report has nothing to measure against');

const deferred = new Set((manifest.deferred ?? []).map((entry) => entry.unit));
const lines = [];

if (reference) {
  for (const pkg of declared.values()) {
    if (pkg.role === 'reference') continue;

    const missing = [];

    for (const kind of ['capabilities', 'providers', 'features']) {
      const singular = { capabilities: 'capability', providers: 'provider', features: 'feature' }[kind];

      for (const unit of reference.surface[kind] ?? []) {
        if ((pkg.surface?.[kind] ?? []).includes(unit)) continue;
        missing.push({ unit: `${singular}:${unit}`, deferred: deferred.has(`${singular}:${unit}`) });
      }
    }

    const undeclared = missing.filter((entry) => !entry.deferred);
    const planned = missing.filter((entry) => entry.deferred);

    lines.push(
      '',
      `## ${pkg.name} (${pkg.language}) v${pkg.version}`,
      '',
      `Behind the reference on ${missing.length} unit(s): ${planned.length} deferred by decision, ${undeclared.length} undeclared.`,
      '',
      ...(undeclared.length
        ? ['Undeclared — drift:', ...undeclared.map((entry) => `  - ${entry.unit}`)]
        : ['Undeclared — drift: none.']),
      '',
      'Deferred by decision:',
      ...planned.map((entry) => `  - ${entry.unit}`),
    );
  }
}

if (report) {
  console.log(`# Drift report\n\nKit ${manifest.kit_version}. Reference: ${reference?.name} v${reference?.version}.`);
  console.log(lines.join('\n'));
}

if (failures.length > 0) {
  console.error(`\nParity check failed:\n\n  ${failures.join('\n  ')}\n`);
  process.exit(1);
}

console.error(
  surfaceUnverified.length > 0
    ? `Manifest surface verified against disk for ${surfaceVerified} package(s); ${surfaceUnverified.length} UNVERIFIED (not checked out): ${surfaceUnverified.join(', ')}.`
    : `Manifest surface verified against disk for ${surfaceVerified} package(s).`,
);
console.error(`Parity check passed: ${discovered.size} languages, ${manifest.mirrors.length} mirrors enforced.`);
