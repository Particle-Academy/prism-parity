// Native SDK observations. The injected transport owns every request; fetch is
// refused so an adapter regression cannot turn a fixture into a provider call.
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const environmentNames = JSON.parse(readFileSync(new URL('./environment-names.json', import.meta.url), 'utf8'));

export async function observe(document, dist) {
  assert.deepEqual([...document.environment_names].sort(), [...environmentNames].sort(), 'Unapproved environment isolation names.');
  const sdk = await import(pathToFileURL(join(resolve(dist), 'index.js')).href);
  const providers = { anthropic: sdk.Anthropic, openai: sdk.OpenAI, mistral: sdk.Mistral };
  const names = { api_key: 'apiKey', version: 'apiVersion', anthropic_beta: 'betaFeatures', api_format: 'apiFormat' };
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const environment = Object.fromEntries(document.environment_names.map(name => [name, process.env[name]]));
  globalThis.fetch = () => { throw new Error('Unowned fetch in configuration fixture.'); };
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
      if (row.kind === 'config') {
        const config = Object.fromEntries(Object.entries(row.config).map(([name, value]) => [names[name] ?? name, value]));
        try {
          result = { value: Reflect.get(new providers[row.provider](config), row.property) };
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          result = { error: 'TypeError' };
        }
      } else {
        const calls = [];
        const transport = async request => {
          calls.push(request);
          if (request.url !== (row.kind === 'fim' ? 'https://offline.invalid/v1/fim/completions' : 'https://offline.invalid/v1/messages')) {
            throw new Error('Unexpected fixture destination.');
          }
          const body = row.kind === 'fim'
            ? { id: 'fixture', model: 'fixture', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
            : { id: 'fixture', model: 'fixture', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} };
          return { status: 200, headers: row.headers ?? {}, rawBody: JSON.stringify(body), body };
        };
        const config = { apiKey: 'synthetic', url: 'https://offline.invalid/v1', transport };
        if (row.kind === 'thinking') {
          if (Object.hasOwn(row, 'defaultConfig')) config.defaultThinkingBudget = row.defaultConfig;
          await new sdk.Anthropic(config).text(new sdk.TextRequest({ model: 'fixture', providerOptions: { thinking: row.thinking }, reasoningEnabled: row.reasoning ?? null }));
          if (calls.length !== 1) throw new Error('Fixture must dispatch exactly once.');
          result = { thinking: JSON.parse(calls[0].body).thinking ?? null };
        } else if (row.kind === 'fim') {
          Date.now = () => row.now * 1000;
          const response = await new sdk.Mistral(config).fim(new sdk.FimRequest({ model: 'fixture', providerKey: 'mistral', prompt: 'prefix' }));
          result = { count: calls.length, text: response.text, rates: response.meta.rateLimits.map(rate => rate.toObject()) };
        } else throw new Error('Unknown configuration fixture kind.');
      }
      rows.push({ id: entry.id, observed: result });
    }
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  return rows;
}
