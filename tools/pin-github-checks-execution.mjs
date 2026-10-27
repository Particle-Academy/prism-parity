// Execution controls that must be inspected outside the verifier step itself.
const dangerous = /^(?:PATH|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH)$/i;
const blank = (line) => !line.trim() || line.trimStart().startsWith('#');
const indent = (line) => line.match(/^ */)[0].length;

function section(lines, start, end, level, key) {
  const at = lines.findIndex((line, index) => index >= start && index < end && indent(line) === level && line.trimStart().startsWith(key + ':'));
  if (at === -1) return null;
  let stop = at + 1;
  while (stop < end && (blank(lines[stop]) || indent(lines[stop]) > level)) stop++;
  const inline = lines[at].trim().slice(key.length + 1).trim();
  return { at, end: stop, inline, lines: lines.slice(at + 1, stop) };
}

export function executionScope(wf, job) {
  const jobsAt = wf.lines.findIndex((line) => /^jobs:/.test(line));
  const scopes = [{ start: 0, end: jobsAt < 0 ? wf.lines.length : jobsAt, level: 0, name: 'workflow' }, { start: job.header + 1, end: job.end, level: job.indent + 2, name: `job ${job.name}` }];
  const problems = [];
  let workingDirectory = '';
  for (const scope of scopes) {
    const env = section(wf.lines, scope.start, scope.end, scope.level, 'env');
    if (env) {
      if (env.inline && env.inline !== '{}') problems.push(`${scope.name} has an inline or dynamic env mapping that cannot be audited`);
      for (const line of env.lines) {
        if (blank(line) || indent(line) !== scope.level + 2) continue;
        const key = line.trim().match(/^["']?([A-Za-z_][A-Za-z0-9_]*)["']?:/);
        if (!key) problems.push(`${scope.name} has an unsupported env key`);
        else if (dangerous.test(key[1])) problems.push(`${scope.name} sets execution hook ${key[1]}`);
      }
    }
    const defaults = section(wf.lines, scope.start, scope.end, scope.level, 'defaults');
    if (!defaults) continue;
    if (defaults.inline && defaults.inline !== '{}') problems.push(`${scope.name} has unsupported inline or dynamic defaults`);
    const run = section(wf.lines, defaults.at + 1, defaults.end, scope.level + 2, 'run');
    if (!run) continue;
    if (run.inline && run.inline !== '{}') problems.push(`${scope.name} has unsupported inline run defaults`);
    for (const line of run.lines) {
      if (blank(line) || indent(line) !== scope.level + 4) continue;
      const match = /^\s*([\w-]+):\s*(.*?)\s*$/.exec(line);
      if (!match) { problems.push(`${scope.name} has unsupported run defaults`); continue; }
      if (match[1] === 'shell') problems.push(`${scope.name} sets defaults.run.shell`);
      if (match[1] === 'working-directory') workingDirectory = match[2].replace(/^["']|["']$/g, '');
    }
  }
  return { problems, workingDirectory };
}

// These setup actions export PATH/environment state. Checkout and setup-node
// are the explicit trusted exceptions; no new setup action is added by this tool.
const environmentWriters = /^(?:shivammathur\/setup-php|actions\/setup-(?:python|go|java|dotnet)|dtolnay\/rust-toolchain|actions-rust-lang\/setup-rust-toolchain)@/i;

export function priorEnvironmentWrites(wf, job, before, parseStep) {
  const writers = [];
  for (let index = 0; index < before; index++) {
    const step = parseStep(wf.lines, job.steps[index]);
    if (/GITHUB_(?:ENV|PATH)/i.test(step.run) || environmentWriters.test(step.uses || '')) writers.push({ index, name: step.name || step.uses || `run step ${index + 1}` });
  }
  return writers;
}

export function stepExecutionHooks(step) {
  return Object.keys(step.env || {}).filter((key) => dangerous.test(key));
}
