import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';

/** Development only: one ephemeral owner for one local tenant, not OIDC. */
export function createDevelopmentAuthenticator() {
  const token = randomBytes(32).toString('base64url');
  const expected = Buffer.from(`Bearer ${token}`);
  return {
    token,
    authenticate(request) {
      const supplied = Buffer.from(request.headers.get('authorization') ?? '');
      return supplied.length === expected.length && timingSafeEqual(supplied, expected)
        ? { principalId: 'local-user', tenantId: 'local', role: 'owner' } : null;
    }
  };
}

/** Loopback reference adapter. Production TLS/proxies/timeouts need separate work. */
export async function startLocalServer({ handle, port = 8787, host = '127.0.0.1' }) {
  if (host !== '127.0.0.1') throw new TypeError('This demo only allows IPv4 loopback');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid port');
  if (typeof handle !== 'function') throw new TypeError('Request handler required');
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30000, headersTimeout: 10000 }, async (incoming, outgoing) => {
    const controller = new AbortController();
    incoming.on('aborted', () => controller.abort());
    try {
      // Never trust Host or accept proxy-style absolute targets.
      const rawTarget = incoming.url ?? '';
      if (!rawTarget.startsWith('/') || rawTarget.startsWith('//') || /[\\?#]/.test(rawTarget) || new URL(rawTarget, 'http://127.0.0.1').pathname !== rawTarget) {
        outgoing.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        outgoing.end('{"error":{"code":"BAD_REQUEST","message":"Invalid request."}}'); return;
      }
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      const method = incoming.method ?? 'GET';
      const request = new Request(`http://127.0.0.1${incoming.url}`, {
        method, headers, signal: controller.signal,
        ...(!['GET', 'HEAD'].includes(method) ? { body: Readable.toWeb(incoming), duplex: 'half' } : {})
      });
      const result = await handle(request);
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      outgoing.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      outgoing.end('{"error":{"code":"DEPENDENCY_UNAVAILABLE","message":"Service unavailable."}}');
    }
  });
  server.setTimeout(30000, socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  return {
    url: `http://${host}:${server.address().port}`,
    close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); })
  };
}
