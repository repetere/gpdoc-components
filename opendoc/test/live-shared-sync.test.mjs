// @spec OD-LIVE-SHARED-001 OD-LIVE-SHARED-002 OD-LIVE-SHARED-004
// Original MIT transport tests. A synthetic shared adapter is not database proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { MemoryLiveDocumentStore } from '../src/live-document-store.mjs';
import { startLocalCollaborationServer } from '../src/collaboration-server.mjs';
import { decodeStateFrame } from '../src/collaboration-client.mjs';
import { encodeLiveUpdateFrame } from '../src/live-collaboration-client.mjs';

const ORIGIN = 'https://editor.example.test';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const deadline = Date.now() + 3000; while (!check()) { if (Date.now() > deadline) throw new Error('Condition timed out'); await delay(5); } }
async function adapter() {
  const memory = new MemoryLiveDocumentStore();
  await memory.create('tenant', { id: 'document', title: 'Title', content: 'text' });
  const value = { kind: 'postgresql-live-documents', polls: 0,
    get: (...args) => memory.get(...args), applyUpdate: (...args) => memory.applyUpdate(...args),
    async getIfChanged(tenant, id, revision) {
      value.polls++;
      const doc = await memory.get(tenant, id);
      if (!doc) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' });
      if (doc.revision < revision) throw Object.assign(new Error('regression'), { code: 'DEPENDENCY_UNAVAILABLE' });
      return doc.revision === revision ? null : doc;
    } };
  return value;
}
async function fixture(t, liveStore, options = {}) {
  const server = await startLocalCollaborationServer({ liveStore,
    authenticate: () => ({ principalId: 'person', tenantId: 'tenant', role: 'editor' }),
    allowedOrigins: [ORIGIN], ...options });
  t.after(() => server.close());
  return server;
}
async function peer(t, server, path = '/api/v1/live-documents/document/collaboration') {
  const ws = new WebSocket(server.url + path, { origin: ORIGIN });
  const frames = [];
  ws.on('error', () => {});
  ws.on('message', (data, binary) => frames.push(binary ? decodeStateFrame(data) : JSON.parse(data.toString())));
  const closed = new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  t.after(() => ws.terminate());
  await once(ws, 'open');
  ws.send('{"type":"authenticate","token":"editor"}');
  const next = async () => { await until(() => frames.length > 0); return frames.shift(); };
  assert.equal((await next()).type, 'ready');
  const initial = await next();
  return { ws, frames, initial, next, closed, send: (sequence, update) => ws.send(encodeLiveUpdateFrame(update, sequence)) };
}
function content(frame) {
  const doc = new Y.Doc();
  try { Y.applyUpdate(doc, frame.state); return doc.getText('content').toString(); } finally { doc.destroy(); }
}

test('shared live sync requires explicit PostgreSQL adapter and strict bounded options', async t => {
  const store = await adapter();
  for (const sharedLiveSync of [null, false, true, [], { other: 1 }, { intervalMs: null }, { intervalMs: undefined },
    { intervalMs: 0 }, { intervalMs: 49 }, { intervalMs: 30001 }, { intervalMs: 50.5 }, { intervalMs: '50' }]) {
    await assert.rejects(fixture(t, store, { sharedLiveSync }), /sharedLiveSync/);
  }
  await assert.rejects(fixture(t, new MemoryLiveDocumentStore(), { sharedLiveSync: {} }), /PostgreSQL/);
  await assert.rejects(fixture(t, { ...store, getIfChanged: undefined }, { sharedLiveSync: {} }), /PostgreSQL/);
  const server = await fixture(t, store, { sharedLiveSync: {} });
  const client = await peer(t, server); assert.equal(client.initial.revision, 1);
});

test('independent transports automatically receive commits and deletion-only edits without synthetic ACKs', async t => {
  const store = await adapter();
  const a = await peer(t, await fixture(t, store, { sharedLiveSync: { intervalMs: 50 } }));
  const b = await peer(t, await fixture(t, store, { sharedLiveSync: { intervalMs: 50 } }));
  const doc = new Y.Doc(); t.after(() => doc.destroy()); Y.applyUpdate(doc, a.initial.state);
  doc.getText('content').insert(4, ' changed'); const update = Y.encodeStateAsUpdate(doc);
  a.send(1, update);
  assert.equal(content(await a.next()), 'text changed');
  assert.deepEqual(await a.next(), { type: 'ack', sequence: 1, revision: 2 });
  assert.equal(content(await b.next()), 'text changed');
  assert.equal(b.frames.length, 0);
  const before = Y.encodeStateVector(doc); doc.getText('content').delete(0, 12);
  const deletion = Y.encodeStateAsUpdate(doc, before); a.send(2, deletion);
  assert.equal(content(await a.next()), '');
  assert.deepEqual(await a.next(), { type: 'ack', sequence: 2, revision: 3 });
  assert.equal(content(await b.next()), '');
  // Replaying a committed delete needs its own sequence ACK, but no duplicate payload.
  a.send(3, deletion);
  assert.deepEqual(await a.next(), { type: 'ack', sequence: 3, revision: 3 });
  await delay(120);
  assert.equal(a.frames.length, 0); assert.equal(b.frames.length, 0);
});

test('unchanged and retired live rooms do not generate payloads or continuing dependency work', async t => {
  const store = await adapter();
  const server = await fixture(t, store, { sharedLiveSync: { intervalMs: 50 } });
  await delay(110); assert.equal(store.polls, 0);
  const client = await peer(t, server);
  await until(() => store.polls >= 2); assert.equal(client.frames.length, 0);
  client.ws.send('{"type":"sync"}'); assert.equal((await client.next()).revision, 1);
  client.ws.close(); await client.closed;
  await until(() => server.stats().rooms === 0 && server.stats().pendingOperations === 0);
  const polls = store.polls; await delay(120); assert.equal(store.polls, polls);
});

test('default live mode and standalone v1 remain process-local even with shared option elsewhere', async t => {
  const liveStore = await adapter();
  const local = await fixture(t, liveStore); const live = await peer(t, local);
  await delay(110); assert.equal(liveStore.polls, 0); assert.equal(live.frames.length, 0);
  let reads = 0;
  const store = { get: async () => { reads++; return null; }, applyUpdate: async () => { throw new Error('unused'); } };
  const mixed = await fixture(t, liveStore, { store, sharedLiveSync: { intervalMs: 50 } });
  const standalone = await peer(t, mixed, '/api/v1/collaboration/document');
  assert.equal(standalone.initial.revision, 0);
  await delay(110); assert.equal(liveStore.polls, 0); assert.equal(reads, 1);
});
