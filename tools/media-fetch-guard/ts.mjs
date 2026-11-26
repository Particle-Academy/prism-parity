// Native TypeScript observations for the media-fetch-guard WIRE rows (G-386).
// Each row enters through Image.fromUrl(...).fetchPublic() (or fetch() for an
// unguarded control) over the REAL global fetch, against the loopback server
// the entry point started for that row. The resolver answers the row's
// `answers_any` for every name it is asked. Whether anything arrived is read off
// the server; this records only WHICH refusal code stopped the fetch.
//
// The network guard lets fetch run only when the WHATWG host -- the host
// undici connects to -- is a 127.x literal or `localhost`. Every wire row's
// host is a spelling of one, so a guard that admits it reaches the loopback
// server, and a host that would leave the machine never does.
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

const REFUSALS = ['scheme_not_allowed', 'private_address_refused', 'host_did_not_resolve', 'redirect_refused', 'too_many_redirects', 'non_ascii_host_use_punycode'];
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost)$/;

export async function observe(document, dist) {
  const sdk = await import(pathToFileURL(join(resolve(dist), 'index.js')).href);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    let host = null;
    try { host = new URL(String(url)).hostname; } catch { /* the real fetch refuses it */ }
    if (host !== null && !LOOPBACK.test(host)) throw new Error('Only a host that reaches loopback may be contacted in this corpus.');
    return realFetch(url, init);
  };
  const rows = [];
  try {
    for (const entry of document.cases) {
      let refusal = null;
      try {
        const image = sdk.Image.fromUrl(entry.url);
        if (entry.guarded === false) await image.fetch();
        else await image.fetchPublic({ resolver: { resolve: host => [...(entry.resolves[host] ?? entry.answers_any)] }, timeout: 10 });
      } catch (error) {
        if (error instanceof sdk.PrismUrlRefused) refusal = REFUSALS.includes(error.code) ? error.code : `unrecognised:${error.code}`;
      }
      rows.push({ id: entry.id, refusal });
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  return rows;
}
