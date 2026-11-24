// Loopback servers for the cross-origin-redirect corpus.
//
// Raw TCP rather than node:http, so that EVERYTHING a server receives is
// visible: a connection that never becomes an HTTP request (a TLS handshake
// after a scheme change) still counts, and the credential is searched for in
// the bytes on the wire rather than in headers a parser chose to keep.
//
// Every answer closes the connection, so a client cannot carry a request to
// one origin over a socket opened for another.
import net from 'node:net';

const MAX_BYTES = 1024 * 1024;

export async function startServer(host) {
  const state = {
    host,
    port: 0,
    connections: 0,
    tls: 0,
    requests: [],
    bytes: [],
    redirect: null,
  };
  const server = net.createServer((socket) => {
    state.connections += 1;
    let buffer = Buffer.alloc(0);
    let answered = false;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      state.bytes.push(chunk);
      if (answered) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_BYTES) { answered = true; socket.destroy(); return; }
      // 0x16 is a TLS handshake record: a client that switched to https.
      if (buffer[0] === 0x16) { state.tls += 1; answered = true; socket.destroy(); return; }
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = buffer.subarray(0, end).toString('latin1');
      const [requestLine, ...lines] = head.split('\r\n');
      const headers = Object.fromEntries(lines.map((line) => {
        const at = line.indexOf(':');
        return [line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()];
      }));
      const body = buffer.subarray(end + 4);
      if (headers.expect?.toLowerCase() === '100-continue' && body.length === 0) {
        socket.write('HTTP/1.1 100 Continue\r\n\r\n');
      }
      const length = Number(headers['content-length'] ?? 0);
      const chunked = (headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked');
      if (chunked ? !body.includes('0\r\n\r\n') : body.length < length) return;
      answered = true;
      const [method, path] = requestLine.split(' ');
      state.requests.push({ method, path });
      if (state.redirect !== null && state.requests.length === 1) {
        socket.end(`HTTP/1.1 ${state.redirect.status} Redirect\r\nLocation: ${state.redirect.location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
        return;
      }
      const payload = '{"error":{"message":"fixture"}}';
      socket.end(`HTTP/1.1 500 Fixture\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n${payload}`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  state.port = server.address().port;
  state.origin = `http://${host}:${state.port}`;
  state.received = () => Buffer.concat(state.bytes).toString('latin1');
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  return state;
}

// The servers for one row: the configured endpoint, another host, and the
// endpoint's host on another port. Location is resolved here from the row's
// target, so a corpus row never carries a port.
export async function rowServers(target, status) {
  const endpoint = await startServer('127.0.0.1');
  const otherHost = await startServer('127.0.0.2');
  const otherPort = await startServer('127.0.0.1');
  const location = {
    'other-host': `${otherHost.origin}/landed`,
    'other-port': `${otherPort.origin}/landed`,
    'protocol-relative': `//127.0.0.2:${otherHost.port}/landed`,
    'scheme': `https://127.0.0.1:${endpoint.port}/landed`,
    'same-origin-path': '/landed',
    'same-origin-absolute': `${endpoint.origin}/landed`,
  }[target];
  if (location === undefined) throw new Error('Unknown cross-origin-redirect target.');
  endpoint.redirect = { status, location };
  return { endpoint, otherHost, otherPort };
}

// What the row observed. `reached_elsewhere` counts any connection to the
// other servers and any TLS attempt at the endpoint: a request that left the
// configured origin, whether or not it got as far as HTTP.
export function observation(servers, credential) {
  const { endpoint, otherHost, otherPort } = servers;
  const elsewhere = otherHost.connections + otherPort.connections + endpoint.tls;
  const leaked = otherHost.received().includes(credential) || otherPort.received().includes(credential);
  return {
    endpoint_requests: endpoint.requests.length,
    reached_elsewhere: elsewhere > 0,
    credential_elsewhere: leaked,
  };
}

export async function closeAll(servers) {
  await Promise.all(Object.values(servers).map((server) => server.close()));
}
