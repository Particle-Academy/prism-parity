// Measurement adapter: the native published transport decodes the raw bytes.
// Cases must run serially because fetch is restored around each complete stream.
export async function parseStream(lib, testCase) {
  const originalFetch = globalThis.fetch;
  const chunks = decodeChunks(testCase.stream);
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests += 1;
    if (url !== 'https://api.anthropic.com/v1/messages' || JSON.parse(options.body).stream !== true) {
      throw new Error('Unexpected request in owned stream fixture.');
    }
    return new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const events = [];
  const eventIds = new Map();
  const opaqueIds = new Map();
  let terminal = { status: 'returned' };
  try {
    let pending = lib.Prism.text();
    for (const step of testCase.builder) pending = pending[step.call](...(step.args ?? []));
    const provider = new lib.Anthropic({ apiKey: 'owned-g115', url: 'https://api.anthropic.com/v1' });
    for await (const event of provider.stream(pending.toRequest())) {
      const payload = event.toObject();
      if (Object.hasOwn(payload, 'id')) payload.id = alias(eventIds, payload.id, 'event');
      if (Object.hasOwn(payload, 'timestamp')) payload.timestamp = 0;
      events.push({ type: event.type(), payload: aliasOpaque(payload, opaqueIds) });
    }
  } catch (error) {
    terminal = { status: 'raised', exception: error.constructor.name };
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { events, terminal, requests };
}

function decodeChunks(stream) {
  if (stream.encoding !== 'base64' || !Array.isArray(stream.chunks) || stream.chunks.length === 0) {
    throw new Error('A stream fixture needs nonempty base64 chunks.');
  }
  return stream.chunks.map(encoded => {
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length === 0 || bytes.toString('base64') !== encoded) throw new Error('Invalid or empty stream chunk.');
    return bytes;
  });
}

function alias(aliases, value, prefix) {
  if (!aliases.has(value)) aliases.set(value, `${prefix}-${aliases.size + 1}`);
  return aliases.get(value);
}

function aliasOpaque(value, aliases) {
  if (Array.isArray(value)) return value.map(child => aliasOpaque(child, aliases));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    ['message_id', 'reasoning_id'].includes(key) && typeof child === 'string' && child !== ''
      ? alias(aliases, child, 'opaque') : aliasOpaque(child, aliases),
  ]));
}

/** Evaluate the independent fixture properties without changing its trace. */
export function violations(trace, properties, { completionTextRequired = true } = {}) {
  const failed = [];
  const ends = trace.events.filter(event => event.type === 'stream_end');
  const text = trace.events.filter(event => event.type === 'text_delta').map(event => event.payload.delta).join('');
  if (text !== properties.text) failed.push('text');
  const starts = trace.events.filter(event => event.type === 'text_start');
  const completes = trace.events.filter(event => event.type === 'text_complete');
  if (starts.length !== completes.length || (completionTextRequired && completes.map(event => event.payload.text).join('') !== properties.text)) failed.push('text_completion');
  if (ends.length !== properties.terminal_events || trace.events.at(-1)?.type !== 'stream_end') failed.push('terminal_events');
  if (trace.terminal.status !== 'returned' || trace.requests !== 1) failed.push('native_execution');
  if (trace.events.some(event => event.type === 'error') !== properties.error_observable) failed.push('error_observable');
  const errors = trace.events.filter(event => event.type === 'error');
  if (properties.error_nonrecoverable && errors.some(event => event.payload.recoverable !== false)) failed.push('error_nonrecoverable');
  if (properties.error_codes && JSON.stringify(errors.map(event => event.payload.error_type ?? event.payload.code ?? null)) !== JSON.stringify(properties.error_codes)) failed.push('error_codes');
  if (properties.no_completed_tools && trace.events.some(event => ['tool_call', 'tool_result'].includes(event.type))) failed.push('no_completed_tools');
  if (ends.length === 1) {
    const payload = ends[0].payload;
    if (!(properties.normal_completion ? ['Stop', 'stop'] : ['Error', 'error']).includes(payload.finish_reason)) failed.push('normal_completion');
    if (Object.hasOwn(properties, 'usage_known') && (payload.usage != null) !== properties.usage_known) failed.push('usage_known');
    for (const [field, expected] of Object.entries(properties.final_usage ?? {})) {
      if (payload.usage?.[field] !== expected) failed.push(`final_usage.${field}`);
    }
  }
  return failed;
}
