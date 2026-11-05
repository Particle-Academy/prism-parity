// Normal registry consumers only. Source checkouts supply no executing MCP SDK.
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {validatePublishedRefs, verifyPublishedFiles} from './published-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const refs = validatePublishedRefs(JSON.parse(readFileSync(join(root, 'tools/mcp-behavior/published-refs.json'), 'utf8')));
for (const key of ['PRISM_MCP_AUTOLOAD', 'PRISM_MCP_TS_DIST', 'PRISM_MCP_PY_SRC', 'PYTHONPATH']) assert(!process.env[key], `${key} cannot override a published consumer`);
const directory = join(root, '.mcp-published');
assert(!existsSync(directory), 'Use a fresh checkout: an existing consumer cannot supply new published evidence');
mkdirSync(directory);
const env = {...process.env, PYTHONDONTWRITEBYTECODE:'1'};
const php = process.env.PRISM_MCP_PHP_BINARY ?? 'php';
const python = process.env.PRISM_MCP_PY_BINARY ?? 'python';
const composer = process.env.PRISM_MCP_COMPOSER_PHAR;
const npm = [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(existsSync);
assert(npm, 'The normal npm CLI must be installed alongside Node');
const rows = [];
function run(label, bin, args, cwd, extra = {}) {
  const result = spawnSync(bin, args, {cwd, env:{...env,...extra}, encoding:'utf8', timeout:300000, maxBuffer:16*1024*1024, windowsHide:true});
  writeFileSync(join(directory, label + '.stdout.log'), result.stdout ?? '', {flag:'wx'});
  writeFileSync(join(directory, label + '.stderr.log'), result.stderr ?? '', {flag:'wx'});
  assert.equal(result.status, 0, `${label} failed; inspect .mcp-published logs`);
  const digest = value => createHash('sha256').update(value ?? '').digest('hex');
  rows.push({label, exit:result.status, stdoutSha256:digest(result.stdout), stderrSha256:digest(result.stderr)});
  return result.stdout;
}
const phpRoot = join(directory, 'php'); mkdirSync(phpRoot);
writeFileSync(join(phpRoot, 'composer.json'), JSON.stringify({name:'prism-proof/mcp-published',require:{'particle-academy/prism-mcp':refs.php.version},config:{'allow-plugins':false},'minimum-stability':'stable','prefer-stable':true}) + '\n', {flag:'wx'});
run('php-install', composer ? php : 'composer', [...(composer ? [composer] : []), 'update', '--no-dev', '--no-scripts', '--prefer-dist', '--no-interaction'], phpRoot);
const phpPackage = JSON.parse(readFileSync(join(phpRoot, 'composer.lock'))).packages.find(p => p.name === 'particle-academy/prism-mcp');
assert(phpPackage); assert.equal(phpPackage.version.replace(/^v/, ''), refs.php.version); assert.equal(phpPackage.source.reference, refs.php.source); assert.equal(phpPackage.dist.reference, refs.php.source);
const phpDirectory = join(phpRoot, 'vendor/particle-academy/prism-mcp');
verifyPublishedFiles(phpDirectory, refs.php.files);

const tsRoot = join(directory, 'ts'); mkdirSync(tsRoot);
writeFileSync(join(tsRoot, 'package.json'), JSON.stringify({name:'prism-proof-mcp-published',private:true,type:'module'}) + '\n', {flag:'wx'});
run('ts-install', process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', `@particle-academy/prism-mcp@${refs.ts.version}`], tsRoot);
const tsPackage = JSON.parse(readFileSync(join(tsRoot, 'package-lock.json'))).packages['node_modules/@particle-academy/prism-mcp'];
assert.equal(tsPackage.version, refs.ts.version); assert.equal(tsPackage.integrity, refs.ts.integrity); assert.equal(tsPackage.resolved, refs.ts.tarball);
const tsDirectory = join(tsRoot, 'node_modules/@particle-academy/prism-mcp');
verifyPublishedFiles(join(tsDirectory, 'dist'), refs.ts.files, 'dist/');

const pyRoot = join(directory, 'py');
run('py-venv', python, ['-m', 'venv', pyRoot], directory);
const pyBinary = join(pyRoot, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
run('py-install', pyBinary, ['-m', 'pip', 'install', '--no-cache-dir', '--no-compile', '--no-deps', '--only-binary=:all:', '--index-url', 'https://pypi.org/simple', '--report', join(directory, 'pip-report.json'), `prism-ai-mcp==${refs.py.version}`], directory);
const pip = JSON.parse(readFileSync(join(directory, 'pip-report.json'))); assert.equal(pip.install.length, 1);
assert.equal(pip.install[0].metadata.name, 'prism-ai-mcp'); assert.equal(pip.install[0].metadata.version, refs.py.version);
assert.equal(pip.install[0].download_info.url, refs.py.wheel.url); assert.equal(pip.install[0].download_info.archive_info.hashes.sha256, refs.py.wheel.sha256);
const site = run('py-site', pyBinary, ['-B', '-I', '-c', 'import sysconfig; print(sysconfig.get_paths()["purelib"])'], directory).trim();
const pyDirectory = join(site, 'prism_mcp');
verifyPublishedFiles(pyDirectory, refs.py.files, 'prism_mcp/');

const nativeEnv = {PRISM_MCP_AUTOLOAD:join(phpRoot, 'vendor/autoload.php'),PRISM_MCP_PHP_BINARY:php,PRISM_MCP_TS_DIST:join(tsDirectory,'dist/index.js'),PRISM_MCP_PY_BINARY:pyBinary};
for (const language of ['php', 'ts', 'py']) {
  const output = run('native-' + language, process.execPath, [join(root,'tools/run-gate.mjs'),'mcpBehavior','--',process.execPath,join(root,'tools/mcp-behavior.mjs'),language,'--check'], root, nativeEnv);
  assert.match(output, new RegExp(`mcp-behavior ${language}: 42 executed; 0 changed; independent predictions and check passed\\.`));
  process.stdout.write(output);
}
verifyPublishedFiles(phpDirectory, refs.php.files);
verifyPublishedFiles(join(tsDirectory, 'dist'), refs.ts.files, 'dist/');
verifyPublishedFiles(pyDirectory, refs.py.files, 'prism_mcp/');
writeFileSync(join(directory, 'report.json'), JSON.stringify({status:'PASS',versions:{php:refs.php.version,ts:refs.ts.version,py:refs.py.version},sources:{php:refs.php.source,ts:refs.ts.source,py:refs.py.source},casesPerLanguage:42,sourceOverride:false,runtimeVerifiedBeforeAndAfter:true,refs,installedMetadata:{php:phpPackage,ts:tsPackage,py:pip.install[0]},rows}, null, 2) + '\n', {flag:'wx'});
