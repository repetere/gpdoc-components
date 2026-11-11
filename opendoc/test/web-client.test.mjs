import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createWebClientHandler, createWebClientNodeListener, WEB_CLIENT_CSP } from '../src/web-client.mjs';

const origin = 'https://documents.example.test';
const fallback = async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });

test('fixed assets have strict CSP, safe MIME, no-store, and HEAD support', async () => {
  const handle = await createWebClientHandler({ handle: fallback, canonicalOrigin: origin });
  for (const [path, type] of [['/', 'text/html'], ['/assets/editor.css', 'text/css'], ['/assets/editor.mjs', 'text/javascript'], ['/assets/controller.mjs', 'text/javascript']]) {
    const response = await handle(new Request(origin + path));
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), new RegExp(type));
    assert.equal(response.headers.get('content-security-policy'), WEB_CLIENT_CSP);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok((await response.text()).length > 100);
    const head = await handle(new Request(origin + path, { method: 'HEAD' }));
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.ok(Number(head.headers.get('content-length')) > 100);
  }
  assert.equal((await handle(new Request(origin, { method: 'POST' }))).status, 405);
});
test('same-origin asset router allows query strings only on callback and preserves cookies', async () => {
  const paths = [];
  const handle = await createWebClientHandler({ canonicalOrigin: origin, handle: async request => {
    paths.push(new URL(request.url).pathname);
    const headers = new Headers(); headers.append('set-cookie', 'session=one; HttpOnly'); headers.append('set-cookie', 'csrf=two; HttpOnly');
    return new Response(null, { status: 303, headers });
  } });
  assert.equal((await handle(new Request(`${origin}/?test=1`))).status, 400);
  assert.equal((await handle(new Request('https://other.example.test/'))).status, 400);
  const callback = await handle(new Request(`${origin}/auth/callback?code=synthetic&state=synthetic`));
  assert.equal(callback.status, 303); assert.equal(callback.headers.getSetCookie().length, 2);
  assert.deepEqual(paths, ['/auth/callback']);
});
test('HTTP needs explicit loopback opt-in and never permits public insecure origins', async () => {
  await assert.rejects(createWebClientHandler({ handle: fallback, canonicalOrigin: 'http://127.0.0.1:8000' }), /HTTPS/);
  await assert.rejects(createWebClientHandler({ handle: fallback, canonicalOrigin: 'http://public.example', allowInsecureLoopback: true }), /HTTPS/);
  await assert.rejects(createWebClientHandler({ handle: fallback, canonicalOrigin: `${origin}/` }), /HTTPS/);
  assert.throws(() => createWebClientNodeListener({ handle: fallback, canonicalOrigin: origin, requestTimeoutMs: Infinity }), /bounded/);
});
async function server(t, handle = fallback, options = {}) {
  let listener;
  const instance = createServer({ maxHeaderSize: 16384 }, (request, response) => listener(request, response));
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${instance.address().port}`;
  listener = createWebClientNodeListener({ handle, canonicalOrigin: local, allowInsecureLoopback: true, ...options });
  t.after(() => new Promise(resolve => { instance.close(resolve); instance.closeAllConnections(); }));
  return local;
}
function raw(origin, { path = '/', method = 'GET', headers = {}, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(origin);
    const request = httpRequest({ hostname: target.hostname, port: target.port, path, method, headers }, response => {
      const buffers = []; response.on('data', chunk => buffers.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(buffers).toString() }));
    });
    request.on('error', reject); for (const chunk of chunks) request.write(chunk); request.end();
  });
}
test('strict Node bridge rejects hostile targets, Host and forwarding headers', async t => {
  const local = await server(t);
  for (const path of ['https://attacker.test/', '//attacker.test/', '/a/../', '/a\\b', '/?leak=1', '/assets/editor.mjs?version=1', '/%2e%2e/']) {
    assert.equal((await raw(local, { path })).status, 400, path);
  }
  for (const headers of [{ host: 'attacker.test' }, { forwarded: 'host=attacker.test' }, { 'x-forwarded-for': '127.0.0.1' }, { 'x-forwarded-proto': 'https' }]) {
    assert.equal((await raw(local, { headers })).status, 400);
  }
  assert.equal((await raw(local, { path: '/auth/callback?code=synthetic&state=synthetic' })).status, 200);
});
test('Node bridge retains separate Set-Cookie headers and does not use forwarded origin', async t => {
  let seen;
  const local = await server(t, async request => {
    seen = request.url;
    const headers = new Headers(); headers.append('set-cookie', 'first=1; HttpOnly'); headers.append('set-cookie', 'second=2; HttpOnly');
    return new Response('ok', { headers });
  });
  const response = await raw(local);
  assert.deepEqual(response.headers['set-cookie'], ['first=1; HttpOnly', 'second=2; HttpOnly']);
  assert.equal(seen, `${local}/`);
});
test('Node bridge bounds declared and chunked bodies and response deadlines', async t => {
  const local = await server(t, async request => { await request.text(); return new Response('ok'); }, { maxBodyBytes: 8 });
  assert.equal((await raw(local, { method: 'POST', headers: { 'content-length': '9' }, chunks: ['123456789'] })).status, 413);
  assert.equal((await raw(local, { method: 'POST', chunks: ['12345', '67890'] })).status, 413);
  assert.equal((await raw(local, { method: 'POST', chunks: ['1234'] })).status, 200);
  assert.equal((await raw(local, { headers: { 'content-length': '1' }, chunks: ['a'] })).status, 400);
  const hung = await server(t, () => new Promise(() => {}), { requestTimeoutMs: 30 });
  assert.equal((await raw(hung)).status, 503);
});
test('static client never uses unsafe rendering or persistent browser state', async () => {
  const handle = await createWebClientHandler({ handle: fallback, canonicalOrigin: origin });
  for (const path of ['/assets/editor.mjs', '/assets/controller.mjs']) {
    const code = await (await handle(new Request(origin + path))).text();
    assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|indexedDB|document\.cookie|WebSocket/);
  }
  const html = await (await handle(new Request(origin))).text();
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)|\bonclick=/);
  assert.match(html, /<textarea id="document-content"/);
});
