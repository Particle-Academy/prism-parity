// Native TypeScript observations. Every request enters through
// Prism.text().using(...) and is captured at fetch, which answers 500; nothing
// reaches the network. A row records WHETHER a credential was sent, never which
// value: the classification below reads the fixture constants back out of the
// captured wire.
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const environmentNames = JSON.parse(readFileSync(new URL('./environment-names.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(readFileSync(new URL('./fixture-values.json', import.meta.url), 'utf8'));

export function classify(wires) {
  const text = wires.join('\n');
  const inherited = text.includes(fixture.inherited_key);
  const explicit = text.includes(fixture.explicit_key);
  return {
    dispatched: wires.length > 0,
    credential: inherited && explicit ? 'both' : inherited ? 'inherited' : explicit ? 'explicit' : 'none',
    account: text.includes(fixture.organization) || text.includes(fixture.project) ? 'inherited' : 'none',
  };
}

export async function observe(document, dist) {
  assert.deepEqual([...document.environment_names].sort(), [...environmentNames].sort(), 'Unapproved environment isolation names.');
  const sdk = await import(pathToFileURL(join(resolve(dist), 'index.js')).href);
  const builtIns = { openai: sdk.OpenAI, anthropic: sdk.Anthropic, mistral: sdk.Mistral };
  const names = { api_key: 'apiKey' };
  const realFetch = globalThis.fetch;
  const environment = Object.fromEntries(document.environment_names.map(name => [name, process.env[name]]));
  let wires = [];
  globalThis.fetch = async (url, init) => {
    const headers = [...new Headers(init?.headers).entries()].map(([key, value]) => `${key}: ${value}`).join('\n');
    wires.push(`${String(url)}\n${headers}\n${typeof init?.body === 'string' ? init.body : ''}`);
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
      let result;
      if (row.kind === 'endpoint') {
        wires = [];
        const config = Object.fromEntries(Object.entries(row.config).map(([name, value]) => [names[name] ?? name, value]));
        try {
          await sdk.Prism.text().using(row.provider, 'fixture-model', config).withPrompt('hi').asText();
        } catch {
          // The fixture answers 500; only the outgoing request matters.
        }
        result = classify(wires);
      } else if (row.kind === 'register') {
        const stub = () => ({ fixture: 'stub' });
        if (row.preregistered !== undefined) sdk.registerProvider(row.preregistered, stub);
        let refused = false;
        try {
          sdk.registerProvider(row.name, stub, row.replace ? { replace: true } : undefined);
        } catch (error) {
          // A collision, or a name the registry refuses as unreadable.
          if (!(error instanceof Error) || !/already registered|not a valid provider name/.test(error.message)) throw error;
          refused = true;
        }
        const intact = Object.entries(builtIns).every(([key, Type]) => sdk.resolveProvider(key, { apiKey: 'x' }) instanceof Type);
        result = { refused, builtins_intact: intact };
        // The registry is process-wide: put any replaced built-in back.
        for (const [key, Type] of Object.entries(builtIns)) {
          if (!(sdk.resolveProvider(key, { apiKey: 'x' }) instanceof Type)) {
            sdk.registerProvider(key, (config) => new Type(config), { replace: true });
          }
        }
      } else {
        throw new Error('Unknown credential-scope fixture kind.');
      }
      rows.push({ id: entry.id, observed: result });
    }
  } finally {
    globalThis.fetch = realFetch;
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  return rows;
}
