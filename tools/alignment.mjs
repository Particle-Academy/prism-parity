#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compareClaims, unmarkedCounts, requireVerdict, checkWorkflowDependencies, COORDINATOR_EXEMPT } from './alignment-contracts.mjs';
import { gates } from './gate-contracts.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const write = process.argv.includes('--write');
const failures = [];

function gate(name, args) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  requireVerdict(name, result, gates[name]);
  process.stderr.write(result.stderr ?? '');
  if (!args.includes('--json')) process.stdout.write(result.stdout ?? '');
  console.error(`Gate evidence confirmed: ${name}`);
  return args.includes('--json') ? JSON.parse(result.stdout) : null;
}

function markdown(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? markdown(path) : path.endsWith('.md') ? [path] : [];
  });
}
try {
  gate('nodeTests', ['--test', '--test-reporter=tap', 'tools/alignment.test.mjs', 'tools/remote-alignment.test.mjs', 'tools/name-hazards.test.mjs', 'scripts/cross-check-coverage.test.mjs']);
  gate('guards', ['tools/guard-corpus.mjs']);
  gate('copies', ['tools/sync-corpus.mjs', '--check']);
  const rubric = gate('rubric', ['tools/trust-rubric.mjs', '--json']);
  const parity = gate('parity', ['tools/parity-check.mjs', '--json']);
  const metrics = {
    'security.corpora': rubric.securityCorpora,
    'security.adversarialRows': rubric.adversarialRows,
    'security.fuzzedIdentifiers': rubric.fuzzedIdentifiers,
    'security.hazardClaimingCorpora': rubric.hazardClaimingCorpora,
    'families.withSuite': parity.familiesWithSuite,
    'families.total': parity.families,
    'corpus.version': readFileSync(join(root, 'VERSION'), 'utf8').trim(),
    'golden.suites': 0,
    'golden.cases': 0,
  };
  const goldenKinds = new Set(['request-payload', 'response-parse', 'roundtrip', 'error-code', 'container-identity']);
  for (const id of readdirSync(join(root, 'suites'))) {
    const manifest = JSON.parse(readFileSync(join(root, 'suites', id, 'manifest.json'), 'utf8'));
    const cases = JSON.parse(readFileSync(join(root, 'suites', id, 'cases.json'), 'utf8')).cases;
    metrics[`suite.${id}.cases`] = cases.length;
    if (goldenKinds.has(manifest.kind)) { metrics['golden.suites']++; metrics['golden.cases'] += cases.length; }
  }
  let claims = 0;
  for (const file of [join(root, 'README.md'), join(root, 'AGENTS.md'), ...markdown(join(root, 'docs'))]) {
    let text = readFileSync(file, 'utf8');
    if (write) {
      text = text.replace(/<!-- metric:([^\s]+) -->([\s\S]*?)<!-- \/metric -->/g, (match, key) =>
        Object.hasOwn(metrics, key) ? `<!-- metric:${key} -->${metrics[key]}<!-- /metric -->` : match);
      if (text !== readFileSync(file, 'utf8')) writeFileSync(file, text);
    }
    const label = relative(root, file).replaceAll('\\', '/');
    failures.push(...compareClaims(label, text, metrics), ...unmarkedCounts(label, text));
    claims += [...text.matchAll(/<!-- metric:/g)].length;
  }
  if (claims === 0) failures.push('No published metrics found; removing the assertions is not agreement.');
  const coordinator = readFileSync(join(root, '.github/workflows/alignment.yml'), 'utf8');
  for (const name of readdirSync(join(root, '.github/workflows')).filter((name) => /\.ya?ml$/.test(name))) {
    const file = `.github/workflows/${name}`;
    failures.push(...checkWorkflowDependencies(file, readFileSync(join(root, file), 'utf8')));
    if (name !== 'alignment.yml' && !COORDINATOR_EXEMPT.has(name) && !coordinator.includes(`uses: ./.github/workflows/${name}`)) failures.push(`${file}: reusable workflow is not invoked by alignment.yml`);
  }
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(`Alignment passed: ${claims} published metric claims regenerated and compared.`);
  console.log('Local alignment only. CI also runs tools/remote-alignment.mjs against public main snapshots. Package execution, gap-register entries, handoffs and release-version claims remain separate checks.');
} catch (error) {
  console.error(`Alignment failed:\n${error.message}`);
  process.exit(1);
}
