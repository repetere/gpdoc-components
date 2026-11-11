// Original static client and strict Node HTTP bridge. No listener or identity defaults.
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

export const WEB_CLIENT_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const SECURITY_HEADERS = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': WEB_CLIENT_CSP, 'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()'
};
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/assets/editor.css', ['editor.css', 'text/css; charset=utf-8']],
  ['/assets/editor.mjs', ['dist/editor.mjs', 'text/javascript; charset=utf-8']],
  ['/assets/THIRD-PARTY-NOTICES.txt', ['dist/THIRD-PARTY-NOTICES.txt', 'text/plain; charset=utf-8']],
  ['/assets/controller.mjs', ['controller.mjs', 'text/javascript; charset=utf-8']]
]);
function errorResponse(status) {
  return new Response(JSON.stringify({ error: { code: status === 413 ? 'TOO_LARGE' : status === 503 ? 'DEPENDENCY_UNAVAILABLE' : 'BAD_REQUEST', message: 'Request could not be completed.' } }),
    { status, headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' } });
}
function canonical(origin, allowInsecureLoopback) {
  let url; try { url = new URL(origin); } catch { throw new TypeError('An exact canonical origin is required'); }
  if (url.origin !== origin || url.username || url.password
    || !(url.protocol === 'https:' || (allowInsecureLoopback === true && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new TypeError('Use an exact HTTPS origin, or explicitly allow loopback HTTP');
  }
  return url;
}
function allowedTarget(target) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//') || /[\\#\x00-\x20\x7f]/.test(target) || target.length > 8192) return false;
  const url = new URL(target, 'https://canonical.invalid');
  if (url.pathname !== target.split('?')[0]) return false;
  return !target.includes('?') || url.pathname === '/auth/callback';
}

/** Serve the fixed, production-neutral assets and delegate auth/REST to the BFF. */
export async function createWebClientHandler({ handle, canonicalOrigin, allowInsecureLoopback = false } = {}) {
  if (typeof handle !== 'function') throw new TypeError('An authenticated browser handler is required');
  canonical(canonicalOrigin, allowInsecureLoopback);
  const assets = new Map(await Promise.all([...ASSETS].map(async ([path, [file, type]]) =>
    [path, { bytes: await readFile(new URL(`../web/${file}`, import.meta.url)), type }])));
  return async request => {
    const url = new URL(request.url);
    if (url.origin !== canonicalOrigin || url.hash || url.username || url.password || !allowedTarget(`${url.pathname}${url.search}`)) return errorResponse(400);
    const asset = assets.get(url.pathname);
    if (asset) {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { ...SECURITY_HEADERS, allow: 'GET, HEAD' } });
      return new Response(request.method === 'HEAD' ? null : asset.bytes, { headers: { ...SECURITY_HEADERS, 'content-type': asset.type, 'content-length': String(asset.bytes.byteLength) } });
    }
    const response = await handle(request);
    // Keep independent Set-Cookie fields. Do not collapse them with Object.fromEntries.
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
    return response;
  };
}

/**
 * Node request listener for an operator-owned HTTP(S) server. It trusts no proxy
 * headers and accepts only the configured Host. TLS/HSTS, ingress rate limits,
 * server header/request timeouts and trusted proxy configuration remain operator-owned.
 */
export function createWebClientNodeListener({ handle, canonicalOrigin, allowInsecureLoopback = false,
  maxBodyBytes = 6 * 1024 * 1024 + 4096, requestTimeoutMs = 20000 } = {}) {
  if (typeof handle !== 'function') throw new TypeError('Request handler required');
  const origin = canonical(canonicalOrigin, allowInsecureLoopback);
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0 || maxBodyBytes > 6 * 1024 * 1024 + 4096
    || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 30000) throw new TypeError('Finite bounded ingress limits required');
  return async (incoming, outgoing) => {
    const abort = new AbortController();
    let settled = false;
    const send = async response => {
      if (settled || outgoing.destroyed) return;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (settled || outgoing.destroyed) return;
      settled = true;
      const headers = Object.fromEntries(response.headers);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) headers['set-cookie'] = cookies;
      outgoing.writeHead(response.status, headers); outgoing.end(bytes);
    };
    const timeout = setTimeout(() => { abort.abort(); void send(errorResponse(503)); incoming.resume(); }, requestTimeoutMs);
    const onAborted = () => abort.abort(); incoming.once('aborted', onAborted);
    try {
      const rawHeaders = incoming.rawHeaders;
      let hosts = 0;
      for (let index = 0; index < rawHeaders.length; index += 2) {
        const name = rawHeaders[index].toLowerCase();
        if (name === 'host') hosts++;
        if (name === 'forwarded' || name.startsWith('x-forwarded-')) { await send(errorResponse(400)); incoming.resume(); return; }
      }
      if (hosts !== 1 || incoming.headers.host !== origin.host || !allowedTarget(incoming.url)) { await send(errorResponse(400)); incoming.resume(); return; }
      const length = incoming.headers['content-length'];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes)) { await send(errorResponse(413)); incoming.resume(); return; }
      const method = incoming.method ?? 'GET';
      if (['GET', 'HEAD'].includes(method) && (Number(length ?? 0) > 0 || incoming.headers['transfer-encoding'])) { await send(errorResponse(400)); incoming.resume(); return; }
      const headers = new Headers();
      for (let index = 0; index < rawHeaders.length; index += 2) headers.append(rawHeaders[index], rawHeaders[index + 1]);
      // Stream with a finite limit; never accumulate an unbounded incoming body.
      let total = 0;
      async function* boundedBody() {
        for await (const chunk of incoming) {
          total += chunk.length;
          if (total > maxBodyBytes) { void send(errorResponse(413)); abort.abort(); return; }
          yield chunk;
        }
      }
      const request = new Request(`${canonicalOrigin}${incoming.url}`, { method, headers, signal: abort.signal,
        ...(!['GET', 'HEAD'].includes(method) ? { body: Readable.toWeb(Readable.from(boundedBody())), duplex: 'half' } : {}) });
      const result = await handle(request);
      if (abort.signal.aborted) { await send(errorResponse(total > maxBodyBytes ? 413 : 503)); return; }
      await send(result);
    } catch { await send(errorResponse(503)); }
    finally { clearTimeout(timeout); incoming.off('aborted', onAborted); }
  };
}
