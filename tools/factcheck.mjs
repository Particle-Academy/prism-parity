#!/usr/bin/env node
// Verifies that PROSE agrees with CODE.
//
// The corpus guards behaviour and parity-check.mjs guards existence. Neither
// looks at a single word of documentation, and documentation is where this
// ecosystem has actually been wrong: a README whose every example called a
// facade that was never written, a doc site listing an artisan command that did
// not exist yet, an install line for a package that is not on Packagist, a
// citation pointing at the wrong decision number, and a sidebar entry whose
// duplicate object keys meant two providers had never rendered at all.
//
// Every one of those is a CLAIM — a statement in prose that something exists,
// is named a certain way, or can be run. Every one is mechanically checkable.
// None of them was checked, because nothing tests prose.
//
//   node tools/factcheck.mjs                 # check every repo it can see
//   node tools/factcheck.mjs --map           # print every claim and its verdict
//   node tools/factcheck.mjs --json          # machine-readable, for CI and agents
//   node tools/factcheck.mjs --reconcile     # re-record versions + census
//
// See docs/decisions/0019-checking-the-prose.md.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const CONTRACT = '1.0';

const parityRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lockPath = join(parityRoot, 'tools', 'factcheck.lock.json');

const args = process.argv.slice(2);
const argv = new Set(args);

// Explicit repo paths, for CI. Auto-discovery is right in the envelope, where
// the repos really are siblings; on a runner the siblings are whatever the
// checkout tool left lying around, and a checker that silently indexes junk is
// a checker reporting on something other than what it claims.
const explicit = args
  .map((arg, index) => (arg === '--repo' ? args[index + 1] : null))
  .filter((value) => typeof value === 'string' && value.length > 0);
const wantsJson = argv.has('--json');
const wantsMap = argv.has('--map');
const reconciling = argv.has('--reconcile');

// Version drift means "nobody has re-read these rules since that repo
// released". That is worth enforcing, but not worth reddening an unrelated pull
// request over: the release it refers to may be in a different repository
// entirely. So it warns by default and FAILS under --strict, which the nightly
// run uses. Currency still gets enforced; it just stops blocking work that has
// nothing to do with it.
//
// The census half (`blind-check`) is NOT softened. A rule that has stopped
// matching anything is a broken guard right now, in this run.
const strict = argv.has('--strict');

const findings = [];
const claims = [];

const finding = (severity, kind, repo, file, line, claim, message) =>
  findings.push({ severity, kind, repo, file, line, claim, message });

// ---------------------------------------------------------------------------
// WHERE THE REPOS ARE.
//
// Two layouts, because this runs in two places. In the envelope, prism-parity
// sits beside its siblings. In another repo's CI it is checked out INTO that
// repo as `.parity/`, and then the only repo to check is the one above it.
//
// Discovered, never listed. A hand-maintained list of repos is the same failure
// this script exists to catch, one level up: add a repo, forget the entry, and
// the checker reports green over documentation nobody looked at.
// ---------------------------------------------------------------------------
function discoverRepos() {
  if (explicit.length > 0) {
    return explicit.map((path) => ({ name: basename(resolve(path)), path: resolve(path) }));
  }

  const nested = basename(parityRoot) === '.parity';
  const searchRoot = nested ? dirname(parityRoot) : dirname(parityRoot);

  if (nested) {
    return [
      { name: basename(searchRoot), path: searchRoot },
      { name: 'prism-parity', path: parityRoot },
    ];
  }

  return readdirSync(searchRoot)
    .map((entry) => ({ name: entry, path: join(searchRoot, entry) }))
    .filter(({ path }) => existsSync(join(path, '.git')) || existsSync(join(path, 'composer.json')))
    .filter(({ path }) => statSync(path).isDirectory());
}

const walk = (dir, test, out = []) => {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'vendor', '.git', 'dist', 'storage', '__pycache__'].includes(entry)) continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, test, out);
    else if (test(entry)) out.push(path);
  }
  return out;
};

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// THE WORLD: what actually exists, indexed once.
// ---------------------------------------------------------------------------
function indexRepo(repo) {
  const composer = readJson(join(repo.path, 'composer.json'));
  const pkg = readJson(join(repo.path, 'package.json'));

  const psr4 = composer?.autoload?.['psr-4'] ?? {};
  const classes = new Set();

  for (const [prefix, dir] of Object.entries(psr4)) {
    const base = join(repo.path, Array.isArray(dir) ? dir[0] : dir);
    for (const file of walk(base, (name) => name.endsWith('.php'))) {
      const fqcn = prefix + relative(base, file).replace(/\.php$/, '').split(/[\\/]/).join('\\');
      classes.add(fqcn);
    }
  }

  // Artisan command names, from either declaration style.
  const commands = new Set();
  for (const file of walk(join(repo.path, 'src'), (name) => name.endsWith('.php')).concat(
    walk(join(repo.path, 'app'), (name) => name.endsWith('.php')),
  )) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/AsCommand\(\s*(?:\r?\n\s*)?name:\s*'([^']+)'/g)) commands.add(match[1]);
    for (const match of source.matchAll(/\$signature\s*=\s*'([a-z0-9:_-]+)/g)) commands.add(match[1]);
    for (const match of source.matchAll(/protected\s+\$name\s*=\s*'([a-z0-9:_-]+:[a-z0-9:_-]+)'/g)) commands.add(match[1]);
  }

  // Pest/PHPUnit test names, so a README that cites a test by name can be held to it.
  const tests = new Set();
  for (const file of walk(join(repo.path, 'tests'), (name) => name.endsWith('.php'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\bit\('([^']+)'/g)) tests.add(match[1]);
  }

  return {
    ...repo,
    psr4: Object.keys(psr4),
    classes,
    commands,
    tests,
    composerScripts: scriptsIn(repo.path, 'composer.json'),
    npmScripts: scriptsIn(repo.path, 'package.json'),
    composerName: composer?.name ?? null,
    version: repoVersion(repo.path),
  };
}

// Scripts from EVERY manifest in the repo, not only the root one. A docs
// directory with its own package.json declares real scripts the root knows
// nothing about, and calling those undeclared is the checker being wrong
// about a repo that is right.
function scriptsIn(root, filename) {
  const names = new Set();
  for (const file of walk(root, (name) => name === filename)) {
    for (const key of Object.keys(readJson(file)?.scripts ?? {})) names.add(key);
  }
  return names;
}

function repoVersion(path) {
  const git = (args) => {
    try {
      return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };

  return git(['describe', '--tags', '--abbrev=0']) ?? git(['rev-parse', '--short', 'HEAD']) ?? 'unknown';
}

// ---------------------------------------------------------------------------
// CLAIM EXTRACTION.
//
// Fence-aware, because where a line sits changes what it asserts: `use X;` is a
// claim about a class only inside a php block, and a markdown link is only a
// link outside one.
// ---------------------------------------------------------------------------
const EXTERNAL_NAMESPACES = ['Illuminate\\', 'Laravel\\', 'Symfony\\', 'Psr\\', 'GuzzleHttp\\', 'OpenTelemetry\\', 'App\\', 'Tests\\', 'Workbench\\', 'FancyFlow\\'];

// A command is OURS if it is named like one of ours. Anything else — migrate,
// vendor:publish, tinker — belongs to the framework or another package and is
// counted as external rather than silently ignored.
const OURS = /^(make:prism|prism)[-:]/;

function extractClaims(repo) {
  // The built site is a copy of the source pages. Checking both would double
  // every claim and report each failure twice.
  const files = walk(repo.path, (name) => name.endsWith('.md')).filter(
    (path) => !/[\/]\.vitepress[\/]dist[\/]/.test(path),
  );

  for (const path of files) {
    const rel = relative(repo.path, path).split(/[\\/]/).join('/');
    const lines = readFileSync(path, 'utf8').split('\n');
    let fence = null;
    let ignoreNext = false;
    let skipFence = false;
    let fileIgnored = false;

    lines.forEach((text, index) => {
      const line = index + 1;

      // DELIBERATE counter-examples. Documentation that shows a wrong name in
      // order to warn against it is doing its job, and a checker that forbids
      // that is making the docs worse to make itself green — the skill file
      // teaching "these namespaces do not exist" is the case that found this.
      //
      // The escape hatch REQUIRES a reason, so a suppression stays reviewable
      // instead of becoming a quiet way to switch the check off.
      const ignore = text.match(/<!--\s*factcheck-ignore-(next|file)\s*:\s*(.+?)\s*-->/);
      if (ignore) {
        if (ignore[1] === 'file') fileIgnored = true;
        else ignoreNext = true;
        return;
      }

      const fenceMatch = text.match(/^\s*```(\w*)/);

      if (fenceMatch) {
        if (fence === null) {
          skipFence = ignoreNext;
          ignoreNext = false;
          fence = fenceMatch[1] || 'text';
        } else {
          fence = null;
          skipFence = false;
        }
        return;
      }

      if (fileIgnored || skipFence) return;

      const add = (kind, value, extra = {}) => claims.push({ kind, value, repo: repo.name, file: rel, line, ...extra });

      if (fence === 'php') {
        const use = text.match(/^\s*use\s+([A-Z][A-Za-z0-9_\\]*)\s*(?:as\s+\w+)?;/);
        if (use) add('php-class', use[1]);
      }

      // A shared document legitimately describes OTHER repos' commands, and the
      // convention for saying which is already in use: a trailing `# prism-ts`.
      // Honouring it keeps the shared guide checkable instead of exempt, which
      // matters — the guide is the most-read page and the least-owned.
      const hint = text.match(/#\s*(prism[a-z-]*)\s*$/)?.[1];

      if (fence === null || fence === 'bash' || fence === 'sh' || fence === 'shell') {
        for (const m of text.matchAll(/php artisan ([a-z0-9:_-]+)/g)) add('artisan-command', m[1]);
        for (const m of text.matchAll(/composer require ([a-z0-9][a-z0-9/_.-]*)/g)) add('composer-package', m[1], { from: path });
        for (const m of text.matchAll(/\bcomposer (test|types|format|lint|watch|build|setup|dev)\b/g)) add('composer-script', m[1], { hint });
        for (const m of text.matchAll(/\bnpm run ([a-z][a-z0-9:-]*)/g)) add('npm-script', m[1], { hint });
      }

      if (fence === null) {
        for (const m of text.matchAll(/decisions\/(\d{4})-([a-z0-9-]+)/g)) add('decision', `${m[1]}-${m[2]}`);
        for (const m of text.matchAll(/\bdecision (\d{4})\b/gi)) add('decision-number', m[1]);
        for (const m of text.matchAll(/\bit\('([^']+)'\)/g)) add('test-name', m[1]);
        for (const m of text.matchAll(/\[[^\]]*\]\((?!https?:|mailto:|#)([^)#\s]+)/g)) add('local-link', m[1], { from: path });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// VERIFICATION.
// ---------------------------------------------------------------------------
function verify(world) {
  const byName = new Map(world.map((r) => [r.name, r]));
  const allClasses = new Set(world.flatMap((r) => [...r.classes]));
  const allCommands = new Set(world.flatMap((r) => [...r.commands]));
  const knownPrefixes = world.flatMap((r) => r.psr4);
  const decisions = new Set(
    existsSync(join(parityRoot, 'docs', 'decisions'))
      ? readdirSync(join(parityRoot, 'docs', 'decisions')).map((f) => f.replace(/\.md$/, ''))
      : [],
  );
  const lock = readJson(lockPath) ?? { packages: {} };

  for (const claim of claims) {
    const repo = byName.get(claim.repo);

    switch (claim.kind) {
      case 'php-class': {
        // No namespace separator means a PHP global -- Throwable, Closure,
        // DateTimeImmutable. Cheaper and more durable than a builtin list
        // that would need an entry every PHP release.
        if (!claim.value.includes('\\') || EXTERNAL_NAMESPACES.some((ns) => claim.value.startsWith(ns))) {
          claim.verdict = 'external';
          break;
        }
        const owner = knownPrefixes.find((prefix) => claim.value.startsWith(prefix));
        if (!owner) {
          // The owning repo is not checked out. Skipped, and counted, so a
          // single-repo CI run cannot be mistaken for full coverage.
          claim.verdict = 'unresolvable';
          break;
        }
        claim.verdict = allClasses.has(claim.value) ? 'ok' : 'failed';
        if (claim.verdict === 'failed') {
          finding('error', claim.kind, claim.repo, claim.file, claim.line, claim.value, `No such class. Documented in a php block; nothing under a psr-4 root defines it.`);
        }
        break;
      }

      case 'artisan-command': {
        if (!OURS.test(claim.value)) {
          claim.verdict = 'external';
          break;
        }
        claim.verdict = allCommands.has(claim.value) ? 'ok' : 'failed';
        if (claim.verdict === 'failed') {
          finding('error', claim.kind, claim.repo, claim.file, claim.line, claim.value, `No command declares this name.`);
        }
        break;
      }

      case 'composer-package': {
        if (!claim.value.startsWith('particle-academy/')) {
          claim.verdict = 'external';
          break;
        }
        // Checked against the census rather than the network, so CI is hermetic
        // and a Packagist outage cannot turn a docs check red. --reconcile is
        // what refreshes it.
        const known = lock.packages?.[claim.value];
        if (known === undefined) {
          claim.verdict = 'unknown';
          finding('warning', claim.kind, claim.repo, claim.file, claim.line, claim.value, `Not in the published census. Run --reconcile with network access.`);
        } else if (known.published === false) {
          // An unpublished package IS installable, but only alongside a VCS
          // repository block. So the claim is accepted when the same page
          // supplies one, and rejected when it does not — which is the actual
          // difference between an install line that works and one that fails.
          // Suppressing this instead would hide the distinction that matters.
          if (declaresVcsRepository(claim)) {
            claim.verdict = 'ok';
            break;
          }

          claim.verdict = 'failed';
          finding('error', claim.kind, claim.repo, claim.file, claim.line, claim.value, `Not on Packagist, and this page gives no "type": "vcs" repository block. A reader following it gets "could not find a matching version".`);
        } else {
          claim.verdict = 'ok';
        }
        break;
      }

      case 'composer-script':
      case 'npm-script': {
        // A hint naming a repo that is not in scope is UNRESOLVABLE, not
        // failed — the same rule as a class whose package is not checked out.
        // Falling back to the containing repo would blame prism-parity for a
        // script the shared guide explicitly attributes to prism-ts.
        if (claim.hint && !byName.has(claim.hint)) {
          claim.verdict = 'unresolvable';
          break;
        }

        const owner = (claim.hint && byName.get(claim.hint)) || repo;
        const set = claim.kind === 'composer-script' ? owner?.composerScripts : owner?.npmScripts;
        if (!set || set.size === 0) {
          claim.verdict = 'unresolvable';
          break;
        }
        claim.verdict = set.has(claim.value) ? 'ok' : 'failed';
        if (claim.verdict === 'failed') {
          finding('error', claim.kind, claim.repo, claim.file, claim.line, claim.value, `Documented, but ${owner?.name ?? claim.repo} declares no such script.`);
        }
        break;
      }

      case 'decision': {
        if (decisions.size === 0) {
          claim.verdict = 'unresolvable';
          break;
        }
        claim.verdict = decisions.has(claim.value) ? 'ok' : 'failed';
        if (claim.verdict === 'failed') {
          finding('error', claim.kind, claim.repo, claim.file, claim.line, claim.value, `No decision file with that number and slug.`);
        }
        break;
      }

      case 'decision-number': {
        if (decisions.size === 0) {
          claim.verdict = 'unresolvable';
          break;
        }
        const exists = [...decisions].some((d) => d.startsWith(`${claim.value}-`));
        claim.verdict = exists ? 'ok' : 'failed';
        if (claim.verdict === 'failed') {
          finding('error', claim.kind, claim.repo, claim.file, claim.line, claim.value, `Prose cites decision ${claim.value}; no such decision exists.`);
        }
        break;
      }

      case 'test-name': {
        if (!repo || repo.tests.size === 0) {
          claim.verdict = 'unresolvable';
          break;
        }
        claim.verdict = repo.tests.has(claim.value) ? 'ok' : 'failed';
        if (claim.verdict === 'failed') {
          finding('error', claim.kind, claim.repo, claim.file, claim.line, claim.value, `Prose cites this test by name; no test in this repo is called that.`);
        }
        break;
      }

      case 'local-link': {
        if (linkResolves(claim, repo)) {
          claim.verdict = 'ok';
          break;
        }

        // Severity split. A RELATIVE link names a file from a known directory
        // and either exists or does not — unambiguous, so it fails. A
        // SITE-ABSOLUTE link is rooted at a content root only the site's own
        // routing knows: it may be served from a vendored directory, or
        // rewritten with a prefix at render time. Calling those dead would be
        // this checker guessing, and a checker that cries wolf gets switched
        // off — which costs more than the links it would have caught.
        if (claim.value.startsWith('/')) {
          claim.verdict = 'unresolvable';
          finding('warning', claim.kind, claim.repo, claim.file, claim.line, claim.value, `Site-absolute link; no content root under this repo resolves it. Verify by hand, or it is served from somewhere this check cannot see.`);
        } else {
          claim.verdict = 'failed';
          finding('error', claim.kind, claim.repo, claim.file, claim.line, claim.value, `Relative link resolves to nothing on disk.`);
        }
        break;
      }
    }
  }
}

// Whether the page carrying an install line also supplies the VCS repository
// that makes it work. Scoped to the file, because a reader follows one page.
function declaresVcsRepository(claim) {
  const slug = claim.value.split('/')[1];
  const source = vcsCache.get(claim.from) ?? readSource(claim);
  return /"type"\s*:\s*"vcs"/.test(source) && source.includes(slug);
}

const vcsCache = new Map();

function readSource(claim) {
  const source = existsSync(claim.from) ? readFileSync(claim.from, 'utf8') : '';
  vcsCache.set(claim.from, source);
  return source;
}

// ---------------------------------------------------------------------------
// LINK RESOLUTION.
//
// A leading slash is not a filesystem path. Inside a docs site it is
// SITE-absolute — rooted at the directory holding `.vitepress`, not at the repo
// and certainly not at the drive. Treating it as a filesystem path reports
// every internal link in the site as dead, which is a checker crying wolf, and
// a checker that cries wolf gets switched off.
//
// `.html` is likewise a published URL, not a file: on disk it is `.md`.
// ---------------------------------------------------------------------------
function docsRootFor(file) {
  let dir = dirname(file);
  while (dir.length > 3) {
    if (existsSync(join(dir, '.vitepress'))) return dir;
    dir = dirname(dir);
  }
  return null;
}

function linkResolves(claim, repo) {
  const bare = claim.value.replace(/\.html$/, '');
  const roots = [];

  if (bare.startsWith('/')) {
    // The content root is whichever ancestor makes the link resolve. VitePress
    // roots at the directory holding `.vitepress`; a Laravel docs app roots at
    // wherever its repository points. Walking up covers both without this
    // script having to know either.
    const site = docsRootFor(claim.from);
    if (site) roots.push(join(site, bare.slice(1)));

    let dir = dirname(claim.from);
    const stop = repo ? repo.path : dir;
    while (dir.length >= stop.length) {
      roots.push(join(dir, bare.slice(1)));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } else {
    roots.push(resolve(dirname(claim.from), bare));
  }

  return roots.some((target) => existsSync(target) || existsSync(`${target}.md`) || existsSync(join(target, 'index.md')));
}

// ---------------------------------------------------------------------------
// DUPLICATE KEYS IN CONFIG OBJECT LITERALS.
//
// JavaScript keeps the LAST of a repeated key and reports nothing. That is how
// two providers sat in the doc site's sidebar for months without ever
// rendering: one object literal carried three text/link pairs, so two thirds of
// it was discarded silently at parse time.
// ---------------------------------------------------------------------------
function checkDuplicateKeys(world) {
  for (const repo of world) {
    const files = walk(repo.path, (name) => /\.(mts|ts|mjs|js)$/.test(name)).filter(
      (path) => path.includes('.vitepress') || path.includes('config'),
    );

    for (const path of files) {
      const rel = relative(repo.path, path).split(/[\\/]/).join('/');
      const lines = readFileSync(path, 'utf8').split('\n');
      let depth = 0;
      let seen = [new Map()];

      lines.forEach((text, index) => {
        for (const char of text) {
          if (char === '{') {
            depth += 1;
            seen[depth] = new Map();
          } else if (char === '}') {
            seen[depth] = new Map();
            depth = Math.max(0, depth - 1);
          }
        }

        const key = text.match(/^\s*([A-Za-z_$][\w$]*)\s*:/);
        if (!key || depth === 0) return;

        const bucket = seen[depth] ?? (seen[depth] = new Map());
        if (bucket.has(key[1])) {
          finding(
            'error',
            'duplicate-key',
            repo.name,
            rel,
            index + 1,
            key[1],
            `Repeated key in one object literal (first at line ${bucket.get(key[1])}). JS keeps the last and discards the rest silently.`,
          );
        } else {
          bucket.set(key[1], index + 1);
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// STALENESS — is the CHECKER still current with what it checks?
//
// This is the part that matters most, and the part a fact-checker usually
// lacks. A checker whose rules have quietly stopped matching anything reports
// green over documentation nobody has verified, which is strictly worse than
// having no checker: it manufactures confidence.
//
// Two independent signals, because either alone can be fooled:
//
//   VERSION   Each repo's version when the lock was last reconciled. A repo
//             that has released since then has not been re-verified against
//             these rules, and a release is exactly when an API moves.
//
//   CENSUS    How many claims of each kind were found per repo at reconcile
//             time. If a rule breaks — a regex stops matching, a directory is
//             renamed, a doc format changes — the claim count collapses toward
//             zero and every remaining claim passes. A green run over ZERO
//             claims is the failure this catches, and nothing else would.
// ---------------------------------------------------------------------------
function checkStaleness(world) {
  const lock = readJson(lockPath);
  const census = censusOf();

  if (!lock) {
    finding('warning', 'staleness', 'prism-parity', 'tools/factcheck.lock.json', 0, 'lockfile', 'No lockfile yet. Run --reconcile to record versions and the claim census.');
    return { repos: [], census };
  }

  const status = [];

  for (const repo of world) {
    const recorded = lock.repos?.[repo.name];

    if (!recorded) {
      status.push({ repo: repo.name, recorded: null, actual: repo.version, state: 'unrecorded' });
      finding('warning', 'staleness', repo.name, '-', 0, repo.name, `This repo is not in the lockfile — the checker has never been reconciled against it. Run --reconcile.`);
      continue;
    }

    const drifted = recorded.version !== repo.version;
    status.push({ repo: repo.name, recorded: recorded.version, actual: repo.version, state: drifted ? 'drifted' : 'current' });

    if (drifted) {
      finding(
        strict ? 'error' : 'warning',
        'staleness',
        repo.name,
        '-',
        0,
        repo.name,
        `Verified against ${recorded.version}; the repo is now at ${repo.version}. Re-read the claims this script makes about it, then --reconcile.${strict ? '' : ' (Warning here; the nightly --strict run fails on it.)'}`,
      );
    }

    // The census half. A rule that has gone blind finds nothing and passes.
    for (const [kind, was] of Object.entries(recorded.census ?? {})) {
      const now = census[repo.name]?.[kind] ?? 0;
      if (was > 0 && now === 0) {
        finding(
          'error',
          'blind-check',
          repo.name,
          '-',
          0,
          kind,
          `Found ${was} ${kind} claims when reconciled and 0 now. Either they were all removed, or the rule that finds them has stopped working — and a check that matches nothing passes.`,
        );
      }
    }
  }

  return { repos: status, census };
}

function censusOf() {
  const out = {};
  for (const claim of claims) {
    out[claim.repo] ??= {};
    out[claim.repo][claim.kind] = (out[claim.repo][claim.kind] ?? 0) + 1;
  }
  return out;
}

async function reconcile(world, census) {
  const blocking = findings.filter((f) => f.severity === 'error' && !['staleness', 'blind-check'].includes(f.kind));

  if (blocking.length > 0) {
    // Reconciling over real findings would record "verified" against
    // documentation that is currently wrong, which is the exact lie this
    // lockfile exists to prevent.
    console.error(`\nRefusing to reconcile: ${blocking.length} unresolved finding(s). Fix them first.\n`);
    return 1;
  }

  const packages = {};
  for (const repo of world) {
    if (!repo.composerName?.startsWith('particle-academy/')) continue;
    let published = null;
    try {
      const response = await fetch(`https://repo.packagist.org/p2/${repo.composerName}.json`);
      published = response.status === 200;
    } catch {
      published = null;
    }
    packages[repo.composerName] = { published };
  }

  const lock = {
    contract: CONTRACT,
    note: 'Written by tools/factcheck.mjs --reconcile. Records what each repo was at when its claims were last verified, and how many claims of each kind were found. Both are staleness signals; see docs/decisions/0019-checking-the-prose.md.',
    reconciledAt: new Date().toISOString(),
    packages,
    repos: Object.fromEntries(
      world.map((repo) => [repo.name, { version: repo.version, census: census[repo.name] ?? {} }]),
    ),
  };

  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  console.log(`Reconciled ${world.length} repos into ${relative(process.cwd(), lockPath)}.`);
  return 0;
}

// ---------------------------------------------------------------------------

const repos = discoverRepos();
const world = repos.map(indexRepo);

for (const repo of world) extractClaims(repo);
verify(world);
checkDuplicateKeys(world);
const staleness = checkStaleness(world);

if (reconciling) {
  process.exit(await reconcile(world, staleness.census));
}

const errors = findings.filter((f) => f.severity === 'error');
const warnings = findings.filter((f) => f.severity === 'warning');
const counted = (verdict) => claims.filter((c) => c.verdict === verdict).length;

if (wantsJson) {
  console.log(
    JSON.stringify(
      {
        contract: CONTRACT,
        ok: errors.length === 0,
        repos: world.map((r) => ({ name: r.name, version: r.version })),
        claims: {
          total: claims.length,
          verified: counted('ok'),
          external: counted('external'),
          unresolvable: counted('unresolvable'),
          byKind: claims.reduce((acc, c) => ({ ...acc, [c.kind]: (acc[c.kind] ?? 0) + 1 }), {}),
        },
        staleness: staleness.repos,
        findings,
      },
      null,
      2,
    ),
  );
  process.exit(errors.length === 0 ? 0 : 1);
}

if (wantsMap) {
  for (const claim of claims) {
    console.log(`${(claim.verdict ?? '-').padEnd(13)} ${claim.kind.padEnd(18)} ${claim.repo}/${claim.file}:${claim.line}  ${claim.value}`);
  }
  console.log('');
}

console.log(`\nfactcheck ${CONTRACT} — ${world.length} repos, ${claims.length} claims\n`);
console.log(
  `  verified ${counted('ok')}   external ${counted('external')}   unresolvable ${counted('unresolvable')}\n`,
);

for (const f of findings) {
  const where = f.line ? `${f.repo}/${f.file}:${f.line}` : f.repo;
  console.log(`  ${f.severity === 'error' ? 'FAIL' : 'warn'}  ${f.kind.padEnd(18)} ${where}`);
  console.log(`        ${f.claim}`);
  console.log(`        ${f.message}\n`);
}

if (counted('unresolvable') > 0) {
  // Named rather than hidden. A run that skipped half its claims because a
  // sibling repo was not checked out must not read as full coverage.
  console.log(`  ${counted('unresolvable')} claim(s) could not be resolved — the repo that owns them was not present.\n`);
}

console.log(errors.length === 0 ? `PASS (${warnings.length} warning(s))\n` : `FAIL — ${errors.length} error(s), ${warnings.length} warning(s)\n`);

process.exit(errors.length === 0 ? 0 : 1);
