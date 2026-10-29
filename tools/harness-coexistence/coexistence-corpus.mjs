import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCoexistence } from './coexistence-oracle.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(fs.readFileSync(join(directory, 'coexistence-cases.json')));
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL|PYTHONPATH|PRISM_HARNESS_AUTOLOAD|PRISM_HARNESS_TS|PRISM_COEXIST_WORK|PRISM_COEXIST_OUTPUT|PRISM_COEXIST_PHP_MUTANT|PRISM_COEXIST_REPORT)$/i.test(key)) env[key] = value;
}
env.PYTHONIOENCODING = 'utf-8';
for (const key of ['PRISM_HARNESS_AUTOLOAD', 'PRISM_HARNESS_TS', 'PRISM_COEXIST_WORK', 'PRISM_COEXIST_OUTPUT']) {
  if (!env[key]) throw Error(`Missing fixture location: ${key}`);
}
if (fs.existsSync(env.PRISM_COEXIST_OUTPUT)) throw Error('Refusing to append over another fixture run');
const commands = {
  php: [process.env.PRISM_PHP_BINARY ?? 'php', [join(process.env.PRISM_HARNESS_PHP_RUNNER, 'vendor/bin/phpunit'), '-c', join(directory, 'coexistence-phpunit.xml')]],
  ts: [process.execPath, [join(directory, 'coexistence-runner.mjs')]],
  py: [process.env.PRISM_PYTHON_BINARY ?? 'python', [join(directory, 'coexistence-runner.py')]],
};
const reports = {}, native = {};
for (const [language, [command, args]] of Object.entries(commands)) {
  const child = spawnSync(command, args, { cwd: directory, env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  native[language] = { exit: child.status, stdout: child.stdout, stderr: child.stderr };
  if (child.status !== 0 || child.error) throw Error(`${language} fixture failed: ${child.stdout}\n${child.stderr}`);
  reports[language] = language === 'php'
    ? fs.readFileSync(env.PRISM_COEXIST_OUTPUT, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
    : JSON.parse(child.stdout);
}
if (env.PRISM_COEXIST_REPORT) fs.writeFileSync(env.PRISM_COEXIST_REPORT, JSON.stringify({ reports, native }), { flag: 'wx' });
const proof = validateCoexistence(spec, reports);
console.log(JSON.stringify({ scope: 'source development; excludes attribution/erase/task-ceilings and is not published acceptance', proof, reports, native }));
