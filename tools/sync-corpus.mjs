#!/usr/bin/env node
// Copy the corpus into each loader package so that every loader SHIPS THE
// FIXTURES IN ITS OWN ARTIFACT.
//
// That is what makes "load from the published package" possible at all. A
// loader that reaches for a sibling checkout works in exactly one directory
// layout and silently no-ops everywhere else — including CI, which checks out
// one repo. So the fixtures travel inside the package, and the loader finds
// them by walking up from its own file.
//
// The copies are generated, committed, and guarded: `--check` fails the build
// when a copy has drifted from suites/. Generated-and-checked beats
// generated-and-trusted, in a repository whose whole argument is that unchecked
// duplicates drift.
//
//   node tools/sync-corpus.mjs           # write the copies
//   node tools/sync-corpus.mjs --check   # fail if any copy is stale

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const check = process.argv.includes('--check');

const targets = [
  join(root, 'loaders', 'ts'),
  join(root, 'loaders', 'py', 'src', 'prism_conformance'),
  join(root, 'loaders', 'php'),
];

const sources = ['VERSION', 'suites', 'probes'];

function collect(base, rel = '') {
  const full = join(base, rel);
  if (!existsSync(full)) return [];
  if (statSync(full).isFile()) return [rel];
  return readdirSync(full).flatMap((entry) => collect(base, join(rel, entry)));
}

const files = sources.flatMap((source) => collect(root, source));
let stale = [];

for (const target of targets) {
  for (const file of files) {
    const from = join(root, file);
    const to = join(target, file);
    const content = readFileSync(from);

    if (!existsSync(to) || !readFileSync(to).equals(content)) {
      stale.push(relative(root, to));
      if (!check) {
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, content);
      }
    }
  }

  // A file deleted from suites/ has to disappear from the copies too, or a
  // retired case keeps running from a stale artifact.
  for (const source of sources) {
    const base = join(target, source);
    if (!existsSync(base) || statSync(base).isFile()) continue;
    for (const file of collect(target, source)) {
      if (!files.includes(file)) {
        stale.push(relative(root, join(target, file)));
        if (!check) rmSync(join(target, file));
      }
    }
  }
}

if (stale.length > 0) {
  if (check) {
    console.error(`Corpus copies are stale:\n  ${stale.join('\n  ')}\n\nRun: node tools/sync-corpus.mjs`);
    process.exit(1);
  }
  console.error(`Synced ${stale.length} file(s) into ${targets.length} loader package(s).`);
} else {
  console.error('Corpus copies are current.');
}
