import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCoexistence } from './coexistence-oracle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(fs.readFileSync(join(here, 'coexistence-cases.json')));
const work = process.env.PRISM_COEXIST_WORK;
assert(work && !fs.existsSync(work), 'Sabotage requires a new owned directory');
fs.mkdirSync(work, { recursive: true });
const phpRoot = process.env.PRISM_HARNESS_PHP_RUNNER, tsRoot = process.env.PRISM_HARNESS_TS;
const pyRoot = process.env.PYTHONPATH;
assert(phpRoot && tsRoot && pyRoot, 'Explicit candidate locations are required');
const hash = value => createHash('sha256').update(value).digest('hex');
const records = [], inputs = new Map();
const mutations = {
  php: {
    policy: { file: join(phpRoot, 'src/Tools/ToolAuthorizer.php'), find: 'return $this->gate->forUser($session->actor())->allows($this->callAbility, [$session, $tool, $arguments]);', replace: 'return true;', expected: 'php/order0: child rechecks call_revoked' },
    actor: { file: join(phpRoot, 'src/Participants/ParticipantAdapters.php'), find: 'return $inheritedActor ?? $resolve($participant);', replace: 'return $resolve($participant);', expected: 'php/order0/charlotte: child inherits bound authority' },
    collision: { file: join(phpRoot, 'src/Tools/ToolRegistry.php'), find: "        } elseif ($this->strict() && $previous !== null) {\n            throw new RegistrationCollision($this->agent, $name, $previous['owner'], $label);\n        }", replace: "        }", expected: 'php/order0/same-owner-static: duplicate registration refused' },
    scope: { file: join(phpRoot, 'src/Tools/ToolRegistry.php'), find: "            if ($this->agent !== null) {\n                throw new LogicException('Harness registry/session agent mismatch.');\n            }\n", replace: '', expected: 'php/order0/charlotte: bound registry must reject foreign session' },
    unlisted: { file: join(phpRoot, 'src/AgentRuntime.php'), find: "            $names = $this->toolNamesFor($mode, $requested, $view->agent() !== null);", replace: "            $names = $this->toolNamesFor($mode, $requested, $view->agent() !== null);\n            $names[] = 'internal_notes';", expected: 'php/order0/charlotte: exact inspection authority' },
  },
  ts: {
    policy: { file: join(tsRoot, 'dist/tools.js'), find: 'return this.#call(session, tool, args);', replace: 'return true;', expected: 'ts/order0: child rechecks call_revoked' },
    child: { file: join(tsRoot, 'dist/subagent-runner.js'), find: "                if (parent.agent !== null && Object.keys(args).some(key => key !== 'task')) {\n                    throw HarnessError.runNotPermitted('Named subagent input may contain only task. Identity changes require an explicit host-owned delegation binding.');\n                }\n", replace: '', expected: 'ts/order0: child cannot request a different actor' },
    actor: { file: join(tsRoot, 'dist/address.js'), find: 'const actor = inheritedActor ?? resolve(participant);', replace: 'const actor = resolve(participant);', expected: 'ts/order0/charlotte: child inherits bound authority' },
    collision: { file: join(tsRoot, 'dist/tools.js'), find: "        else if (this.#strict() && previous)\n            throw new RegistrationCollision(this.namespace, name, previous.owner, label);\n", replace: '', expected: 'ts/order0/same-owner-static: duplicate registration refused' },
    scope: { file: join(tsRoot, 'dist/tools.js'), find: "            if (this.namespace !== null)\n                throw new Error('Harness registry/session agent mismatch.');\n", replace: '', expected: 'ts/order0/charlotte: bound registry must reject foreign session' },
    unlisted: { file: join(tsRoot, 'dist/runtime.js'), find: 'const detailed = await this.#tools.resolveDetailed(names, view);', replace: "const detailed = await this.#tools.resolveDetailed([...names, 'internal_notes'], view);", expected: 'ts/order0/charlotte: exact inspection authority' },
  },
  py: {
    policy: { file: join(pyRoot, 'prism_harness/tools.py'), find: 'return self._call(session, tool, args)', replace: 'return True', expected: 'py/order0: child rechecks call_revoked' },
    child: { file: join(pyRoot, 'prism_harness/subagent_runner.py'), find: '        if self._parent.agent is not None and any(key != "task" for key in args):\n            raise HarnessError.run_not_permitted(\n                "Named subagent input may contain only task. Identity changes require an explicit host-owned delegation binding."\n            )\n', replace: '', expected: 'py/order0: child cannot request a different actor' },
    actor: { file: join(pyRoot, 'prism_harness/address.py'), find: 'actor = resolve(participant) if inherited_actor is None else inherited_actor', replace: 'actor = resolve(participant)', expected: 'py/order0/charlotte: child inherits bound authority' },
    collision: { file: join(pyRoot, 'prism_harness/tools.py'), find: '        elif self._strict() and previous is not None:\n            raise RegistrationCollision(self._agent, name, previous[0], label)\n', replace: '', expected: 'py/order0/same-owner-static: duplicate registration refused' },
    scope: { file: join(pyRoot, 'prism_harness/tools.py'), find: '            if self._agent is not None:\n                raise ValueError("Harness registry/session agent mismatch.")\n', replace: '', expected: 'py/order0/charlotte: bound registry must reject foreign session' },
    unlisted: { file: join(pyRoot, 'prism_harness/runtime.py'), find: 'detailed = self._tools.resolve_detailed(names, view)', replace: 'detailed = self._tools.resolve_detailed([*names, "internal_notes"], view)', expected: 'py/order0/charlotte: exact inspection authority' },
  },
};

function run(name, alter) {
  const directory = join(work, name);
  fs.mkdirSync(directory);
  const env = { ...process.env, PRISM_COEXIST_WORK: directory, PRISM_COEXIST_OUTPUT: join(directory, 'php.jsonl'), PRISM_COEXIST_REPORT: join(directory, 'native.json') };
  delete env.PRISM_COEXIST_PHP_MUTANT;
  const binding = alter?.(directory, env);
  const result = spawnSync(process.execPath, [join(here, 'coexistence-corpus.mjs')], { env, cwd: here, encoding: 'utf8', timeout: 180000, windowsHide: true, maxBuffer: 12 * 1024 * 1024 });
  const log = join(directory, 'run.log');
  fs.writeFileSync(log, result.stdout + '\n' + result.stderr, { flag: 'wx' });
  assert(!result.error, name + ': fixture process must execute normally');
  assert(fs.existsSync(env.PRISM_COEXIST_REPORT), name + ': all three native applications must finish, even for sabotage');
  return { directory, reports: JSON.parse(fs.readFileSync(env.PRISM_COEXIST_REPORT)).reports, exit: result.status, output: result.stdout + '\n' + result.stderr, binding, log };
}

const positive = run('positive');
assert.equal(positive.exit, 0, positive.output);
const proof = validateCoexistence(spec, positive.reports);
records.push({ name: 'positive', exit: 0, proof, log: positive.log, log_sha256: hash(fs.readFileSync(positive.log)) });
console.log(JSON.stringify({ name: 'positive', ...proof }));
for (const [language, definitions] of Object.entries(mutations)) {
  for (const [kind, mutation] of Object.entries(definitions)) {
    const current = fs.readFileSync(mutation.file), normalized = current.toString('utf8').replaceAll('\r\n', '\n');
    assert.equal(normalized.split(mutation.find).length, 2, language + '/' + kind + ': bind exactly one production guard');
    inputs.set(mutation.file, hash(current));
    const changed = normalized.replace(mutation.find, mutation.replace);
    const result = run(language + '-' + kind, (directory, env) => {
      let target;
      if (language === 'php') {
        target = join(directory, kind === 'policy' ? 'ToolAuthorizer.php' : (kind === 'actor' ? 'ParticipantAdapters.php' : (kind === 'unlisted' ? 'AgentRuntime.php' : 'ToolRegistry.php')));
        env.PRISM_COEXIST_PHP_MUTANT = target;
      } else if (language === 'ts') {
        const candidate = join(directory, 'ts-mutant');
        fs.cpSync(join(tsRoot, 'dist'), join(candidate, 'dist'), { recursive: true });
        fs.writeFileSync(join(candidate, 'package.json'), '{"type":"module"}', { flag: 'wx' });
        target = join(candidate, 'dist', kind === 'child' ? 'subagent-runner.js' : (kind === 'actor' ? 'address.js' : (kind === 'unlisted' ? 'runtime.js' : 'tools.js')));
        env.PRISM_HARNESS_TS = candidate;
      } else {
        const candidate = join(directory, 'py-mutant');
        fs.cpSync(join(pyRoot, 'prism_harness'), join(candidate, 'prism_harness'), { recursive: true, filter: path => !path.includes('__pycache__') && !path.endsWith('.pyc') });
        target = join(candidate, 'prism_harness', kind === 'child' ? 'subagent_runner.py' : (kind === 'actor' ? 'address.py' : (kind === 'unlisted' ? 'runtime.py' : 'tools.py')));
        env.PYTHONPATH = candidate;
      }
      fs.writeFileSync(target, changed);
      return { source: mutation.file, source_sha256: hash(current), mutant: target, mutant_sha256: hash(changed), operation: kind };
    });
    assert.notEqual(result.exit, 0, language + '/' + kind + ': sabotage must fail');
    assert(result.output.includes(mutation.expected), language + '/' + kind + ': rejection must come from the expected independent oracle assertion, not syntax/import/test setup');
    validateCoexistence(spec, { ...result.reports, [language]: positive.reports[language] });
    records.push({ name: language + '-' + kind, exit: result.exit, expected_oracle: mutation.expected, binding: result.binding, log: result.log, log_sha256: hash(fs.readFileSync(result.log)), other_languages_safe: true });
    console.log(JSON.stringify({ name: language + '-' + kind, rejectedByOracle: true, otherLanguagesSafe: true }));
    fs.writeFileSync(join(work, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), scope: 'source-only real production-code copies; originals unchanged', records }, null, 2));
  }
}
for (const [file, original] of inputs) assert.equal(hash(fs.readFileSync(file)), original, 'Original candidate must remain unchanged: ' + file);
const expected = Object.values(mutations).reduce((total, cases) => total + Object.keys(cases).length, 0);
const receipt = { at: new Date().toISOString(), scope: 'partial tranche1-2 source fixture, not release acceptance', proof, sabotage: { expected, rejected: records.length - 1, originals_unchanged: true }, records };
fs.writeFileSync(join(work, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ receipt: join(work, 'receipt.json'), sha256: hash(fs.readFileSync(join(work, 'receipt.json'))), sabotage: receipt.sabotage }));
