#!/usr/bin/env node
// Source checkouts establish byte provenance; SDK execution always uses normal
// registry installs in a new disposable consumer. Fixture data cannot set paths.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, delimiter, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compile } from '@particle-academy/fancy-schema';
import { satellitePolicyFailures } from './contract.mjs';
import { validatePublishedRefs, verifyPublishedSources, verifyRuntimeBytes } from './published-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === '--source-root'), 'Usage: published.mjs [--source-root <reviewed checkouts>]');
const sourceRoot = args.length ? resolve(args[1]) : resolve(root, '..');
const refs = validatePublishedRefs(JSON.parse(readFileSync(join(root, 'tools/satellite-policy/published-refs.json'))));
const document = JSON.parse(readFileSync(join(root, 'suites/satellite-policy/cases.json')));
assert(compile(JSON.parse(readFileSync(join(root, 'schema/cases.schema.json'))))(document).valid);
assert.deepEqual(satellitePolicyFailures(document), []);
assert.equal(document.cases.length, 232);
const directory = join(root, '.satellite-published');
assert(!existsSync(directory), 'Existing published evidence cannot be reused');
assert(!existsSync(join(root, '.env')), 'Library checks never load an application environment');
mkdirSync(directory);
const digest = value => createHash('sha256').update(value).digest('hex');
const env = {};
for (const [name, value] of Object.entries(process.env)) {
  if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|USERPROFILE|HOME|LANG|LC_ALL)$/i.test(name)) env[name] = value;
}
Object.assign(env, { NODE_OPTIONS: '', NODE_PATH: '', PYTHONDONTWRITEBYTECODE: '1', COMPOSER_HOME: join(directory, 'composer-home'), COMPOSER_CACHE_DIR: join(directory, 'composer-cache'), COMPOSER_NO_INTERACTION: '1' });
for (const [variable, name] of [['NPM_CONFIG_USERCONFIG', 'npm-userconfig'], ['NPM_CONFIG_GLOBALCONFIG', 'npm-globalconfig']]) {
  env[variable] = join(directory, name);
  writeFileSync(env[variable], '', { flag: 'wx' });
}
const logs = [];
function run(label, binary, arguments_, cwd = directory, extra = {}) {
  const result = spawnSync(binary, arguments_, { cwd, env: { ...env, ...extra }, encoding: 'utf8', windowsHide: true, timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  const stdout = join(directory, label + '.stdout.log');
  const stderr = join(directory, label + '.stderr.log');
  writeFileSync(stdout, result.stdout ?? '', { flag: 'wx' });
  writeFileSync(stderr, result.stderr ?? '', { flag: 'wx' });
  logs.push({ label, exit: result.status, stdoutSha256: digest(result.stdout ?? ''), stderrSha256: digest(result.stderr ?? '') });
  assert.equal(result.status, 0, 'Inspect published ' + label + ' logs');
  return result.stdout.trim();
}
let gitIndex = 0;
verifyPublishedSources(sourceRoot, refs, (cwd, arguments_) => run('source-' + (++gitIndex), 'git', arguments_, cwd));
for (const row of refs.packages) assert(!existsSync(join(sourceRoot, row.repository, '.env')));

async function registry(url, expectedHost) {
  const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, 'Exact primary registry version is required');
  assert.equal(new URL(response.url).hostname, expectedHost);
  return { url: response.url, date: response.headers.get('date'), metadata: await response.json() };
}
const registries = [];
for (const row of refs.packages) {
  let entry;
  if (row.repository.endsWith('-ts')) {
    entry = await registry('https://registry.npmjs.org/' + encodeURIComponent(row.package) + '/' + row.version, 'registry.npmjs.org');
    assert.equal(entry.metadata.name, row.package);
    assert.equal(entry.metadata.version, row.version);
    assert.equal(entry.metadata.gitHead, row.source);
    assert.equal(new URL(entry.metadata.dist.tarball).hostname, 'registry.npmjs.org');
    assert.match(entry.metadata.dist.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
  } else if (row.repository.endsWith('-py')) {
    entry = await registry('https://pypi.org/pypi/' + row.package + '/' + row.version + '/json', 'pypi.org');
    assert.equal(entry.metadata.info.name, row.package);
    assert.equal(entry.metadata.info.version, row.version);
    assert.equal(entry.metadata.urls.length, 2);
    assert.deepEqual(entry.metadata.urls.map(item => item.packagetype).sort(), ['bdist_wheel', 'sdist']);
    for (const item of entry.metadata.urls) {
      assert.equal(item.yanked, false);
      assert.equal(new URL(item.url).protocol, 'https:');
      assert.equal(new URL(item.url).hostname, 'files.pythonhosted.org');
      assert.match(item.digests.sha256, /^[a-f0-9]{64}$/);
    }
  } else {
    entry = await registry('https://repo.packagist.org/p2/' + row.package + '.json', 'repo.packagist.org');
    const item = entry.metadata.packages[row.package].find(item => item.version.replace(/^v/, '') === row.version);
    assert(item, 'Reviewed Packagist version is required');
    assert.equal(item.source.reference, row.source);
    assert.equal(item.dist.reference, row.source);
    entry = { ...entry, metadata: item };
  }
  registries.push({ repository: row.repository, ...entry });
}
writeFileSync(join(directory, 'registries.json'), JSON.stringify(registries, null, 2) + '\n', { flag: 'wx' });

const npmCli = [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(existsSync);
assert(npmCli, 'The selected Node runtime must include npm');
const tsDirectory = join(directory, 'ts');
mkdirSync(tsDirectory);
writeFileSync(join(tsDirectory, 'package.json'), JSON.stringify({ name: 'prism-published-satellite-proof', private: true, type: 'module' }) + '\n', { flag: 'wx' });
const tsRefs = refs.packages.filter(row => row.repository.endsWith('-ts'));
run('normal-npm-install', process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--cache=' + join(directory, 'npm-cache'), ...tsRefs.map(row => row.package + '@' + row.version)], tsDirectory);
const npmLock = JSON.parse(readFileSync(join(tsDirectory, 'package-lock.json')));
for (const row of tsRefs) {
  const installed = npmLock.packages['node_modules/' + row.package];
  const primary = registries.find(entry => entry.repository === row.repository).metadata;
  assert.equal(installed.version, row.version);
  assert.equal(installed.integrity, primary.dist.integrity);
  assert.equal(installed.resolved, primary.dist.tarball);
  assert.deepEqual(JSON.parse(readFileSync(join(tsDirectory, 'node_modules', row.package, 'package.json'))), JSON.parse(readFileSync(join(sourceRoot, row.repository, 'package.json'))), 'Installed exports and package metadata must match the reviewed source');
}

const phpDirectory = join(directory, 'php');
mkdirSync(phpDirectory);
const phpRefs = refs.packages.filter(row => !row.repository.endsWith('-ts') && !row.repository.endsWith('-py'));
assert.equal(phpRefs.length, 2);
writeFileSync(join(phpDirectory, 'composer.json'), JSON.stringify({ name: 'prism-proof/published-satellite', require: Object.fromEntries(phpRefs.map(row => [row.package, row.version])), config: { 'allow-plugins': false }, 'minimum-stability': 'stable', 'prefer-stable': true }, null, 2) + '\n', { flag: 'wx' });
const composerCandidates = [process.env.PRISM_POLICY_COMPOSER_PHAR, ...(env.PATH ?? Object.entries(env).find(([name]) => /^path$/i.test(name))?.[1] ?? '').split(delimiter).flatMap(directory => [join(directory, 'composer.phar'), join(directory, 'composer')])].filter(Boolean);
const composer = composerCandidates.find(file => existsSync(file) && statSync(file).isFile() && readFileSync(file).subarray(0, 128).toString().includes('<?php'));
assert(composer, 'A configured Composer PHAR is required');
run('normal-composer-install', 'php', [composer, 'update', '--no-interaction', '--no-dev', '--no-scripts', '--no-plugins', '--prefer-dist'], phpDirectory);
const composerLock = JSON.parse(readFileSync(join(phpDirectory, 'composer.lock')));
for (const row of phpRefs) {
  const installed = composerLock.packages.find(item => item.name === row.package);
  assert(installed);
  assert.equal(installed.version.replace(/^v/, ''), row.version);
  assert.equal(installed.source.reference, row.source);
  assert.equal(installed.dist.reference, row.source);
  assert.deepEqual(JSON.parse(readFileSync(join(phpDirectory, 'vendor', row.package, 'composer.json'))), JSON.parse(readFileSync(join(sourceRoot, row.repository, 'composer.json'))), 'Installed autoload metadata must match the reviewed source');
}

const pyDirectory = join(directory, 'py');
run('fresh-python-consumer', 'python', ['-m', 'venv', pyDirectory]);
const python = join(pyDirectory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const pyRefs = refs.packages.filter(row => row.repository.endsWith('-py'));
run('normal-pypi-install', python, ['-m', 'pip', '--isolated', 'install', '--no-cache-dir', '--no-deps', '--only-binary=:all:', '--index-url', 'https://pypi.org/simple', '--report', join(directory, 'pip-report.json'), ...pyRefs.map(row => row.package + '==' + row.version)]);
run('pip-check', python, ['-m', 'pip', 'check']);
const pipReport = JSON.parse(readFileSync(join(directory, 'pip-report.json')));
assert.equal(pipReport.install.length, 2);
const modules = new Map([['prism-browser-py', 'prism_browser'], ['prism-human-plus-py', 'prism_human_plus']]);
const pyRoots = new Map();
for (const row of pyRefs) {
  const installed = pipReport.install.find(item => item.metadata.name.replaceAll('_', '-').toLowerCase() === row.package.toLowerCase());
  assert(installed);
  const wheel = registries.find(entry => entry.repository === row.repository).metadata.urls.find(item => item.packagetype === 'bdist_wheel');
  assert.equal(installed.metadata.version, row.version);
  assert.equal(installed.download_info.url, wheel.url);
  assert.equal(installed.download_info.archive_info.hashes.sha256, wheel.digests.sha256);
  const module = modules.get(row.repository);
  const identity = JSON.parse(run(row.repository + '-identity', python, ['-I', '-c', 'import importlib,importlib.metadata,json;m=importlib.import_module(' + JSON.stringify(module) + ');print(json.dumps({"version":importlib.metadata.version(' + JSON.stringify(row.package) + '),"file":m.__file__}))']));
  assert.equal(identity.version, row.version);
  const loaded = realpathSync(identity.file);
  assert(loaded.startsWith(realpathSync(pyDirectory) + (process.platform === 'win32' ? '\\' : '/')), 'Python must load the normal installed distribution');
  pyRoots.set(row.repository, dirname(loaded));
}

function files(directory, { python = false } = {}) {
  const result = new Map();
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (python && entry.name === '__pycache__') continue;
      const full = join(current, entry.name);
      assert(!lstatSync(full).isSymbolicLink(), 'Runtime symlinks are not accepted');
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && !(python && entry.name.endsWith('.pyc'))) result.set(relative(directory, full).replaceAll('\\', '/'), readFileSync(full));
      else assert(entry.isFile(), 'Unsupported runtime entry');
    }
  }
  walk(directory);
  assert(result.size > 0, 'A zero-file runtime cannot prove provenance');
  return result;
}
function runtimeCensus() {
  return refs.packages.map(row => {
    const source = join(sourceRoot, row.repository);
    const isPython = row.repository.endsWith('-py');
    const sourcePath = isPython ? join(source, 'src', modules.get(row.repository)) : join(source, row.repository.endsWith('-ts') ? 'dist' : 'src');
    const installedPath = isPython ? pyRoots.get(row.repository) : row.repository.endsWith('-ts') ? join(tsDirectory, 'node_modules', row.package, 'dist') : join(phpDirectory, 'vendor', row.package, 'src');
    const expected = files(sourcePath, { python: isPython });
    const installed = files(installedPath, { python: isPython });
    if (!isPython && !row.repository.endsWith('-ts') && existsSync(join(source, 'sidecar'))) {
      const sourceSidecar = files(join(source, 'sidecar'));
      const installedSidecar = files(join(phpDirectory, 'vendor', row.package, 'sidecar'));
      for (const [name, raw] of sourceSidecar) expected.set('sidecar/' + name, raw);
      for (const [name, raw] of installedSidecar) installed.set('sidecar/' + name, raw);
    }
    const normalized = verifyRuntimeBytes(expected, installed);
    return { repository: row.repository, runtimeFiles: installed.size, rawIdentical: installed.size - normalized.length, onlyCRLFNormalization: normalized, files: Object.fromEntries([...installed].map(([name, raw]) => [name, digest(raw)])) };
  });
}
const before = runtimeCensus();
writeFileSync(join(directory, 'runtime-before.json'), JSON.stringify(before, null, 2) + '\n', { flag: 'wx' });
for (const row of tsRefs) {
  const resolved = run(row.repository + '-identity', process.execPath, ['--input-type=module', '-e', 'console.log(import.meta.resolve(' + JSON.stringify(row.package) + '));'], tsDirectory);
  assert.equal(realpathSync(fileURLToPath(resolved)), realpathSync(join(tsDirectory, 'node_modules', row.package, 'dist/index.js')));
}
const autoload = join(phpDirectory, 'vendor/autoload.php');
assert(existsSync(autoload));
const nativeEnvironment = {
  PRISM_POLICY_BROWSER_AUTOLOAD: autoload,
  PRISM_POLICY_HUMAN_AUTOLOAD: autoload,
  PRISM_POLICY_BROWSER_TS_DIST: join(tsDirectory, 'node_modules/@particle-academy/prism-browser/dist/index.js'),
  PRISM_POLICY_HUMAN_TS_DIST: join(tsDirectory, 'node_modules/@particle-academy/prism-human-plus/dist/index.js'),
  PRISM_POLICY_PY_BINARY: python,
  PRISM_POLICY_BROWSER_PY_SRC: dirname(pyRoots.get('prism-browser-py')),
  PRISM_POLICY_HUMAN_PY_SRC: dirname(pyRoots.get('prism-human-plus-py')),
};
const observations = [];
for (const language of ['php', 'ts', 'py']) {
  const output = run('native-' + language, process.execPath, [join(root, 'tools/run-gate.mjs'), 'satellitePolicy', '--', process.execPath, join(root, 'tools/satellite-policy.mjs'), language, '--check'], root, nativeEnvironment);
  assert.match(output, new RegExp('satellite-policy ' + language + ': 232 executed; 0 changed; independent predictions and check passed\\.'));
  process.stdout.write(output + '\n');
  observations.push({ language, cases: 232, exit: 0 });
}
const after = runtimeCensus();
assert.deepEqual(after, before, 'SDK runtime changed during native observations');
writeFileSync(join(directory, 'runtime-after.json'), JSON.stringify(after, null, 2) + '\n', { flag: 'wx' });
const npmAudit = JSON.parse(run('npm-audit', process.execPath, [npmCli, 'audit', '--omit=dev', '--json'], tsDirectory));
assert.equal(npmAudit.metadata.vulnerabilities.total, 0);
const composerAudit = JSON.parse(run('composer-audit', 'php', [composer, 'audit', '--format=json'], phpDirectory));
assert.equal(Object.keys(composerAudit.advisories ?? {}).length, 0);
verifyPublishedSources(sourceRoot, refs, (cwd, arguments_) => run('source-after-' + (++gitIndex), 'git', arguments_, cwd));
const report = {
  referenceKind: 'published-artifact',
  platform: process.platform,
  packages: refs.packages,
  normalFreshConsumers: true,
  sourceOverride: false,
  observations: 696,
  rows: observations,
  runtimes: before.map(({ files, ...row }) => row),
  installedRuntimeUnchanged: true,
  publishedReferenceVerified: true,
  registriesSha256: digest(readFileSync(join(directory, 'registries.json'))),
  npmLockSha256: digest(readFileSync(join(tsDirectory, 'package-lock.json'))),
  composerLockSha256: digest(readFileSync(join(phpDirectory, 'composer.lock'))),
  pipReportSha256: digest(readFileSync(join(directory, 'pip-report.json'))),
  logs,
};
writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log('Satellite published artifacts passed: 232 cases in each language; 696 observations; immutable runtimes verified.');
