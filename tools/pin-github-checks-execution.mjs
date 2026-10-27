// Execution controls that must be inspected outside the verifier step itself.
const dangerous = /^(?:PATH|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|ACTIONS_ALLOW_UNSECURE_COMMANDS|BASH_FUNC_.*)$/i;
const blank = (line) => !line.trim() || line.trimStart().startsWith('#');
const indent = (line) => line.match(/^ */)[0].length;

function section(lines, start, end, level, key) {
  const pattern = new RegExp(`^(?:${key}|"${key}"|'${key}')\\s*:`);
  const at = lines.findIndex((line, index) => index >= start && index < end && indent(line) === level && pattern.test(line.trimStart()));
  if (at === -1) return null;
  let stop = at + 1;
  while (stop < end && (blank(lines[stop]) || indent(lines[stop]) > level)) stop++;
  const inline = lines[at].trim().replace(pattern, '').trim();
  return { at, end: stop, inline, lines: lines.slice(at + 1, stop) };
}

function environmentProblems(lines, start, end, level, name) {
  const env = section(lines, start, end, level, 'env');
  if (!env) return [];
  const problems = [];
  if (env.inline && env.inline !== '{}') problems.push(`${name} has a non-literal env mapping`);
  const keys = new Set();
  let blockValue = false;
  for (const line of env.lines) {
    if (blank(line)) continue;
    if (indent(line) !== level + 2) {
      if (!blockValue) problems.push(`${name} has an env mapping that cannot be read statically`);
      continue;
    }
    const match = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_%]*|<<))\s*:\s*(.*)$/.exec(line);
    blockValue = false;
    if (!match) { problems.push(`${name} has an unsupported env key`); continue; }
    const key = match[1] ?? match[2] ?? match[3];
    if (key === '<<') problems.push(`${name} has a YAML merge key in env`);
    else if (dangerous.test(key)) problems.push(`${name} sets execution hook ${key}`);
    if (keys.has(key.toUpperCase())) problems.push(`${name} repeats an env key under Windows case folding`);
    keys.add(key.toUpperCase());
    blockValue = /^[|>][-+]?(?:\s+#.*)?$/.test(match[4]);
  }
  const declarations = lines.slice(start, end).filter(line => indent(line) === level && /^(?:env|"env"|'env')\s*:/.test(line.trimStart()));
  if (declarations.length !== 1) problems.push(`${name} has duplicate env mappings`);
  return problems;
}

function stepScope(wf, job, index) {
  const step = job.steps[index];
  const lines = wf.lines.slice(step.start, step.end);
  lines[0] = lines[0].replace(/^(\s*)- /, '$1  ');
  return { lines, level: indent(wf.lines[step.start]) + 2 };
}

export function stepEnvironmentProblems(wf, job, index) {
  const { lines, level } = stepScope(wf, job, index);
  return environmentProblems(lines, 0, lines.length, level, `step ${index + 1}`);
}

export function gateStepContextProblems(wf, job, index) {
  const { lines, level } = stepScope(wf, job, index);
  const problems = [];
  for (const key of ['env', 'shell']) {
    if (section(lines, 0, lines.length, level, key)) problems.push(`gate step ${index + 1} declares ${key}`);
  }
  return problems;
}

export function executionScope(wf, job) {
  const jobsAt = wf.lines.findIndex((line) => /^jobs:/.test(line));
  const scopes = [{ start: 0, end: jobsAt < 0 ? wf.lines.length : jobsAt, level: 0, name: 'workflow' }, { start: job.header + 1, end: job.end, level: job.indent + 2, name: `job ${job.name}` }];
  const problems = [];
  let workingDirectory = '';
  for (const scope of scopes) {
    problems.push(...environmentProblems(wf.lines, scope.start, scope.end, scope.level, scope.name));
    if (wf.lines.slice(scope.start, scope.end).some(line => indent(line) === scope.level && /^\s*(?:<<|"<<"|'<<')\s*:/.test(line))) problems.push(`${scope.name} has a YAML merge key`);
    if (scope.name !== 'workflow' && section(wf.lines, scope.start, scope.end, scope.level, 'container')) problems.push(`${scope.name} declares a container`);
    const defaults = section(wf.lines, scope.start, scope.end, scope.level, 'defaults');
    if (!defaults) continue;
    if (defaults.inline && defaults.inline !== '{}') problems.push(`${scope.name} has unsupported inline or dynamic defaults`);
    for (const line of defaults.lines) {
      if (blank(line) || indent(line) !== scope.level + 2) continue;
      if (!/^\s*(?:run|"run"|'run')\s*:/.test(line)) problems.push(`${scope.name} has unsupported run defaults`);
    }
    const run = section(wf.lines, defaults.at + 1, defaults.end, scope.level + 2, 'run');
    if (!run) continue;
    if (run.inline && run.inline !== '{}') problems.push(`${scope.name} has unsupported inline run defaults`);
    for (const line of run.lines) {
      if (blank(line) || indent(line) !== scope.level + 4) continue;
      const match = /^\s*([\w-]+):\s*(.*?)\s*$/.exec(line);
      if (!match) { problems.push(`${scope.name} has unsupported run defaults`); continue; }
      if (match[1] === 'shell') problems.push(`${scope.name} sets defaults.run.shell`);
      if (match[1] === 'working-directory') workingDirectory = match[2].replace(/^["']|["']$/g, '');
      else if (match[1] !== 'shell') problems.push(`${scope.name} has unsupported run defaults`);
    }
  }
  return { problems, workingDirectory };
}

// Any program can export environment state indirectly. Only these two actions
// precede the block; its own exact verifier is the sole trusted run exception.
const trustedSetup = /^actions\/(?:checkout|setup-node)@/i;

export function priorEnvironmentWrites(wf, job, before, parseStep, trustedVerifier = () => false) {
  const writers = [];
  for (let index = 0; index < before; index++) {
    const step = parseStep(wf.lines, job.steps[index]);
    if (trustedVerifier(index)) continue;
    const envProblems = stepEnvironmentProblems(wf, job, index);
    if (step.run.trim() || !trustedSetup.test(step.uses || '') || envProblems.length) writers.push({ index, name: step.name || step.uses || `run step ${index + 1}`, problems: envProblems });
  }
  return writers;
}

export function stepExecutionHooks(step) {
  return Object.keys(step.env || {}).filter((key) => dangerous.test(key));
}
