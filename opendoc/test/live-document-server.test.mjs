// @spec OD-LIVE-002 OD-LIVE-003 OD-LIVE-004
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { MemoryLiveDocumentStore } from '../src/live-document-store.mjs';
import { startLocalCollaborationServer } from '../src/collaboration-server.mjs';
import { decodeStateFrame } from '../src/collaboration-client.mjs';
const ORIGIN = 'https://example.test';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, overrides = {}) {
  const liveStore = overrides.liveStore ?? new MemoryLiveDocumentStore();
  if (!await liveStore.get('one', 'live')) await liveStore.create('one', { id: 'live', title: 'Title', content: 'Initial' });
  const memberships = new Map(['edit', 'view', 'other'].map(token => [token, { principalId: token, tenantId: token === 'other' ? 'two' : 'one', role: token === 'view' ? 'viewer' : 'editor' }]));
  const paths = [];
  const server = await startLocalCollaborationServer({ liveStore, authenticate: request => {
    paths.push(new URL(request.url).pathname); return memberships.get(request.headers.get('authorization')?.slice(7));
  }, allowedOrigins: [ORIGIN], ...overrides });
  t.after(() => server.close());
  return { server, liveStore, memberships, paths, url: `${server.url}/api/v1/live-documents/live/collaboration` };
}
async function peer(t, url, token = 'edit', ready = true) {
  const ws = new WebSocket(url, { origin: ORIGIN }); const frames = [], waiting = [];
  ws.on('message', (data, binary) => { const value = binary ? decodeStateFrame(data) : JSON.parse(data); if (waiting.length) waiting.shift()(value); else frames.push(value); });
  const closed = new Promise(resolve => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  ws.on('error', () => {}); t.after(() => ws.terminate()); await once(ws, 'open');
  const next = () => new Promise((resolve, reject) => { if (frames.length) return resolve(frames.shift()); const timer = setTimeout(() => reject(new Error('Missing live frame')), 3000); waiting.push(value => { clearTimeout(timer); resolve(value); }); });
  ws.send(JSON.stringify({ type: 'authenticate', token }));
  const client = { ws, frames, closed, next, send(sequence, update) { const bytes = Buffer.alloc(5 + update.length); bytes[0] = 3; bytes.writeUInt32BE(sequence, 1); bytes.set(update, 5); ws.send(bytes); } };
  if (ready) { assert.deepEqual(await next(), { type: 'ready', protocol: 'opendoc-yjs-2', role: token === 'view' ? 'viewer' : 'editor' }); client.initial = await next(); }
  return client;
}
function editing(state, mutate) { const doc = new Y.Doc(); Y.applyUpdate(doc, state); const before = Y.encodeStateVector(doc); mutate(doc); const update = Y.encodeStateAsUpdate(doc, before); doc.destroy(); return update; }

test('live sockets only reopen existing scoped documents and reject missing docs before ready', async t => {
  const f = await fixture(t); const a = await peer(t, f.url); assert.equal(a.initial.revision, 1);
  for (const [url, token] of [[f.url, 'other'], [f.url.replace('/live/', '/missing/'), 'edit']]) {
    const denied = await peer(t, url, token, false); assert.equal((await denied.closed).code, 1008); assert.deepEqual(denied.frames, []);
  }
  assert.equal(await f.liveStore.get('two', 'live'), null); assert.equal(await f.liveStore.get('one', 'missing'), null);
  assert.ok(f.paths.every(path => path.startsWith('/api/v1/live-documents/')));
});

test('durable sender ack follows state; deletion-only updates and replay get explicit acknowledgments', async t => {
  const f = await fixture(t); const a = await peer(t, f.url), viewer = await peer(t, f.url, 'view');
  const remove = editing(a.initial.state, doc => doc.getText('content').delete(0, 1));
  a.send(1, remove); const state = await a.next(); assert.equal(state.revision, 2);
  assert.deepEqual(await a.next(), { type: 'ack', sequence: 1, revision: 2 }); assert.equal((await viewer.next()).revision, 2); assert.equal(viewer.frames.length, 0);
  assert.equal((await f.liveStore.get('one', 'live')).content, 'nitial');
  a.send(2, remove); assert.equal((await a.next()).revision, 2); assert.deepEqual(await a.next(), { type: 'ack', sequence: 2, revision: 2 });
  assert.equal((await viewer.next()).revision, 2);
  await f.server.close(); const reopened = await fixture(t, { liveStore: f.liveStore }); const fresh = await peer(t, reopened.url); assert.equal(fresh.initial.revision, 2);
});

test('no state or ack before commit; failed/ambiguous commit disconnects every reader without false success', async t => {
  const store = new MemoryLiveDocumentStore(); const original = store.applyUpdate.bind(store); const entered = deferred(), release = deferred();
  store.applyUpdate = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
  const f = await fixture(t, { liveStore: store }); const a = await peer(t, f.url), b = await peer(t, f.url, 'view');
  a.send(1, editing(a.initial.state, doc => doc.getText('title').insert(0, 'New '))); await entered.promise; await delay(30);
  assert.deepEqual(a.frames, []); assert.deepEqual(b.frames, []); release.resolve();
  assert.equal((await a.next()).revision, 2); assert.deepEqual(await a.next(), { type: 'ack', sequence: 1, revision: 2 }); await b.next();
  store.applyUpdate = async (...args) => { await original(...args); throw new Error('lost commit response containing private connection string'); };
  a.send(2, editing((await store.get('one', 'live')).state, doc => doc.getText('content').insert(0, 'Uncertain ')));
  assert.equal((await a.closed).code, 1011); assert.equal((await b.closed).code, 1011); assert.deepEqual(a.frames, []); assert.deepEqual(b.frames, []);
  const reconnected = await peer(t, f.url); assert.equal(reconnected.initial.revision, 3);
});

test('readers and invalid sequence/frame cannot mutate, revoked recipients cannot receive update/ack', async t => {
  const f = await fixture(t); const viewer = await peer(t, f.url, 'view');
  viewer.send(1, editing(viewer.initial.state, doc => doc.getText('content').insert(0, 'Forbidden'))); assert.equal((await viewer.closed).code, 1008);
  for (const sequence of [0, 2]) { const a = await peer(t, f.url); a.send(sequence, new Uint8Array([0, 0])); assert.equal((await a.closed).code, 1008); assert.deepEqual(a.frames, []); }
  const legacy = await peer(t, f.url); legacy.ws.send(Buffer.from([1, 0, 0])); assert.equal((await legacy.closed).code, 1008);
  assert.equal((await f.liveStore.get('one', 'live')).revision, 1);
  const a = await peer(t, f.url), b = await peer(t, f.url, 'view'); f.memberships.delete('view');
  a.send(1, editing(a.initial.state, doc => doc.getText('content').insert(0, 'Allowed '))); await a.next(); await a.next();
  assert.equal((await b.closed).code, 1008); assert.deepEqual(b.frames, []);
});

test('full retained-state replay above standalone 64KiB limit is admitted only on live protocol', async t => {
  const f = await fixture(t); const a = await peer(t, f.url); const doc = new Y.Doc(); Y.applyUpdate(doc, a.initial.state); doc.getText('content').insert(0, 'x'.repeat(80000));
  a.send(1, Y.encodeStateAsUpdate(doc)); await a.next(); assert.deepEqual(await a.next(), { type: 'ack', sequence: 1, revision: 2 });
  assert.equal((await f.liveStore.get('one', 'live')).content.length, 80007); doc.destroy();
});
