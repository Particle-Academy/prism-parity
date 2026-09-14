#!/usr/bin/env node
// Record the TypeScript verdicts in suites/harness-turn-attachments/cases.json,
// by running prism-harness-ts's real admitAttachments() on each case.
//
// The case file is edited as TEXT, replacing each `"ts": ...` verdict in place,
// so the recorder cannot reformat or retype the rows it records.
//
//   PRISM_HARNESS_TS=../prism-harness-ts node tools/record-turn-attachments.mjs [--check]

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const harnessRoot = process.env.PRISM_HARNESS_TS ?? join(root, '..', 'prism-harness-ts');
const { admitAttachments, HarnessError } = await import(pathToFileURL(join(harnessRoot, 'dist', 'index.js')).href);

const check = process.argv.includes('--check');
const path = join(root, 'suites', 'harness-turn-attachments', 'cases.json');
let raw = readFileSync(path, 'utf8');
const document = JSON.parse(raw);

// The same spec, built the way a TypeScript caller would hold it. See the
// matching converter in prism-harness-ts/test/turn-attachments-corpus.test.ts.
export function attachmentFor(spec) {
  const kind = spec.$ === 'Document' ? 'document' : 'image';
  const base = { kind, url: null, base64: null, mime_type: spec.mimeType ?? null, file_id: null, filename: null };
  const titled = (object) => (kind === 'document' ? { ...object, document_title: spec.title ?? null, chunks: object.chunks ?? null } : object);

  switch (spec.$) {
    case 'Text':
      return { text: spec.text };
    case 'String':
      return spec.value;
  }

  switch (spec.from) {
    case 'base64':
      return titled({ ...base, base64: spec.base64 });
    case 'url':
      return titled({ ...base, url: spec.url });
    case 'urlWithBytes':
      return titled({ ...base, url: spec.url, base64: spec.base64 });
    case 'localPath':
      // What prism-ts's fromLocalPath() gives a caller: an object that knows it
      // came from a file, and serializes as bytes with no path.
      return {
        toObject: () => titled({ ...base, base64: Buffer.from(spec.bytes).toString('base64') }),
        isUrl: () => false,
        isFile: () => true,
      };
    case 'fileId':
      return titled({ ...base, file_id: spec.fileId });
    case 'chunks':
      return titled({ ...base, chunks: spec.chunks });
    case 'text':
      return titled({ ...base, base64: Buffer.from(spec.text).toString('base64'), mime_type: 'text/plain' });
    case 'nothing':
      return titled(base);
    default:
      throw new Error(`Unknown media source ${spec.from}`);
  }
}

const stale = [];

for (const testCase of document.cases) {
  let verdict;

  try {
    admitAttachments(testCase.prompt, testCase.attachments.map(attachmentFor));
    verdict = 'admitted';
  } catch (error) {
    if (!(error instanceof HarnessError)) throw error;
    verdict = error.code;
  }

  if (testCase.verdict.ts !== verdict) stale.push(testCase.id);

  const at = raw.indexOf(`"id": "${testCase.id}"`);
  const verdictAt = raw.indexOf('"ts": ', at);
  const end = raw.indexOf('"', verdictAt + '"ts": "'.length);
  raw = `${raw.slice(0, verdictAt)}"ts": "${verdict}${raw.slice(end)}`;
}

if (check) {
  if (stale.length > 0) {
    console.error(`Stale ts verdicts: ${stale.join(', ')}`);
    process.exit(1);
  }
  console.error('TS verdicts current.');
} else {
  writeFileSync(path, raw);
  console.error(`Wrote ${document.cases.length} ts verdict(s); ${stale.length} changed.`);
}
