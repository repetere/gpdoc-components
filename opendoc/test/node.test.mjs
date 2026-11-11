import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect } from 'node:net';
import { createOpenDocHandler } from '../src/api.mjs';
import { MemoryDocumentStore } from '../src/memory-store.mjs';
import { startLocalServer, createDevelopmentAuthenticator } from '../src/node-adapter.mjs';

// @spec OD-API-010: Real HTTP, not just direct handler calls.
test('local HTTP adapter supports authenticated create/read/revision update', async t => {
  const development = createDevelopmentAuthenticator();
  assert.match(development.token, /^[A-Za-z0-9_-]{43}$/);
  const server = await startLocalServer({ port: 0, handle: createOpenDocHandler({ store: new MemoryDocumentStore(), authenticate: development.authenticate }) });
  t.after(() => server.close());
  const headers = { authorization: `Bearer ${development.token}`, 'content-type': 'application/json' };
  const doc = { id: 'demo', title: 'Demo', content: '# Local' };
  assert.equal((await fetch(`${server.url}/healthz`)).status, 200);
  assert.equal((await fetch(`${server.url}/api/v1/documents`)).status, 401);
  assert.equal((await fetch(`${server.url}/api/v1/documents?token=${development.token}`)).status, 400);
  let response = await fetch(`${server.url}/api/v1/documents`, { method: 'POST', headers, body: JSON.stringify(doc) });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('etag'), '"1"');
  response = await fetch(`${server.url}/api/v1/documents/demo`, { headers });
  assert.equal((await response.json()).content, '# Local');
  response = await fetch(`${server.url}/api/v1/documents/demo`, { method: 'PUT', headers: { ...headers, 'if-match': '"1"' }, body: JSON.stringify({ title: 'Demo', content: 'updated' }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('etag'), '"2"');
});
// @spec OD-API-010
test('development tokens are unique and exact bearer values only', async () => {
  const a = createDevelopmentAuthenticator(); const b = createDevelopmentAuthenticator();
  assert.notEqual(a.token, b.token);
  for (const authorization of ['', `Bearer ${b.token}`, `Basic ${a.token}`, `Bearer ${a.token}x`]) {
    assert.equal(await a.authenticate(new Request('http://localhost', { headers: { authorization } })), null);
  }
  const p = await a.authenticate(new Request('http://localhost', { headers: { authorization: `Bearer ${a.token}` } }));
  assert.equal(p.tenantId, 'local'); assert.equal(p.role, 'owner');
});
// @spec OD-API-010
test('local server rejects an attempted non-loopback binding', async () => {
  await assert.rejects(startLocalServer({ host: '0.0.0.0', port: 0, handle: () => new Response() }), /loopback/);
  await assert.rejects(startLocalServer({ port: -1, handle: () => new Response() }), /port/i);
});
// @spec OD-API-002
test('HTTP adapter sanitizes handler failures', async t => {
  const server = await startLocalServer({ port: 0, handle: () => { throw new Error('private data'); } });
  t.after(() => server.close());
  const r = await fetch(`${server.url}/`);
  assert.equal(r.status, 503); assert.ok(!(await r.text()).includes('private data'));
});
// @spec OD-API-006, OD-API-010
test('raw HTTP targets reject URL parser normalization and fragment/query tokens', async t => {
  const server = await startLocalServer({ port: 0, handle: () => new Response('ok') });
  t.after(() => server.close());
  for (const target of ['/api\\v1\\session', '/api/v1/documents/%2e%2e/session', '/api/v1/session#', '/api/v1/session?', '//other.example/api/v1/session', '/api/../healthz']) {
    const response = await new Promise((resolve, reject) => {
      const socket = connect(Number(new URL(server.url).port), '127.0.0.1');
      let data = '';
      socket.on('connect', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
      socket.on('data', chunk => { data += chunk; });
      socket.on('end', () => resolve(data)); socket.on('error', reject);
    });
    assert.match(response, /^HTTP\/1\.1 400 /, target);
  }
});
// @spec OD-API-006
test('memory capacity and returned snapshots cannot silently corrupt a store', () => {
  const store = new MemoryDocumentStore({ maxDocumentsPerTenant: 1, maxBytes: 100 });
  const input = { id: 'a', title: 'A', content: 'hello' };
  const created = store.create('tenant', input);
  created.content = 'mutated'; input.content = 'also mutated';
  assert.equal(store.get('tenant', 'a').content, 'hello');
  assert.throws(() => store.create('tenant', { id: 'b', title: '', content: '' }), /CAPACITY_EXCEEDED/);
  assert.throws(() => store.replace('tenant', 'a', 1, { title: '', content: 'x'.repeat(101) }), /CAPACITY_EXCEEDED/);
  assert.equal(store.get('tenant', 'a').revision, 1);
  store.list('tenant')[0].title = 'mutated';
  assert.equal(store.get('tenant', 'a').title, 'A');
});
