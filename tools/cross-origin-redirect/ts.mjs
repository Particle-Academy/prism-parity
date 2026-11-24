// Native TypeScript execution for the cross-origin-redirect corpus. Every call
// enters through Prism.text().using(...) with the provider's url and key read
// from the environment, over the default transport and the real `fetch`. Any
// url that is not a 127.x literal is refused before `fetch` sees it.
// Nothing is observed here: the loopback servers are the observation.
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const environmentNames = JSON.parse(readFileSync(new URL('./environment-names.json', import.meta.url), 'utf8'));

export async function execute(document, rows, dist) {
  assert.deepEqual([...document.environment_names].sort(), [...environmentNames].sort(), 'Unapproved environment isolation names.');
  const sdk = await import(pathToFileURL(join(resolve(dist), 'index.js')).href);
  const realFetch = globalThis.fetch;
  const environment = Object.fromEntries(document.environment_names.map(name => [name, process.env[name]]));
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!/^127\.\d+\.\d+\.\d+$/.test(url.hostname)) throw new Error('Only loopback hosts may be contacted in this corpus.');
    return realFetch(input, init);
  };
  try {
    for (const row of rows) {
      for (const name of document.environment_names) delete process.env[name];
      for (const [name, value] of Object.entries(row.env)) {
        if (!environmentNames.includes(name)) throw new Error('Unapproved synthetic environment name.');
        process.env[name] = value;
      }
      try {
        await sdk.Prism.text().using(row.provider, 'fixture-model').withPrompt('hi').asText();
      } catch {
        // Every fixture ends in a 500 or a refused redirect; the servers say which.
      }
    }
  } finally {
    globalThis.fetch = realFetch;
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}
