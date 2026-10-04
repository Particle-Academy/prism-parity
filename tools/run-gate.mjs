#!/usr/bin/env node
import { spawnSync, execFileSync } from 'node:child_process';
import { gates } from './gate-contracts.mjs';
import { requireVerdict } from './alignment-contracts.mjs';

const [name, separator, command, ...args] = process.argv.slice(2);
if (!Object.hasOwn(gates, name) || separator !== '--' || !command) {
  console.error('Usage: node tools/run-gate.mjs <gate> -- <command> [args...]');
  process.exit(1);
}

// Commands and cwd are supplied explicitly by the workflow. No shell expansion
// or interpolated command string: paths with spaces remain single arguments.
let binary = command === 'node' ? process.execPath : command;
if (command === 'php' && process.platform === 'win32') {
  binary = process.env.PHP_BINARY ?? execFileSync('where.exe', ['php.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
}
const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
try {
  requireVerdict(name, result, gates[name]);
  console.error(`Gate evidence confirmed: ${name}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
