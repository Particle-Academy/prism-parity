import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function observe(document, modulePath) {
  const sdk = await import(pathToFileURL(resolve(modulePath)));
  const tool = { name: 'owned', description: 'Owned fixture', inputSchema: { type: 'object', properties: {} } };
  const rows = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw Error('Unexpected MCP observer network'); };
  try {
    for (const entry of document.cases) {
      const input = entry.given;
      if (input.kind === 'flag') {
        const reply = { content: [] };
        if (input.present) reply.isError = input.value;
        const client = new sdk.Client({ server: 'configured', trust: sdk.TrustPolicy.allowingEveryTool(), transport: async () => reply });
        const result = await client.callTool(sdk.ToolDefinition.fromPayload(tool));
        rows.push({ id: entry.id, observed: { isError: result.isError } });
        continue;
      }
      if (input.kind === 'content' || input.kind === 'cap') {
        const content = input.kind === 'content' ? input.content : [{ type: 'text', text: input.unit.repeat(input.repeat) }];
        const guard = new sdk.ResultGuard({ frameProvenance: false, ...(Object.hasOwn(input, 'maxBytes') ? { maxBytes: input.maxBytes } : {}) });
        const client = new sdk.Client({ server: 'configured', trust: sdk.TrustPolicy.allowingEveryTool(), guard, transport: async () => ({ content, isError: input.isError ?? false }) });
        try {
          const result = await client.callTool(sdk.ToolDefinition.fromPayload(tool));
          rows.push({ id: entry.id, observed: input.kind === 'content' ? { text: result.text } : { status: 'returned', bytes: Buffer.byteLength(result.text, 'utf8') } });
        } catch (error) {
          assert(error instanceof sdk.McpError);
          rows.push({ id: entry.id, observed: { status: error.code } });
        }
        continue;
      }
      assert(['trust', 'mirror', 'diagnostic'].includes(input.kind));
      let dispatches = 0;
      const warnings = [];
      const previousWarning = process.emitWarning;
      process.emitWarning = (warning) => { warnings.push(String(warning)); };
      try {
        const trust = input.trust === 'missing' ? sdk.TrustPolicy.undeclared() : input.trust === '*' ? sdk.TrustPolicy.allowingEveryTool() : sdk.TrustPolicy.allowing(input.trust);
        const client = new sdk.Client({ server: 'configured', trust, transport: async () => { dispatches++; return { tools: input.tools }; } });
        try {
          const offered = (await client.listTools()).map(value => value.name);
          const observed = input.kind === 'trust' ? { dispatches, offered } : input.kind === 'mirror' ? { offered, excluded: Object.keys(client.excluded()).sort() } : { offered, warned: warnings.length > 0, private: warnings.every(value => !value.includes('REMOTE_')) };
          rows.push({ id: entry.id, observed });
        } catch (error) {
          assert(error instanceof sdk.McpError);
          rows.push({ id: entry.id, observed: input.kind === 'trust' ? { dispatches, error: error.code, empty: error.message.includes('empty tool allowlist') } : { error: error.code } });
        }
      } finally { process.emitWarning = previousWarning; }
    }
  } finally { globalThis.fetch = previousFetch; }
  return rows;
}
