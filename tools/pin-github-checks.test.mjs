// node --test .ai/tools/pin-github-checks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, hashContent, verifyStepLines, rewriteWorkflow, checkWorkflow, resolveExpected } from './pin-github-checks.mjs';
import { checkStructure, parseYaml } from './pin-github-checks-structure.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'pin-github-checks-fixtures');
const EXECUTION_CASES = JSON.parse(fs.readFileSync(path.join(FIX, 'execution-hooks.json'), 'utf8'));
const TOOL = path.join(here, 'pin-github-checks.mjs');
const BASH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

function executeVerifier(step, workspace, override = {}, cwd = workspace) {
  const scriptFile = path.join(workspace, 'run-verifier.sh');
  fs.writeFileSync(scriptFile, step.run);
  return spawnSync(BASH, ['--noprofile', '--norc', scriptFile.replaceAll('\\', '/')], { cwd, encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...override, ...step.env, ...(override.PIN_SHA ? { PIN_SHA: override.PIN_SHA } : {}) } });
}
const SHA = 'a'.repeat(40);
const FILES = ['third-party/check.mjs', 'third-party/gate-graph.mjs', 'third-party/allowlist.json'];
const CFG = { repository: 'Example-Org/.github', files: FILES, guardJob: 'guard', defaultPermissions: 'read' };

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-gh-'));
  fs.cpSync(FIX, dir, { recursive: true });
  return dir;
}

function cli(dir, ...args) {
  const out = [];
  const code = run(['--config', path.join(dir, 'config.json'), '--source-dir', path.join(dir, 'source'), '--sha', SHA, ...args], {
    toolDir: here,
    log: (s) => out.push(s),
  });
  return { code, out: out.join('\n') };
}

const wfPath = (dir, root, repo, name) => path.join(dir, root, repo, '.github', 'workflows', name);
const expected = (dir) => {
  const hashes = {};
  for (const f of FILES) hashes[f] = hashContent(fs.readFileSync(path.join(dir, 'source', f)));
  return { sha: SHA, hashes, files: FILES };
};

test('hashes ignore CRLF vs LF, so Windows runners verify the same bytes', () => {
  const lf = ['a', 'b', ''].join(String.fromCharCode(10));
  const crlf = ['a', 'b', ''].join(String.fromCharCode(13, 10));
  assert.equal(hashContent(Buffer.from(lf)), hashContent(Buffer.from(crlf)));
  assert.notEqual(hashContent(Buffer.from('a')), hashContent(Buffer.from('b')));
});

test('--check on unpinned fixtures exits 1, names each file, prints the denominator', () => {
  const dir = sandbox();
  const r = cli(dir, '--check', '--root', path.join(dir, 'repos'), '--root', path.join(dir, 'new-repos'));
  assert.equal(r.code, 1);
  assert.match(r.out, /Visited 3 repos, 4 workflow files; 4 reference Example-Org\/\.github/);
  assert.match(r.out, /brand-new-repo\/\.github\/workflows\/ci\.yml .*\[no-ref\]/);
  assert.match(r.out, /npm-pkg\/\.github\/workflows\/publish\.yml .*\[write-permission\]/);
  assert.match(r.out, /4 offending workflow file/);
});

test('rewrite pins, verifies and isolates; then --check passes; a second rewrite is a no-op', () => {
  const dir = sandbox();
  const roots = ['--root', path.join(dir, 'repos')];
  const w = cli(dir, ...roots);
  assert.equal(w.code, 0, w.out);
  assert.match(w.out, /3 rewritten/);
  const c = cli(dir, '--check', ...roots);
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /0 offending/);
  const again = cli(dir, ...roots);
  assert.equal(again.code, 0);
  assert.match(again.out, /0 rewritten/);
});

test('an UNKNOWN new repo with an unpinned checkout fails --check by name, even after the estate is pinned', () => {
  const dir = sandbox();
  assert.equal(cli(dir, '--root', path.join(dir, 'repos')).code, 0);
  const r = cli(dir, '--check', '--root', path.join(dir, 'repos'), '--root', path.join(dir, 'new-repos'));
  assert.equal(r.code, 1);
  const fails = r.out.split('\n').filter((l) => l.startsWith('FAIL'));
  assert.ok(fails.length > 0);
  assert.ok(fails.every((l) => l.includes('brand-new-repo/.github/workflows/ci.yml')), r.out);
  assert.match(r.out, /\[no-ref\]/);
  assert.match(r.out, /\[no-verify\]/);
  assert.match(r.out, /1 offending workflow file/);
});

test('the real process exits 1 on --check failure and 0 when clean', () => {
  const dir = sandbox();
  const base = ['--config', path.join(dir, 'config.json'), '--source-dir', path.join(dir, 'source'), '--sha', SHA, '--root', path.join(dir, 'new-repos')];
  const bad = spawnSync(process.execPath, [TOOL, ...base, '--check'], { encoding: 'utf8' });
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.equal(spawnSync(process.execPath, [TOOL, ...base], { encoding: 'utf8' }).status, 0);
  const good = spawnSync(process.execPath, [TOOL, ...base, '--check'], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stdout);
});

test('a reference that is not an actions/checkout is unverifiable: --check fails, rewrite refuses and leaves the file alone', () => {
  const dir = sandbox();
  const file = wfPath(dir, 'raw-fetch', 'curl-repo', 'ci.yml');
  const before = fs.readFileSync(file, 'utf8');
  const c = cli(dir, '--check', '--root', path.join(dir, 'raw-fetch'));
  assert.equal(c.code, 1);
  assert.match(c.out, /\[unverifiable\]/);
  const w = cli(dir, '--root', path.join(dir, 'raw-fetch'));
  assert.equal(w.code, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('isolated publish workflow passes the independent structural check', () => {
  const dir = sandbox();
  for (const [repo, name] of [['npm-pkg', 'publish.yml'], ['native-helpers', 'publish.yml'], ['npm-pkg', 'ci.yml']]) {
    const before = fs.readFileSync(wfPath(dir, 'repos', repo, name), 'utf8');
    const rw = rewriteWorkflow(before, CFG, expected(dir));
    assert.deepEqual(rw.errors, []);
    const results = checkStructure({ before, after: rw.text, repository: CFG.repository, fetchPath: '.third-party-allowlist' });
    const failed = results.filter((x) => !x.ok);
    assert.deepEqual(failed, [], `${repo}/${name}`);
    const A = parseYaml(rw.text);
    if (name === 'publish.yml') {
      assert.deepEqual(A.jobs.guard.permissions, { contents: 'read' });
      assert.ok([].concat(A.jobs.publish.needs).includes('guard'));
      assert.deepEqual(A.jobs.publish.permissions, { contents: 'write', 'id-token': 'write' });
    }
    if (repo === 'native-helpers') assert.deepEqual(A.jobs.publish.needs, ['guard', 'helpers']);
  }
});

test('the structural check catches a broken isolation (publish still runs the fetch)', () => {
  const dir = sandbox();
  const before = fs.readFileSync(wfPath(dir, 'repos', 'npm-pkg', 'publish.yml'), 'utf8');
  const results = checkStructure({ before, after: before, repository: CFG.repository, fetchPath: '.third-party-allowlist' });
  assert.ok(results.some((x) => !x.ok && /holds no write permission|write job runs nothing/.test(x.msg)));
});

test('drift: a changed source file or a new SHA fails --check; rewriting re-pins', () => {
  const dir = sandbox();
  const roots = ['--root', path.join(dir, 'repos')];
  assert.equal(cli(dir, ...roots).code, 0);
  fs.appendFileSync(path.join(dir, 'source', 'third-party', 'allowlist.json'), ' ');
  const c = cli(dir, '--check', ...roots);
  assert.equal(c.code, 1);
  assert.match(c.out, /\[hash-drift\] third-party\/allowlist\.json/);
  const other = 'b'.repeat(40);
  const out = [];
  const code = run(['--config', path.join(dir, 'config.json'), '--source-dir', path.join(dir, 'source'), '--sha', other, '--check', ...roots], { toolDir: here, log: (s) => out.push(s) });
  assert.equal(code, 1);
  assert.match(out.join('\n'), /\[ref-drift\]/);
  assert.equal(cli(dir, ...roots).code, 0);
  assert.equal(cli(dir, '--check', ...roots).code, 0);
});

test('the verify step never spells the gate marker, so gate-graph cannot mistake it for the gate', () => {
  const lines = verifyStepLines(6, '.third-party-allowlist', { sha: SHA, hashes: Object.fromEntries(FILES.map((f) => [f, '0'.repeat(64)])), files: FILES });
  assert.ok(!lines.join('\n').includes('third-party/check.mjs'));
  assert.ok(lines.some((line) => line.trim().startsWith('node -e ')), 'the verifier uses the existing runner runtime');
});

test('the generated verify step really runs: passes on the pinned commit, fails on tamper and on a wrong SHA', () => {
  const dir = sandbox();
  const src = path.join(dir, 'checkout');
  fs.cpSync(path.join(dir, 'source'), src, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', src, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'pin');
  const sha = git('rev-parse', 'HEAD');
  const hashes = {};
  for (const f of FILES) hashes[f] = hashContent(fs.readFileSync(path.join(src, f)));
  const step = parseYaml(['steps:', ...verifyStepLines(2, 'checkout', { sha, hashes, files: FILES })].join('\n')).steps[0];
  // Windows' bash may be WSL with no Node or Windows paths. Execute the exact
  // generated JS there; Linux CI also exercises its bash quoting and wrapper.
  const script = /^node -e '([\s\S]*)'$/.exec(step.run)?.[1];
  assert.ok(script, 'generated verifier has the expected shell wrapper');
  const exec = (env) => executeVerifier(step, dir, env);

  const ok = exec({});
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /Pinned checkout verified: [0-9a-f]{40}, 3 files match/);

  const wrongSha = exec({ PIN_SHA: 'c'.repeat(40) });
  assert.equal(wrongSha.status, 1);
  assert.match(wrongSha.stdout, /::error::Pinned checkout mismatch: checkout is at/);

  fs.appendFileSync(path.join(src, 'third-party', 'allowlist.json'), '{"evil":1}');
  const tampered = exec({});
  assert.equal(tampered.status, 1);
  assert.match(tampered.stdout, /allowlist\.json sha256 is [0-9a-f]{64}, pinned/);

  fs.rmSync(path.join(src, 'third-party', 'gate-graph.mjs'));
  const missing = exec({});
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /gate-graph\.mjs sha256 is missing/);
});

test('a reviewed static pin cannot omit, invent or corrupt any executable input hash', () => {
  const hashes = Object.fromEntries(FILES.map((f) => [f, '1'.repeat(64)]));
  assert.deepEqual(resolveExpected({ files: FILES, pin: { sha: SHA, hashes } }), { sha: SHA, hashes, files: FILES });
  for (const pin of [
    { sha: 'main', hashes },
    { sha: SHA, hashes: { ...hashes, 'extra.mjs': '1'.repeat(64) } },
    { sha: SHA, hashes: { ...hashes, [FILES[1]]: undefined } },
    { sha: SHA, hashes: { ...hashes, [FILES[0]]: 'bad' } },
  ]) assert.throws(() => resolveExpected({ files: FILES, pin }), /exact hash/);
});

test('matching pin declarations cannot conceal a no-op or conditional verifier', () => {
  const dir = sandbox();
  const before = fs.readFileSync(wfPath(dir, 'repos', 'npm-pkg', 'ci.yml'), 'utf8');
  const pin = expected(dir);
  const good = rewriteWorkflow(before, CFG, pin).text;
  assert.deepEqual(checkWorkflow(good, CFG, pin).problems, []);
  for (const bad of [good.replace('node -e \u0027', 'echo \u0027'), good.replace('shell: bash', 'if: false\n        shell: bash'), good.replace('shell: bash', 'continue-on-error: true\n        shell: bash')]) {
    assert.ok(checkWorkflow(bad, CFG, pin).problems.some((p) => p.code === 'verify-body'));
  }
});

test('a nested checkout verifies from the workspace root despite a job default subdirectory', () => {
  const dir = sandbox();
  const before = fs.readFileSync(wfPath(dir, 'repos', 'npm-pkg', 'ci.yml'), 'utf8')
    .replace('    runs-on: ubuntu-latest', '    runs-on: ubuntu-latest\n    defaults:\n      run:\n        working-directory: app')
    .replace('path: .third-party-allowlist', 'path: app/.third-party-allowlist');
  const pin = expected(dir);
  const good = rewriteWorkflow(before, CFG, pin).text;
  const parsed = parseYaml(good);
  const verifier = parsed.jobs.ci.steps.find((step) => step.name === 'Verify the pinned checkout');
  assert.equal(verifier['working-directory'], '${{ github.workspace }}');
  assert.equal(verifier.env.PIN_ROOT, 'app/.third-party-allowlist');
  assert.deepEqual(checkWorkflow(good, CFG, pin).problems, []);
  assert.ok(checkWorkflow(good.replace('        working-directory: ${{ github.workspace }}\n', ''), CFG, pin).problems.some((p) => p.code === 'verify-body'));
  const checkout = path.join(dir, 'app/.third-party-allowlist');
  fs.mkdirSync(checkout, { recursive: true });
  fs.cpSync(path.join(dir, 'source'), checkout, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'pin');
  const actualSha = git('rev-parse', 'HEAD');
  const program = /^node -e '([\s\S]*)'$/.exec(verifier.run)?.[1];
  assert.ok(program);
  const execute = (cwd) => executeVerifier(verifier, dir, { PIN_SHA: actualSha }, cwd);
  assert.equal(execute(path.join(dir, 'app')).status, 1, 'the old inherited cwd cannot find this checkout');
  assert.equal(execute(dir).status, 0, 'the generated workspace-root override finds and verifies it');
});

test('job-level write permissions are what count, and an explicit write job is flagged even without id-token', () => {
  const text = [
    'on: push',
    'jobs:',
    '  docs:',
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      pages: write',
    '    steps:',
    '      - uses: actions/checkout@v7',
    '        with:',
    '          repository: Example-Org/.github',
    '          path: .x',
    '          persist-credentials: false',
    '      - run: node .x/third-party/check.mjs',
    '',
  ].join('\n');
  const c = checkWorkflow(text, CFG, null);
  assert.ok(c.problems.some((p) => p.code === 'write-permission'));
});

for (const scope of EXECUTION_CASES.scopes) {
  for (const key of EXECUTION_CASES.environmentKeys) {
    test(`refuses inherited ${scope} ${key} even when the verifier step is untouched`, () => {
      const dir = sandbox();
      const before = fs.readFileSync(wfPath(dir, 'repos', 'npm-pkg', 'ci.yml'), 'utf8');
      const pin = expected(dir);
      const good = rewriteWorkflow(before, CFG, pin).text;
      const bad = scope === 'workflow' ? good.replace('permissions:', `env:\n  ${key}: hostile\n\npermissions:`) : good.replace('    runs-on: ubuntu-latest', `    runs-on: ubuntu-latest\n    env:\n      ${key}: hostile`);
      assert.deepEqual(checkWorkflow(good, CFG, pin).problems, []);
      assert.ok(checkWorkflow(bad, CFG, pin).problems.some((p) => p.code === 'inherited-execution'));
    });
  }
  test(`refuses ${scope} defaults.run.shell and inline execution environments`, () => {
    const dir = sandbox();
    const before = fs.readFileSync(wfPath(dir, 'repos', 'npm-pkg', 'ci.yml'), 'utf8');
    const pin = expected(dir);
    const good = rewriteWorkflow(before, CFG, pin).text;
    const shell = scope === 'workflow' ? good.replace('permissions:', 'defaults:\n  run:\n    shell: bash\n\npermissions:') : good.replace('    runs-on: ubuntu-latest', '    runs-on: ubuntu-latest\n    defaults:\n      run:\n        shell: bash');
    const inline = scope === 'workflow' ? good.replace('permissions:', 'env: {NODE_OPTIONS: hostile}\npermissions:') : good.replace('    runs-on: ubuntu-latest', '    runs-on: ubuntu-latest\n    env: {NODE_OPTIONS: hostile}');
    for (const bad of [shell, inline]) assert.ok(checkWorkflow(bad, CFG, pin).problems.some((p) => p.code === 'inherited-execution'));
  });
}

test('preserves Node selections and never adds a setup-node step or derives a tool-cache path', () => {
  const dir = sandbox();
  const before = fs.readFileSync(wfPath(dir, 'repos', 'npm-pkg', 'ci.yml'), 'utf8').replace('      - name: Fetch the third-party allowlist', ['      - uses: actions/setup-node@v4', '        id: package-node', '        with:', '          node-version: ${{ matrix.node }}', '', '      - name: Fetch the third-party allowlist'].join('\n'));
  const pin = expected(dir);
  const good = rewriteWorkflow(before, CFG, pin).text;
  assert.ok(good.includes('node-version: ${{ matrix.node }}'));
  assert.equal((good.match(/uses: actions\/setup-node@/g) || []).length, (before.match(/uses: actions\/setup-node@/g) || []).length);
  assert.ok(!good.includes('tool_cache') && !good.includes('pin-checks-node') && !good.includes('PIN_NODE_'));
});

test('step env blocks startup hooks; a poisoned PATH is a demonstrated check-side threat', () => {
  const dir = sandbox();
  const checkout = path.join(dir, 'checkout');
  fs.cpSync(path.join(dir, 'source'), checkout, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.'); git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'pin');
  const sha = git('rev-parse', 'HEAD');
  const hashes = Object.fromEntries(FILES.map((file) => [file, hashContent(fs.readFileSync(path.join(checkout, file)))]));
  const step = parseYaml(['steps:', ...verifyStepLines(2, 'checkout', { sha, hashes, files: FILES })].join('\n')).steps[0];
  const nodeMarker = path.join(dir, 'node-hook-ran');
  const shellMarker = path.join(dir, 'shell-hook-ran');
  const pathMarker = path.join(dir, 'path-node-ran');
  const hook = path.join(dir, 'hook.cjs');
  fs.writeFileSync(hook, `require('node:fs').writeFileSync(${JSON.stringify(nodeMarker)}, 'ran');`);
  const bashHook = path.join(dir, 'bash-hook.sh');
  fs.writeFileSync(bashHook, `echo ran > '${shellMarker.replaceAll('\\', '/')}'\n`);
  const poison = path.join(dir, 'poison'); fs.mkdirSync(poison);
  fs.writeFileSync(path.join(poison, 'node'), `#!/bin/bash\necho ran > '${pathMarker.replaceAll('\\', '/')}'\nexit 0\n`);
  fs.chmodSync(path.join(poison, 'node'), 0o755);
  const currentPath = process.env.PATH || process.env.Path || '';
  const envFile = path.join(dir, 'github.env');
  const previous = path.join(dir, 'previous-step.sh');
  fs.writeFileSync(previous, 'echo "NODE_OPTIONS=--require=' + hook.replaceAll('\\', '/') + '" >> "$GITHUB_ENV"\n');
  const written = spawnSync(BASH, ['--noprofile', '--norc', previous.replaceAll('\\', '/')], { cwd: dir, encoding: 'utf8', timeout: 20_000, env: { ...process.env, GITHUB_ENV: envFile } });
  assert.equal(written.status, 0, written.stdout + written.stderr);
  const fromFile = fs.readFileSync(envFile, 'utf8').trim().slice('NODE_OPTIONS='.length);
  const env = { NODE_OPTIONS: fromFile, NODE_PATH: poison, BASH_ENV: bashHook.replaceAll('\\', '/'), ENV: bashHook.replaceAll('\\', '/') };
  const safe = executeVerifier(step, dir, env);
  assert.equal(safe.status, 0, safe.stdout + safe.stderr);
  assert.ok(!fs.existsSync(nodeMarker) && !fs.existsSync(shellMarker) && !fs.existsSync(pathMarker));
  const unsafe = executeVerifier({ ...step, env: { ...step.env, NODE_OPTIONS: env.NODE_OPTIONS } }, dir, env);
  assert.equal(unsafe.status, 0, unsafe.stdout + unsafe.stderr);
  assert.ok(fs.existsSync(nodeMarker), 'negative control: the same startup hook runs when it is not cleared');
  const unsafeShell = executeVerifier({ ...step, env: { ...step.env, BASH_ENV: env.BASH_ENV } }, dir, env);
  assert.equal(unsafeShell.status, 0, unsafeShell.stdout + unsafeShell.stderr);
  assert.ok(fs.existsSync(shellMarker), 'negative control: Bash really reads the inherited startup file when not cleared');
  const replaced = executeVerifier(step, dir, { ...env, PATH: poison + path.delimiter + currentPath });
  assert.equal(replaced.status, 0, replaced.stdout + replaced.stderr);
  assert.ok(fs.existsSync(pathMarker), 'negative control: PATH lookup really reaches the fake node');
});

for (const target of EXECUTION_CASES.fileWrites) {
  test(`an earlier run writing ${target} is refused, and the rewriter puts the gate ahead of it`, () => {
    const dir = sandbox();
    const pin = expected(dir);
    const before = fs.readFileSync(wfPath(dir, 'repos', 'npm-pkg', 'ci.yml'), 'utf8');
    const good = rewriteWorkflow(before, CFG, pin).text;
    const writer = target === 'GITHUB_ENV' ? 'echo "NODE_OPTIONS=--require ./hook.cjs" >> "$GITHUB_ENV"' : 'echo ./fake-node >> "$GITHUB_PATH"';
    const bad = good.replace('      - name: Fetch the third-party allowlist', `      - run: ${writer}\n\n      - name: Fetch the third-party allowlist`);
    assert.ok(checkWorkflow(bad, CFG, pin).problems.some((issue) => issue.code === 'prior-environment-write'));
    const fixed = rewriteWorkflow(bad, CFG, pin);
    assert.deepEqual(checkWorkflow(fixed.text, CFG, pin).problems, []);
    assert.ok(fixed.text.indexOf('name: Verify the pinned checkout') < fixed.text.indexOf(writer));
  });
}

test('known environment-writing setup actions follow the gate without adding a Node setup', () => {
  const dir = sandbox();
  const pin = expected(dir);
  const before = fs.readFileSync(wfPath(dir, 'repos', 'npm-pkg', 'ci.yml'), 'utf8').replace('      - name: Fetch the third-party allowlist', '      - uses: shivammathur/setup-php@v2\n        with:\n          php-version: "8.4"\n\n      - name: Fetch the third-party allowlist');
  assert.ok(checkWorkflow(before, CFG, pin).problems.some((issue) => issue.code === 'prior-environment-write'));
  const after = rewriteWorkflow(before, CFG, pin).text;
  assert.deepEqual(checkWorkflow(after, CFG, pin).problems, []);
  assert.ok(after.indexOf('Third-party dependency allowlist') < after.indexOf('shivammathur/setup-php@'));
  assert.equal((after.match(/uses: actions\/setup-node@/g) || []).length, (before.match(/uses: actions\/setup-node@/g) || []).length);
});

test('a gate moved to another job or a modified checkout cannot borrow an earlier verification', () => {
  const dir = sandbox();
  const before = fs.readFileSync(wfPath(dir, 'repos', 'npm-pkg', 'ci.yml'), 'utf8');
  const pin = expected(dir);
  const good = rewriteWorkflow(before, CFG, pin).text;
  const otherJob = good.replace('      - name: Third-party dependency allowlist', '  forged:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Third-party dependency allowlist');
  const changed = good.replace('      - name: Third-party dependency allowlist', '      - run: echo changed >> .third-party-allowlist/third-party/check.mjs\n      - name: Third-party dependency allowlist');
  const otherRoot = good.replace('node .third-party-allowlist/third-party/check.mjs', 'node .elsewhere/third-party/check.mjs');
  const indirect = good.replace('      - name: Third-party dependency allowlist', '      - run: sh scripts/unknown-io.sh\n      - name: Third-party dependency allowlist');
  for (const bad of [otherJob, changed, otherRoot, indirect]) assert.ok(checkWorkflow(bad, CFG, pin).problems.some((p) => p.code === 'gate-unverified'));
  const repeated = good.replace('node .third-party-allowlist/third-party/check.mjs --repo .', 'node .third-party-allowlist/third-party/check.mjs --repo .\n          node .third-party-allowlist/third-party/check.mjs --repo another');
  assert.deepEqual(checkWorkflow(repeated, CFG, pin).problems, [], 'the same verified gate may check several dependency trees');
  assert.ok(checkWorkflow(repeated.replace('--repo another', '--repo another\n          node .elsewhere/third-party/check.mjs --repo .'), CFG, pin).problems.some((p) => p.code === 'gate-unverified'));
});

test('a line resembling a YAML comment inside the quoted shell program cannot hide an executable change', () => {
  const dir = sandbox();
  const before = fs.readFileSync(wfPath(dir, 'repos', 'npm-pkg', 'ci.yml'), 'utf8');
  const pin = expected(dir);
  const good = rewriteWorkflow(before, CFG, pin).text;
  const bad = good.replace('          const fs = require("node:fs");', '          #\u0027 || true; echo injected; node -e \u0027\n          const fs = require("node:fs");');
  assert.notEqual(bad, good);
  assert.ok(checkWorkflow(bad, CFG, pin).problems.some((issue) => issue.code === 'verify-body'));
});

test('an artifact-producing build cannot run fetched code on behalf of a writer', () => {
  const dir = sandbox();
  const before = fs.readFileSync(wfPath(dir, 'repos-py', 'py-pkg', 'publish.yml'), 'utf8');
  const pin = expected(dir);
  assert.ok(checkWorkflow(before, CFG, pin).problems.some((p) => p.code === 'artifact-to-writer'));
  const result = rewriteWorkflow(before, CFG, pin);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(checkWorkflow(result.text, CFG, pin).problems, []);
  const after = parseYaml(result.text);
  const original = parseYaml(before);
  assert.deepEqual(after.jobs.publish, original.jobs.publish);
  assert.equal(after.jobs.build.needs, 'guard');
  assert.ok(!JSON.stringify(after.jobs.build).includes('third-party'));
  assert.deepEqual(checkStructure({ before, after: result.text, repository: CFG.repository, fetchPath: '.third-party-allowlist' }).filter((item) => !item.ok), []);
});
