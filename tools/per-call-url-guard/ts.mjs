// Native TypeScript observations. Every request enters through
// Prism.text().using(...) and is captured at fetch, which answers 500; nothing
// reaches the network. A row records WHETHER a request was sent and WHICH
// refusal code stopped it, never the message.
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const environmentNames = JSON.parse(readFileSync(new URL('./environment-names.json', import.meta.url), 'utf8'));
const REFUSALS = ['private_address_refused', 'scheme_not_allowed', 'non_ascii_host_use_punycode'];
const camel = { api_key: 'apiKey', allow_private_per_call_url: 'allowPrivatePerCallUrl' };
const renamed = (object) => Object.fromEntries(Object.entries(object ?? {}).map(([name, value]) => [camel[name] ?? name, value]));

export async function observe(document, dist) {
  assert.deepEqual([...document.environment_names].sort(), [...environmentNames].sort(), 'Unapproved environment isolation names.');
  const sdk = await import(pathToFileURL(join(resolve(dist), 'index.js')).href);
  const realFetch = globalThis.fetch;
  const environment = Object.fromEntries(document.environment_names.map(name => [name, process.env[name]]));
  let sent = 0;
  globalThis.fetch = async () => {
    sent += 1;
    return new Response(JSON.stringify({ error: { message: 'fixture' } }), { status: 500, headers: { 'content-type': 'application/json' } });
  };
  const rows = [];
  try {
    for (const entry of document.cases) {
      const row = entry.given;
      for (const name of document.environment_names) delete process.env[name];
      for (const [name, value] of Object.entries(row.env ?? {})) {
        if (!environmentNames.includes(name)) throw new Error('Unapproved synthetic environment name.');
        process.env[name] = value;
      }
      if (row.kind !== 'per-call' && row.kind !== 'compatible') throw new Error('Unknown per-call-url-guard fixture kind.');
      sent = 0;
      let refusal = null;
      try {
        // Inside the observation: a port that refuses the entry itself (an
        // unknown opt-out key) sends nothing and is recorded so.
        if (row.kind === 'compatible') {
          sdk.configureProviders({ [row.provider]: { driver: 'openai-compatible', ...renamed(row.entry) } }, { replace: true });
        }
        await sdk.Prism.text().using(row.provider, 'fixture-model', renamed(row.config)).withPrompt('hi').asText();
      } catch (error) {
        // The fixture answers 500, which is not a refusal; only a refusal code is.
        if (sent === 0 && REFUSALS.includes(error?.code)) refusal = error.code;
      }
      rows.push({ id: entry.id, observed: { dispatched: sent > 0, refusal } });
    }
  } finally {
    globalThis.fetch = realFetch;
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  return rows;
}
