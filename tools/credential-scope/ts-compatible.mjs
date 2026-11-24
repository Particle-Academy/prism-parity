// One `compatible` row, observed natively in TypeScript in a process of its
// own: configureProviders() registers process-wide and has no undo, so a fresh
// process per row is what keeps one row's names out of the next.
//
//   node tools/credential-scope/ts-compatible.mjs <dist>   (row JSON on stdin)
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(new URL('./fixture-values.json', import.meta.url), 'utf8'));

/**
 * Classify the first captured request and the error, if any. Shared shape with
 * php.php and py.py: never a credential value, only whether one was sent.
 */
export function classifyCompatible(requests, error, row) {
  const wires = requests.map(request => request.wire);
  const text = wires.join('\n');
  const inherited = text.includes(fixture.inherited_key);
  const explicit = text.includes(fixture.explicit_key);
  const messages = [];
  for (let current = error; current instanceof Error; current = current.cause) messages.push(current.message);
  const message = messages.join('\n');
  let refusal = 'none';
  if (requests.length === 0 && error !== undefined) {
    if (message.includes('not a valid provider name')) refusal = 'name';
    else if (message.includes('already registered')) refusal = 'collision';
    else if (message.includes('not a valid provider url')) refusal = 'url';
    else if (message.includes('not a valid api format')) refusal = 'format';
    else if (message.includes('not a supported provider driver') || message.includes('is not supported')) refusal = 'unsupported';
    else throw error;
  }
  const first = requests[0];
  const entryUrl = row.entry?.url;
  let target = 'none';
  if (first !== undefined) {
    if (typeof entryUrl === 'string' && first.url.toLowerCase().startsWith(`${entryUrl.replace(/\/+$/, '').toLowerCase()}/`)) target = 'entry';
    else if (first.url.startsWith('https://api.openai.com/')) target = 'openai';
    else target = 'other';
  }
  let body = null;
  if (first !== undefined) {
    try {
      const parsed = JSON.parse(first.body);
      body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      body = null;
    }
  }
  return {
    refusal,
    dispatched: requests.length > 0,
    credential: inherited && explicit ? 'both' : inherited ? 'inherited' : explicit ? 'explicit' : 'none',
    authorization: first !== undefined && first.headers.has('authorization'),
    account: text.includes(fixture.organization) || text.includes(fixture.project)
      ? 'inherited'
      : text.includes('org-test-entry') || text.includes('proj-test-entry') ? 'entry' : 'none',
    target,
    path: first === undefined ? null : new URL(first.url).pathname,
    body,
    error_carries_credential: message.includes(fixture.inherited_key) || message.includes(fixture.explicit_key),
  };
}

async function observeRow(row, dist) {
  const sdk = await import(pathToFileURL(join(resolve(dist), 'index.js')).href);
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    const flat = [...headers.entries()].map(([key, value]) => `${key}: ${value}`).join('\n');
    const body = typeof init?.body === 'string' ? init.body : '';
    requests.push({ url: String(url), headers, body, wire: `${String(url)}\n${flat}\n${body}` });
    if (row.transport === 'unreachable') throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    return new Response(JSON.stringify({ error: { message: 'fixture' } }), { status: 500, headers: { 'content-type': 'application/json' } });
  };
  const camel = { api_key: 'apiKey', api_format: 'apiFormat' };
  let error;
  try {
    if (row.entry !== undefined) {
      const entry = Object.fromEntries(Object.entries(row.entry)
        .filter(([, value]) => value !== null)
        .map(([name, value]) => [camel[name] ?? name, value]));
      sdk.configureProviders({ [row.name]: entry });
    }
    const config = Object.fromEntries(Object.entries(row.config).map(([name, value]) => [camel[name] ?? name, value]));
    let pending = row.call === 'structured'
      ? sdk.Prism.structured().using(row.provider, 'fixture-model', config)
        .withSchema(new sdk.ObjectSchema('reply', 'a reply', [new sdk.StringSchema('answer', 'the answer')], { requiredFields: ['answer'] }))
      : sdk.Prism.text().using(row.provider, 'fixture-model', config);
    if (row.call === 'tool') {
      pending = pending.withTools([new sdk.Tool().as('lookup').for('Look something up')
        .withStringParameter('query', 'The query').using(() => 'result')]);
    }
    pending = pending.withPrompt('hi');
    if (row.call === 'structured') await pending.asStructured();
    else if (row.call === 'stream') { for await (const event of pending.asStream()) void event; }
    else await pending.asText();
  } catch (caught) {
    error = caught;
  }
  return classifyCompatible(requests, error, row);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const row = JSON.parse(readFileSync(0, 'utf8'));
  const observed = await observeRow(row, process.argv[2]);
  process.stdout.write(JSON.stringify(observed) + '\n');
}
