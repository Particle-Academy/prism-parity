import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tool = join(root, 'tools/validate-cases.mjs');

test('the shipped gate accepts the corpus', () => {
  const result = spawnSync(process.execPath, [tool], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Cases schema: 24\/24 documents valid/);
});

for (const [name, mutate] of [
  ['scalar skip', (doc) => { doc.cases[0].skip = 'not a language map'; }],
  ['empty skip map', (doc) => { doc.cases[0].skip = {}; }],
  ['unknown skip language', (doc) => { doc.cases[0].skip = { ruby: 'unsupported' }; }],
  ['missing required notes', (doc) => { delete doc.cases[0].notes; }],
]) {
  test(`the CLI rejects ${name} with a suite and instance path`, (t) => {
    const scratch = mkdtempSync(join(tmpdir(), 'prism-schema-'));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    mkdirSync(join(scratch, 'schema'));
    mkdirSync(join(scratch, 'suites/openai-text-request'), { recursive: true });
    copyFileSync(join(root, 'schema/cases.schema.json'), join(scratch, 'schema/cases.schema.json'));
    const doc = JSON.parse(readFileSync(join(root, 'suites/openai-text-request/cases.json'), 'utf8'));
    const fixture = join(scratch, 'suites/openai-text-request/cases.json');
    writeFileSync(fixture, JSON.stringify(doc));
    const control = spawnSync(process.execPath, [tool, scratch], { encoding: 'utf8' });
    assert.equal(control.status, 0, control.stderr);
    mutate(doc);
    writeFileSync(fixture, JSON.stringify(doc));
    const result = spawnSync(process.execPath, [tool, scratch], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    // The schema's top-level oneOf reports its failure at the document root.
    assert.match(result.stderr, /FAIL — openai-text-request \/: matched 0/);
    assert.match(result.stdout, /Cases schema: 0\/1 documents valid/);
  });
}

test('an empty corpus cannot produce a green gate', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'prism-schema-empty-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  mkdirSync(join(scratch, 'schema'));
  mkdirSync(join(scratch, 'suites'));
  copyFileSync(join(root, 'schema/cases.schema.json'), join(scratch, 'schema/cases.schema.json'));
  const result = spawnSync(process.execPath, [tool, scratch], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No suite documents found/);
});
