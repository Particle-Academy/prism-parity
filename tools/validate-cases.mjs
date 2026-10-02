#!/usr/bin/env node
// G-73: a schema that nothing reads is no gate. Fail on every invalid document.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '@particle-academy/fancy-schema';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));

export function validateCases(root = repository) {
  const check = compile(JSON.parse(readFileSync(join(root, 'schema/cases.schema.json'), 'utf8')));
  const suites = readdirSync(join(root, 'suites'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (suites.length === 0) throw new Error('No suite documents found');
  let failures = 0;
  for (const suite of suites) {
    try {
      const document = JSON.parse(readFileSync(join(root, 'suites', suite, 'cases.json'), 'utf8'));
      const { valid, errors } = check(document);
      if (valid) console.log(`  ok — ${suite}`);
      else {
        failures++;
        for (const error of errors) {
          console.error(`  FAIL — ${suite} ${error.instancePath || '/'}: ${error.message}`);
        }
      }
    } catch (error) {
      failures++;
      console.error(`  FAIL — ${suite} /: ${error.message}`);
    }
  }
  console.log(`Cases schema: ${suites.length - failures}/${suites.length} documents valid`);
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    // Alternate root lets the standing self-test exercise the actual CLI on copies.
    if (process.argv.length > 3) throw new Error('Usage: node tools/validate-cases.mjs [root]');
    process.exitCode = validateCases(process.argv[2] ? resolve(process.argv[2]) : repository);
  } catch (error) {
    console.error(`Cases schema: FAIL — ${error.message}`);
    process.exitCode = 1;
  }
}
