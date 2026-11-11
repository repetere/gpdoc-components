// @spec OD-LIVE-001 OD-LIVE-003
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { createOpenDocHandler } from '../src/api.mjs';
import { MemoryDocumentStore } from '../src/memory-store.mjs';
import { MemoryLiveDocumentStore } from '../src/live-document-store.mjs';

function setup(live = true) {
  const store = new MemoryDocumentStore(); const liveStore = new MemoryLiveDocumentStore();
  const handle = createOpenDocHandler({ store, ...(live ? { liveStore } : {}), authenticate: request => {
    const token = request.headers.get('authorization');
    if (!token) return null;
    return { principalId: 'person', tenantId: token === 'Bearer other' ? 'two' : 'one', role: token === 'Bearer view' ? 'viewer' : token === 'Bearer comment' ? 'commenter' : 'editor' };
  } });
  const request = (path, method = 'GET', body, token = 'edit', headers = {}) => handle(new Request(`https://example.test${path}`, { method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  return { store, liveStore, request };
}
const collection = '/api/v1/live-documents';
const input = { id: 'shared', title: 'Live title', content: 'Live body' };

test('live endpoints are explicitly opt in; existing REST behavior/capabilities stay unchanged', async () => {
  const off = setup(false); assert.equal((await off.request(collection)).status, 404);
  assert.equal((await (await off.request('/api/v1/capabilities')).json()).features.liveCollaboration, false);
  const on = setup(); const capabilities = await (await on.request('/api/v1/capabilities')).json();
  assert.equal(capabilities.features.liveCollaboration, false); assert.equal(capabilities.liveDocuments.protocol, 'opendoc-yjs-2');
  assert.equal((await on.request('/api/v1/documents', 'POST', input)).status, 201);
  assert.equal((await on.request(collection, 'POST', input)).status, 201);
  assert.equal((await on.request(`${collection}/shared`, 'PUT', { title: 'No', content: 'Overwrite' }, 'edit', { 'if-match': '"1"' })).status, 405);
  assert.equal((await on.request('/api/v1/documents/shared', 'PUT', { title: 'REST only', content: 'Rest' }, 'edit', { 'if-match': '"1"' })).status, 200);
  const live = await (await on.request(`${collection}/shared`)).json(); assert.equal(live.title, 'Live title'); assert.equal(live.content, 'Live body');
});

test('create/list/read projections are authenticated, role checked, scoped and never expose snapshot replacement', async () => {
  const f = setup();
  for (const path of [collection, `${collection}/shared`]) assert.equal((await f.request(path, 'GET', undefined, null)).status, 401);
  for (const token of ['view', 'comment']) assert.equal((await f.request(collection, 'POST', input, token)).status, 403);
  const created = await f.request(collection, 'POST', input); assert.equal(created.status, 201); assert.equal(created.headers.get('location'), `${collection}/shared`); assert.equal(created.headers.get('etag'), null);
  const doc = await created.json(); assert.equal(doc.authority, 'yjs'); assert.equal(doc.revision, 1); assert.equal(doc.state, undefined);
  assert.equal((await f.request(collection, 'POST', input)).status, 409);
  assert.equal((await f.request(`${collection}/shared`, 'GET', undefined, 'other')).status, 404);
  const listing = await (await f.request(collection, 'GET', undefined, 'view')).json(); assert.equal(listing.documents[0].title, input.title); assert.equal(listing.documents[0].content, undefined);
  const read = await (await f.request(`${collection}/shared`, 'GET', undefined, 'comment')).json(); assert.equal(read.content, input.content);
  const base = await f.liveStore.get('one', 'shared'); const ydoc = new Y.Doc(); Y.applyUpdate(ydoc, base.state); ydoc.getText('content').insert(input.content.length, ' via Yjs');
  await f.liveStore.applyUpdate('one', 'shared', Y.encodeStateAsUpdate(ydoc)); ydoc.destroy();
  const reopened = await (await f.request(`${collection}/shared`)).json(); assert.equal(reopened.content, 'Live body via Yjs'); assert.equal(reopened.revision, 2);
  assert.equal((await f.request(collection, 'POST', { ...input, id: 'injected', tenantId: 'two' })).status, 400);
  assert.equal((await f.request(collection, 'POST', { ...input, id: 'large', content: 'x'.repeat(262145) })).status, 413);
});
