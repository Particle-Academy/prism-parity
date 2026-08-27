#!/usr/bin/env node
// Hunts ONE shape: an operation with several distinct failure modes that
// reports a single bit.
//
// The reader is then sent somewhere useless, or nowhere. It is not a style
// complaint — a caller that cannot tell "deliberately skipped, never retry"
// from "failed, please retry" will eventually choose wrong, and the code that
// chooses wrong is usually far from the function that lost the information.
//
//   node tools/collapse-hunt.mjs                 # every repo it can see
//   node tools/collapse-hunt.mjs --repo ../prism # one repo
//
// EXITS ZERO ALWAYS. It reports; it does not judge. Do not wire it into a gate.
//
// ---------------------------------------------------------------------------
// WHEN TO RUN IT — this matters more than the rule
// ---------------------------------------------------------------------------
//
// 1. ON THE FILE YOU JUST FIXED, not as an estate-wide sweep. When the Fancy
//    team first ran their version they found four real hits in one file — the
//    file they had been working in an hour earlier. The rule found them;
//    PROXIMITY is what made them dense. The shape clusters where someone was
//    recently thinking, so the moment just after a fix is when it pays.
//
// 2. A HIT THAT LOOKS HARMLESS IS NOT DISMISSED UNTIL ITS CALLERS ARE READ.
//    The states are lost in the function; the HARM is wherever the single bit
//    gets interpreted. Our own hit was judged theoretical until someone read
//    the one caller, which did:
//
//        $ok ? $this->awarded++ : $this->skip('already awarded');
//
//    counting every FAILURE as a duplicate and reporting itself clean. The
//    caller that most needed to tell the states apart was the one asserting
//    they were the same.
//
// 3. IT FINDS OPERATIONS, NOT VALUES. "This function has several failure modes
//    and returns one bit" is structural and a machine can see it. "This `??` is
//    over something where null is legal" depends on what the variable MEANS,
//    and no regex crosses that gap. Do not expect this to find the second kind;
//    the second kind still depends on somebody noticing.
//
// See docs/decisions/0020-collapsed-states.md.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const explicit = args.map((a, i) => (a === '--repo' ? args[i + 1] : null)).filter(Boolean);

// A PREDICATE is not a collapse. For a yes/no question a bool IS the whole
// answer, and seven ways to say "no" is fine. Excluding these by name took the
// Fancy team's first run from 10 candidates to 4, all real — it is the single
// change that makes the rule worth reading.
const PREDICATE = /^(is|has|have|can|could|should|must|may|matches|equals|contains|includes|supports|allows|needs|wants|was|were|are|exists|passes|accepts)/i;

const walk = (dir, test, out = []) => {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    // The fixtures are deliberately-broken code. They are reached only by
    // --self-check; letting them into an estate sweep would report two known
    // hits forever and teach the reader to skim past the list.
    if (['node_modules', 'vendor', '.git', 'dist', 'storage', '__pycache__', '.parity', 'collapse-hunt-fixtures'].includes(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, test, out);
    else if (test(entry)) out.push(path);
  }
  return out;
};

// A `return false` whose state is ANNOUNCED first is not hidden: the caller
// loses it, but the operator does not. `$this->skip('already awarded')` before
// the return reports the state through a different channel, and a function that
// does this everywhere is correct however much it looks like the shape.
//
// SOFTENED, NOT EXCLUDED. A function where some returns announce and three or
// more do not is still hiding those three.
//
// Both forms count. The two-line one is what you picture; the SINGLE-LINE
// `{ $this->skip('x'); return false; }` is more idiomatic in PHP and is the one
// that slipped through the Fancy team's first version of this discount.
const ANNOUNCED = /(?:->|::)\w+\s*\([^)]*['"][^)]*\)\s*;\s*$/;

function hidden(body) {
  let count = 0;
  for (const m of body.matchAll(/return\s+false\s*;/g)) {
    const before = body.slice(Math.max(0, m.index - 200), m.index);
    if (!ANNOUNCED.test(before)) count += 1;
  }
  return count;
}

// SELF-CHECK. Run this after ANY change to the rule, and never judge a change
// by whether a real repository got quieter -- a rule going blind and code
// getting better are indistinguishable there. The fixtures do not move.
//
//   node tools/collapse-hunt.mjs --self-check
//
// Expects exactly collapses() and partiallyAnnounces(), never announces().
const selfCheck = args.includes('--self-check');

const repos = selfCheck
  ? [{ name: 'fixtures', path: join(root, 'tools', 'collapse-hunt-fixtures'), fixtures: true }]
  : explicit.length
  ? explicit.map((p) => ({ name: basename(resolve(p)), path: resolve(p) }))
  : readdirSync(dirname(root))
      .map((e) => ({ name: e, path: join(dirname(root), e) }))
      .filter(({ path }) => statSync(path).isDirectory() && existsSync(join(path, '.git')));

const hits = [];
let scanned = 0;
let unreadable = 0;

for (const repo of repos) {
    // src/ and app/ in a real repo; the whole directory when neither exists,
    // which is how the fixtures get scanned. Falling back matters more than it
    // looks: the first fixture run reported "no candidates" because it had
    // walked NOTHING, and that reads identically to the rule working.
    let files = [...walk(join(repo.path, 'src'), (n) => n.endsWith('.php')), ...walk(join(repo.path, 'app'), (n) => n.endsWith('.php'))];
    if (files.length === 0) {
      files = repo.fixtures
        ? readdirSync(repo.path).filter((n) => n.endsWith('.php')).map((n) => join(repo.path, n))
        : walk(repo.path, (n) => n.endsWith('.php'));
    }

  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      unreadable += 1;
      continue;
    }
    scanned += 1;

    for (const m of source.matchAll(/function\s+(\w+)\s*\([^)]*\)\s*:\s*\??bool\s*\{/g)) {
      if (PREDICATE.test(m[1])) continue;

      let i = m.end ? m.end : m.index + m[0].length;
      i -= 1;
      let depth = 0;
      while (i < source.length) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}' && --depth === 0) break;
        i += 1;
      }

      const body = source.slice(m.index + m[0].length, i);
      const falses = hidden(body);

      if (falses >= 3) {
        hits.push({
          file: relative(repo.path, file).split(/[\\/]/).join('/'),
          repo: repo.name,
          line: source.slice(0, m.index).split('\n').length,
          name: m[1],
          falses,
        });
      }
    }
  }
}

// A hunter that silently scanned less than you think is the failure it hunts.
console.log(`\ncollapse-hunt — ${scanned} PHP files across ${repos.length} repo(s), ${unreadable} unreadable\n`);

if (hits.length === 0) {
  console.log('  No candidates. That is not proof of absence: this rule sees operations, not values.\n');
} else {
  for (const h of hits) {
    console.log(`  ${h.repo}/${h.file}:${h.line}  ${h.name}()  ${h.falses} distinct \`return false\``);
  }
  console.log(`\n  ${hits.length} candidate(s). READ THE CALLERS before dismissing any of them —`);
  console.log('  the states are lost here, the harm is wherever the bit gets interpreted.\n');
}

if (selfCheck) {
  const found = hits.map((h) => h.name).sort();
  const want = ['collapses', 'partiallyAnnounces'];
  const ok = scanned > 0 && found.length === want.length && found.every((n, i) => n === want[i]);

  console.log(ok ? '  SELF-CHECK PASSED' : `  SELF-CHECK FAILED - wanted [${want}], got [${found}] over ${scanned} file(s)`);
  process.exit(ok ? 0 : 1);
}

process.exit(0);
