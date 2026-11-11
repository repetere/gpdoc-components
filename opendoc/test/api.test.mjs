import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenDocHandler } from '../src/api.mjs';
import { MemoryDocumentStore } from '../src/memory-store.mjs';

const identities = {
  alice: { principalId: 'alice', tenantId: 'team-a', role: 'editor' },
  bob: { principalId: 'bob', tenantId: 'team-b', role: 'owner' },
  viewer: { principalId: 'view', tenantId: 'team-a', role: 'viewer' },
  commenter: { principalId: 'comment', tenantId: 'team-a', role: 'commenter' }
};
function setup(extra = {}) {
  const store = new MemoryDocumentStore();
  const handle = createOpenDocHandler({ store, authenticate: async r => identities[r.headers.get('authorization')?.replace('Bearer ', '')] ?? null, ...extra });
  const request = (path, { token = 'alice', method = 'GET', body, headers = {} } = {}) => handle(new Request(`http://localhost${path}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
  }));
  return { request, store };
}
const doc = { id: 'brief', title: 'Brief', content: '# Hello\n' };

// @spec OD-API-001, OD-API-009
test('capabilities disclose exactly the reference features', async () => {
  const { request } = setup();
  const r = await request('/api/v1/capabilities', { token: null });
  assert.equal(r.status, 200);
  const c = await r.json();
  assert.equal(c.storage, 'volatile-memory');
  assert.equal(c.authorization, 'tenant-roles');
  assert.equal(c.features.liveCollaboration, false);
  assert.equal(c.features.enterpriseLogin, false);
  assert.equal(c.features.airgapVerified, false);
});
// @spec OD-API-002
test('all document and session routes need authentication', async () => {
  const { request } = setup();
  for (const path of ['/api/v1/session', '/api/v1/documents', '/api/v1/documents/brief']) {
    assert.equal((await request(path, { token: null })).status, 401);
    assert.equal((await request(path, { token: 'wrong' })).status, 401);
  }
});
// @spec OD-API-003, OD-API-007
test('create, list and read preserve opaque content inside one tenant', async () => {
  const { request } = setup();
  const content = '<script>never execute</script>\r\nhttps://not-fetched.example/\n🌿';
  const created = await request('/api/v1/documents', { method: 'POST', body: { ...doc, content } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('etag'), '"1"');
  assert.equal((await created.json()).content, content);
  const list = await (await request('/api/v1/documents')).json();
  assert.equal(list.documents.length, 1);
  assert.equal('content' in list.documents[0], false);
  const read = await request('/api/v1/documents/brief');
  assert.equal((await read.json()).content, content);
  assert.equal(read.headers.get('cache-control'), 'no-store');
});
// @spec OD-API-003
test('equal IDs in two tenants do not cross read or write boundaries', async () => {
  const { request } = setup();
  await request('/api/v1/documents', { method: 'POST', body: doc });
  assert.equal((await request('/api/v1/documents/brief', { token: 'bob' })).status, 404);
  const b = await request('/api/v1/documents', { token: 'bob', method: 'POST', body: { ...doc, content: 'B' } });
  assert.equal(b.status, 201);
  assert.equal((await (await request('/api/v1/documents/brief')).json()).content, doc.content);
  assert.equal((await (await request('/api/v1/documents/brief', { token: 'bob' })).json()).content, 'B');
});
// @spec OD-API-003, OD-API-006
test('client tenant/role fields and unknown properties never grant authority', async () => {
  const { request } = setup();
  for (const extra of [{ tenantId: 'team-b' }, { role: 'owner' }, { url: 'https://bad.example' }]) {
    assert.equal((await request('/api/v1/documents', { method: 'POST', body: { ...doc, ...extra } })).status, 400);
  }
  assert.equal((await request('/api/v1/documents', { method: 'POST', body: '{"id":"x","title":"x","content":"x","__proto__":{}}' })).status, 400);
  assert.equal((await request('/api/v1/documents?tenantId=team-b')).status, 400);
});
// @spec OD-API-004
test('viewers/commenters can read but cannot create or replace', async () => {
  const { request } = setup();
  await request('/api/v1/documents', { method: 'POST', body: doc });
  for (const token of ['viewer', 'commenter']) {
    assert.equal((await request('/api/v1/documents/brief', { token })).status, 200);
    assert.equal((await request('/api/v1/documents', { token, method: 'POST', body: { ...doc, id: 'other' } })).status, 403);
    assert.equal((await request('/api/v1/documents/brief', { token, method: 'PUT', body: { title: 'x', content: 'x' }, headers: { 'if-match': '"1"' } })).status, 403);
  }
  assert.equal((await (await request('/api/v1/documents/brief')).json()).content, doc.content);
});
// @spec OD-API-005
test('conditional updates reject missing/stale/wildcard revisions', async () => {
  const { request } = setup();
  await request('/api/v1/documents', { method: 'POST', body: doc });
  const body = { title: 'Updated', content: 'new' };
  assert.equal((await request('/api/v1/documents/brief', { method: 'PUT', body })).status, 428);
  for (const value of ['*', '1', 'W/"1"', '"1", "2"', '"0"']) {
    assert.equal((await request('/api/v1/documents/brief', { method: 'PUT', body, headers: { 'if-match': value } })).status, 412);
  }
  const ok = await request('/api/v1/documents/brief', { method: 'PUT', body, headers: { 'if-match': '"1"' } });
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('etag'), '"2"');
  assert.equal((await request('/api/v1/documents/brief', { method: 'PUT', body, headers: { 'if-match': '"1"' } })).status, 412);
});
// @spec OD-API-005
test('concurrent writers using the same revision produce one winner', async () => {
  const { request } = setup(); await request('/api/v1/documents', { method: 'POST', body: doc });
  const results = await Promise.all(['one', 'two'].map(content => request('/api/v1/documents/brief', { method: 'PUT', body: { title: 'x', content }, headers: { 'if-match': '"1"' } })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 412]);
});
// @spec OD-API-006
test('duplicates, malformed JSON, oversized bodies and IDs are bounded', async () => {
  const { request } = setup();
  assert.equal((await request('/api/v1/documents', { method: 'POST', body: doc })).status, 201);
  assert.equal((await request('/api/v1/documents', { method: 'POST', body: doc })).status, 409);
  for (const body of ['{bad', '[]', 'null', { ...doc, id: '../bad' }, { ...doc, id: 'x'.repeat(65) }, { ...doc, title: 'x'.repeat(201) }, { ...doc, content: 2 }]) {
    assert.equal((await request('/api/v1/documents', { method: 'POST', body })).status, 400);
  }
  assert.equal((await request('/api/v1/documents', { method: 'POST', body: { ...doc, content: 'x'.repeat(1024 * 1024 + 1) } })).status, 413);
  assert.equal((await request('/api/v1/documents/%2Fetc')).status, 400);
});
// @spec OD-API-006
test('wrong media type and unsupported methods fail without mutation', async () => {
  const { request } = setup();
  assert.equal((await request('/api/v1/documents', { method: 'POST', body: doc, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request('/api/v1/documents/brief', { method: 'DELETE' })).status, 405);
});
// @spec OD-API-008
test('origin policy is explicit, validates preflight, and never grants auth', async () => {
  const { request } = setup({ allowedOrigins: ['https://editor.example'] });
  assert.equal((await request('/api/v1/documents', { headers: { origin: 'https://evil.example' } })).status, 403);
  const preflight = await request('/api/v1/documents', { method: 'OPTIONS', token: null, headers: { origin: 'https://editor.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,if-match' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://editor.example');
  assert.equal((await request('/api/v1/documents', { token: null, headers: { origin: 'https://editor.example' } })).status, 401);
  assert.equal((await request('/api/v1/documents', { method: 'OPTIONS', headers: { origin: 'https://editor.example', 'access-control-request-method': 'DELETE' } })).status, 403);
  for (const origin of ['', 'null', 'https://editor.example, https://evil.example']) {
    assert.equal((await request('/api/v1/session', { headers: { origin } })).status, 403);
  }
});
// @spec OD-API-003, OD-PROFILE-001
test('API tenant IDs share the signed profile grammar', async () => {
  const { request } = setup({ authenticate: async () => ({ principalId: 'a', tenantId: 'team.example', role: 'editor' }) });
  assert.equal((await request('/api/v1/documents', { method: 'POST', body: doc })).status, 201);
  const long = setup({ authenticate: async () => ({ principalId: 'a', tenantId: 't'.repeat(128), role: 'viewer' }) });
  assert.equal((await long.request('/api/v1/session')).status, 200);
});
// @spec OD-API-003
test('invalid server authentication results fail closed', async () => {
  for (const principal of [{ principalId: 'a', tenantId: 'a', role: 'admin' }, { principalId: '', tenantId: 'a', role: 'editor' }, { principalId: 'a', tenantId: '../b', role: 'editor' }]) {
    const { request } = setup({ authenticate: async () => principal });
    assert.equal((await request('/api/v1/documents')).status, 401);
  }
});
// @spec OD-API-002
test('auth/store errors are sanitized', async () => {
  const { request } = setup({ authenticate: async () => { throw new Error('do-not-leak'); } });
  const response = await request('/api/v1/documents');
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('do-not-leak'));
  const failedStore = new MemoryDocumentStore();
  failedStore.list = () => { throw new Error('database-password-must-not-leak'); };
  const stored = await setup({ store: failedStore }).request('/api/v1/documents');
  assert.equal(stored.status, 503); assert.ok(!(await stored.text()).includes('password'));
});
