#!/usr/bin/env node
// Does each repository's test suite actually RUN anywhere?
//
// This is a third question, and neither of the other two asks it.
// parity-check asks whether a mirror EXISTS. A conformance corpus asks whether
// two implementations AGREE. Both are satisfied by a repository whose tests sit
// on disk, wired to nothing, while CI reports green.
//
// That is not hypothetical. particle-academy/prism-opentelemetry shipped v0.1.1
// to Packagist with 32 tests and 80 assertions that no workflow had ever
// invoked: Pest, PHPStan and Pint were installed as dev dependencies, its only
// workflow ran the parity factcheck, and composer.json had no scripts at all.
// Every check this ecosystem owns passed it, because all of them read manifests
// or compare outputs, and none of them asks whether a check is CONNECTED.
//
//   node tools/tests-wired.mjs
//
// Exit 0 when every repository with tests has a workflow that runs them.
//
// NOT IN CI, AND HERE IS WHY -- stated rather than quietly omitted, since an
// unrun check is the exact thing this file is about.
//
// It reads the SIBLING repositories in the .agi envelope. prism-parity's own CI
// checks out prism-parity alone, so running it there finds zero repositories
// and trips the vacuity guard below: a failure, correctly, but a useless one.
//
// Two ways to close that, neither done here:
//   1. Check out all sibling repos in a CI job. Honest, and ~30 checkouts.
//   2. Ask the GitHub API for each repo's workflows instead of the filesystem.
//      Lighter, and it would check what is actually on main rather than what is
//      on this disk -- but it needs a token and a network.
//
// Until then this is run from the envelope, by a human or an agent.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const reposDir = dirname(root);

const isDir = (p) => existsSync(p) && statSync(p).isDirectory();
const directories = (p) => (isDir(p) ? readdirSync(p).filter((e) => isDir(join(p, e))) : []);

// How each ecosystem invokes a test suite. Substrings, not patterns: a runner
// is named the same way in a workflow whatever quoting surrounds it.
const INVOCATIONS = [
  'vendor/bin/pest',
  'vendor/bin/phpunit',
  'composer test',
  'pytest',
  'vitest',
  'jest',
  'node --test',
  'npm test',
  'npm run test',
  'yarn test',
  'pnpm test',
];

const checked = [];
const unwired = [];

for (const name of directories(reposDir)) {
  const repo = join(reposDir, name);

  // A submodule's .git is a FILE, not a directory. Accept either, or a repo
  // checked out plainly.
  if (!existsSync(join(repo, '.git'))) continue;

  const hasTests = isDir(join(repo, 'tests')) || isDir(join(repo, 'test'));
  if (!hasTests) continue;

  const workflowDir = join(repo, '.github', 'workflows');
  let wired = false;

  if (isDir(workflowDir)) {
    for (const file of readdirSync(workflowDir)) {
      if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
      const body = readFileSync(join(workflowDir, file), 'utf8');
      if (INVOCATIONS.some((needle) => body.includes(needle))) {
        wired = true;
        break;
      }
    }
  }

  checked.push(name);
  if (!wired) unwired.push(name);
}

// Vacuity guard, the same one parity-check carries and for the same reason: a
// sweep that finds nothing to check must FAIL rather than report success. A
// green run that examined zero repositories is the exact defect this tool
// exists to catch, one level up.
if (checked.length === 0) {
  console.error('tests-wired: found NO repositories with tests to check.');
  console.error(`Looked in ${reposDir}. This is a failure, not a pass.`);
  process.exit(1);
}

for (const name of unwired) {
  console.error(`FAIL ${name}: has tests, and no workflow runs them.`);
}

if (unwired.length > 0) {
  console.error('');
  console.error(`${unwired.length} of ${checked.length} repositories have tests wired to nothing.`);
  console.error('A suite that never runs is not coverage, and CI reports green either way.');
  process.exit(1);
}

console.log(`tests-wired: ${checked.length} repositories checked, every suite is invoked by a workflow.`);
