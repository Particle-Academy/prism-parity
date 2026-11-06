import assert from 'node:assert/strict';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function observe(document, browserPath, humanPath) {
  let state;
  const previousLookup = dns.promises.lookup;
  const previousFetch = globalThis.fetch;
  dns.promises.lookup = async (_host, options) => {
    assert.equal(options.all, true, 'Preflight must request every address');
    const index = state.dnsCalls++;
    const answer = state.answers[Math.min(index, state.answers.length - 1)];
    if (answer === false) throw Error('PRIVATE-B3-DNS');
    return answer.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  syncBuiltinESMExports();
  globalThis.fetch = () => { throw Error('Unexpected satellite observer network'); };
  try {
    const browser = await import(pathToFileURL(resolve(browserPath)));
    const human = await import(pathToFileURL(resolve(humanPath)));
    const frame = { jsonrpc: '2.0', id: 'probe', method: 'tools/call', params: {} };
    const rpc = 'data: '+JSON.stringify({ jsonrpc: '2.0', id: 'probe', result: { fixture: true } })+'\n\n';
    const capture = async action => {
      try { await action(); return { category: 'success', private: true }; }
      catch (error) {
        assert(error instanceof human.HumanPlusError, 'Unexpected relay exception: '+error.constructor.name);
        return { category: error.constructor.name, private: !String(error.message).includes('PRIVATE-B3') };
      }
    };
    const rows = [];
    for (const entry of document.cases) {
      const input = entry.given;
      if (input.kind === 'browser-serialization') {
        rows.push({ id: entry.id, observed: { keys: Object.keys(new browser.BrowserPolicy({ allowedHosts: ['example.com'] }).toObject()).sort() } });
        continue;
      }
      if (input.kind === 'browser') {
        let engineCalls = 0;
        const engine = { navigate: async url => { engineCalls++; return { origin: new URL(url).origin, url, content: { fixture: true } }; }, act: async () => { throw Error('Unexpected browser action'); } };
        let outcome = 'returned';
        try {
          const policy = new browser.BrowserPolicy({ allowedHosts: input.allowedHosts, ...(input.mode === 'constructor' ? { allowPrivateAddresses: input.value } : {}) });
          if (input.mode === 'property') policy.allowPrivateAddresses = true;
          await new browser.GuardedBrowser(engine, policy).navigate(input.url);
        } catch (error) {
          assert(error instanceof browser.BrowserRefused || error instanceof TypeError, 'Unexpected browser exception');
          outcome = 'refused';
        }
        rows.push({ id: entry.id, observed: { outcome, engineCalls } });
        continue;
      }
      state = { answers: input.answers ?? [['8.8.8.8']], dnsCalls: 0, posts: 0, streams: 0 };
      const http = {
        post: async () => { state.posts++; return { status: input.kind === 'relay-call' && input.operation !== 'stream' ? input.status : input.postStatus ?? 200, body: input.body ?? '' }; },
        stream: async () => { state.streams++; return { status: input.kind === 'relay-call' ? input.status : input.getStatus ?? 200, chunks: (async function* () { yield rpc; })() }; },
      };
      const options = { allowedRelayHosts: input.allowedHosts ?? ['8.8.8.8'], allowedRelayPorts: input.allowedPorts ?? [443], egressProxy: input.proxy === null ? null : 'http://proxy.fixture:3128', allowUnverifiedEgress: input.allowUnverified ?? false };
      // WHATWG URL canonicalizes embedded IPv4 in literal IPv6. This adds only
      // the same literal spelling to the fixture allowlist, never an address.
      if (input.kind === 'relay-literal') options.allowedRelayHosts = [...new Set([...options.allowedRelayHosts, new URL(input.url).hostname])];
      const subject = new human.SsePostRelayTransport(http, options);
      let observed;
      if (input.kind === 'relay-classifier') observed = await capture(() => subject.assertLive(input.status, input.body, input.operation === 'detach'));
      else {
        assert(['relay-call', 'relay-dns', 'relay-literal', 'relay-native'].includes(input.kind));
        observed = await capture(async () => {
          const invitation = new human.SurfaceInvitation({ relayBaseUrl: input.url ?? 'https://8.8.8.8', sessionId: 'b3session', token: 'T'.repeat(32), surfaceId: 'board:fixture', application: 'Fixture', allowInsecureLoopback: input.allowInsecureLoopback ?? false });
          const attachment = new human.SurfaceAttachment('surface_x', 'session:one', invitation, { id: 'agent:b3', name: 'Fixture', color: '#fff' }, 'b3_client');
          if (input.operation === 'detach') await subject.detach(attachment);
          else if (input.operation === 'notify') await subject.notify(attachment, frame);
          else {
            const reply = await subject.exchange(attachment, frame);
            assert.deepEqual(reply.result, { fixture: true }, 'Correlated result not observed');
          }
        });
        if (input.kind !== 'relay-native') observed = { ...observed, posts: state.posts, streams: state.streams, dnsCalls: state.dnsCalls };
      }
      rows.push({ id: entry.id, observed });
    }
    return rows;
  } finally {
    dns.promises.lookup = previousLookup;
    syncBuiltinESMExports();
    globalThis.fetch = previousFetch;
  }
}
