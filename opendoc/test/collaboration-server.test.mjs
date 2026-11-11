// @spec OD-COLLAB-001 OD-COLLAB-002 OD-COLLAB-003 OD-COLLAB-004 OD-COLLAB-007
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { startLocalCollaborationServer, attachCollaborationServer } from '../src/collaboration-server.mjs';
import { encodeUpdateFrame, decodeStateFrame } from '../src/collaboration-client.mjs';

const ORIGIN = 'https://editor.example.test';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { const deadline = Date.now() + 3000; while (!predicate()) { if (Date.now() >= deadline) throw new Error('Timed out waiting for server cleanup'); await delay(5); } }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function storeFixture() {
  const records = new Map();
  return {
    records,
    async get(tenant, room) { const value = records.get(JSON.stringify([tenant, room])); return value ? { state: value.state.slice(), revision: value.revision } : null; },
    async applyUpdate(tenant, room, update) {
      const key = JSON.stringify([tenant, room]); const current = records.get(key); const doc = new Y.Doc();
      try {
        if (current) Y.applyUpdate(doc, current.state);
        try { Y.applyUpdate(doc, update); } catch { throw Object.assign(new Error('BAD_REQUEST'), { code: 'BAD_REQUEST' }); }
        const state = Y.encodeStateAsUpdate(doc);
        const same = current && Buffer.from(current.state).equals(Buffer.from(state));
        const value = { state, revision: same ? current.revision : (current?.revision ?? 0) + 1 };
        records.set(key, value); return value;
      } finally { doc.destroy(); }
    }
  };
}
async function fixture(t, extra = {}) {
  const store = extra.store ?? storeFixture();
  const memberships = new Map([
    ['edit', { principalId: 'editor', tenantId: 'one', role: 'editor' }],
    ['view', { principalId: 'viewer', tenantId: 'one', role: 'viewer' }],
    ['comment', { principalId: 'commenter', tenantId: 'one', role: 'commenter' }],
    ['other', { principalId: 'editor2', tenantId: 'two', role: 'editor' }]
  ]);
  const requests = [];
  const authenticate = request => { requests.push(request); return memberships.get(request.headers.get('authorization')?.slice(7)) ?? null; };
  const server = await startLocalCollaborationServer({ store, authenticate, allowedOrigins: [ORIGIN], ...extra });
  t.after(() => server.close());
  return { server, store, memberships, requests, url: `${server.url}/api/v1/collaboration/room` };
}
async function peer(t, url, token = 'edit', options = {}) {
  const ws = new WebSocket(url, { origin: ORIGIN, ...options });
  const frames = []; const waiters = [];
  ws.on('message', (data, binary) => { const frame = binary ? decodeStateFrame(data) : JSON.parse(data.toString()); if (waiters.length) waiters.shift()(frame); else frames.push(frame); });
  const closed = new Promise(resolve => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  ws.on('error', () => {});
  t.after(() => ws.terminate());
  await once(ws, 'open');
  function next() { return new Promise((resolve, reject) => { if (frames.length) { resolve(frames.shift()); return; } const timer = setTimeout(() => reject(new Error('Missing frame')), 3000); waiters.push(frame => { clearTimeout(timer); resolve(frame); }); }); }
  const value = { ws, frames, next, closed, sendUpdate: update => ws.send(encodeUpdateFrame(update)) };
  if (token !== null) { ws.send(JSON.stringify({ type: 'authenticate', token })); assert.equal((await next()).type, 'ready'); value.initial = await next(); }
  return value;
}
function edit(text) { const doc = new Y.Doc(); doc.getText('body').insert(0, text); return { doc, update: Y.encodeStateAsUpdate(doc) }; }
function body(snapshot) { const doc = new Y.Doc(); try { Y.applyUpdate(doc, snapshot.state); return doc.getText('body').toString(); } finally { doc.destroy(); } }
async function deniedUpgrade(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.on('unexpected-response', (_request, response) => { const status = response.statusCode; response.resume(); ws.terminate(); resolve(status); });
    ws.on('error', () => {});
    ws.on('open', () => { ws.terminate(); reject(new Error('Unexpected successful upgrade')); });
  });
}

test('two network clients converge, tenant rooms isolate, duplicate replay and restart retain state', async t => {
  const f = await fixture(t);
  const [a, b, other] = await Promise.all([peer(t, f.url), peer(t, f.url), peer(t, f.url, 'other')]);
  assert.equal(a.initial.revision, 0); assert.equal(body(other.initial), '');
  const left = edit('left'); const right = edit('right');
  a.sendUpdate(left.update); b.sendUpdate(right.update);
  const a1 = await a.next(); const a2 = await a.next(); const b1 = await b.next(); const b2 = await b.next();
  assert.deepEqual([a1.revision, a2.revision], [1, 2]); assert.deepEqual([b1.revision, b2.revision], [1, 2]);
  assert.equal(body(a2), body(b2)); assert.ok(body(a2).includes('left')); assert.ok(body(a2).includes('right'));
  assert.equal(other.frames.length, 0);
  a.sendUpdate(left.update); assert.equal((await a.next()).revision, 2); assert.equal((await b.next()).revision, 2);
  await f.server.close();
  const restarted = await fixture(t, { store: f.store });
  const c = await peer(t, restarted.url); assert.equal(body(c.initial), body(a2)); assert.equal(c.initial.revision, 2);
  assert.ok(f.requests.every(request => request.url === 'http://opendoc.invalid/api/v1/collaboration/room' && request.headers.get('authorization').startsWith('Bearer ')));
});

test('viewer and commenter receive snapshots but cannot mutate', async t => {
  const f = await fixture(t); const editor = await peer(t, f.url);
  editor.sendUpdate(edit('saved').update); await editor.next();
  for (const token of ['view', 'comment']) {
    const reader = await peer(t, f.url, token); assert.equal(body(reader.initial), 'saved');
    reader.sendUpdate(edit('forbidden').update); assert.equal((await reader.closed).code, 1008);
  }
  assert.equal((await f.store.get('one', 'room')).revision, 1);
});

test('upgrade rejects missing/foreign/empty origins, query credentials, aliases and ambient credential mechanisms', async t => {
  const f = await fixture(t);
  assert.equal(await deniedUpgrade(f.url), 403);
  assert.equal(await deniedUpgrade(f.url, { origin: 'https://evil.example' }), 403);
  for (const url of [f.url + '?token=secret', f.url.replace('/room', '/%72oom'), f.url + '/extra']) {
    assert.equal(await deniedUpgrade(url, { origin: ORIGIN }), 400);
  }
  assert.equal(await deniedUpgrade(f.url, { origin: ORIGIN, headers: { Authorization: 'Bearer edit' } }), 400);
  const cookie = await peer(t, f.url, 'edit', { headers: { Cookie: 'session=not-authentication' } });
  assert.equal(cookie.initial.revision, 0); assert.ok(f.requests.every(request => !request.headers.has('cookie')));
  const native = await fixture(t, { allowMissingOrigin: true });
  assert.equal(await deniedUpgrade(native.url, { headers: { Origin: '' } }), 403);
  const nativePeer = await peer(t, native.url, 'edit', { origin: undefined }); assert.equal(nativePeer.initial.revision, 0);
});

test('strict first frame, identity types and authentication timeout expose no state or token', async t => {
  const f = await fixture(t, { limits: { authenticationTimeoutMs: 80 } });
  for (const message of [JSON.stringify({ type: 'authenticate', token: 'edit', tenantId: 'two' }), JSON.stringify({ type: 'authenticate', token: 'secret-invalid' }), '{', Buffer.from([1, 0, 0]), JSON.stringify({ type: 'sync' })]) {
    const socket = await peer(t, f.url, null); socket.ws.send(message);
    const result = await socket.closed; assert.equal(result.code, 1008); assert.equal(socket.frames.length, 0); assert.ok(!result.reason.includes('secret'));
  }
  f.memberships.set('numeric', { principalId: 1, tenantId: 'one', role: 'owner' });
  const numeric = await peer(t, f.url, null); numeric.ws.send('{"type":"authenticate","token":"numeric"}'); assert.equal((await numeric.closed).code, 1008);
  const idle = await peer(t, f.url, null); assert.equal((await idle.closed).code, 1008); assert.equal(idle.frames.length, 0);
});

test('revoked viewer is revalidated before fanout and expired idle credentials close', async t => {
  const f = await fixture(t, { limits: { revalidationIntervalMs: 30 } });
  const editor = await peer(t, f.url); const viewer = await peer(t, f.url, 'view');
  f.memberships.delete('view'); editor.sendUpdate(edit('private-new-state').update);
  assert.equal((await editor.next()).revision, 1); assert.equal((await viewer.closed).code, 1008); assert.equal(viewer.frames.length, 0);
  f.memberships.delete('edit'); assert.equal((await editor.closed).code, 1008);
});

test('join and commits serialize: no update is lost while initial snapshot is pending', async t => {
  const store = storeFixture(); const f = await fixture(t, { store }); const a = await peer(t, f.url);
  const entered = deferred(); const release = deferred(); const originalGet = store.get;
  let hold = true;
  store.get = async (...args) => { const snapshot = await originalGet(...args); if (hold) { hold = false; entered.resolve(); await release.promise; } return snapshot; };
  const joining = peer(t, f.url, 'view'); await entered.promise;
  a.sendUpdate(edit('during-join').update); await delay(30); assert.equal(a.frames.length, 0);
  release.resolve(); const b = await joining; assert.equal(b.initial.revision, 0);
  assert.equal(body(await a.next()), 'during-join'); assert.equal(body(await b.next()), 'during-join');
});

test('commit completes before fanout; failed commit emits no state', async t => {
  const store = storeFixture(); const originalApply = store.applyUpdate; const entered = deferred(); const release = deferred();
  store.applyUpdate = async (...args) => { entered.resolve(); await release.promise; return originalApply(...args); };
  const f = await fixture(t, { store }); const a = await peer(t, f.url); const b = await peer(t, f.url, 'view');
  a.sendUpdate(edit('committed').update); await entered.promise; await delay(30); assert.equal(b.frames.length, 0); assert.equal(a.frames.length, 0);
  release.resolve(); assert.equal(body(await a.next()), 'committed'); assert.equal(body(await b.next()), 'committed');
  store.applyUpdate = async () => { throw new Error('secret database failure'); };
  a.sendUpdate(edit('unsaved').update); const closed = await a.closed; assert.equal(closed.code, 1011); assert.equal(closed.reason, 'Room resync required.'); assert.equal((await b.closed).code, 1011); assert.equal(b.frames.length, 0);
});

test('uncertain timed-out mutation fences the room until actual settlement', async t => {
  const store = storeFixture(); const originalApply = store.applyUpdate; const entered = deferred(); const release = deferred();
  store.applyUpdate = async (...args) => { entered.resolve(); await release.promise; return originalApply(...args); };
  const f = await fixture(t, { store, limits: { operationTimeoutMs: 60 } }); const a = await peer(t, f.url); const b = await peer(t, f.url, 'view');
  a.sendUpdate(edit('late-commit').update); await entered.promise; assert.equal((await a.closed).code, 1011);
  const viewerClosed = await b.closed; assert.equal(viewerClosed.code, 1011); assert.equal(viewerClosed.reason, 'Room resync required.');
  assert.equal(b.frames.length, 0); assert.equal(f.server.stats().dependencyOperations, 1);
  const rejoining = peer(t, f.url, 'view'); await delay(30);
  release.resolve(); const reconnected = await rejoining; assert.equal(body(reconnected.initial), 'late-commit');
});

test('ambiguous immediate mutation errors and invalid results force all readers to resync', async t => {
  for (const outcome of ['error', 'null', 'bad-revision', 'short-state']) {
    const store = storeFixture(); const originalApply = store.applyUpdate;
    store.applyUpdate = async (...args) => {
      const result = await originalApply(...args);
      if (outcome === 'error') throw Object.assign(new Error('lost COMMIT response with secret'), { code: 'DEPENDENCY_UNAVAILABLE' });
      if (outcome === 'null') return null;
      if (outcome === 'bad-revision') return { ...result, revision: undefined };
      return { ...result, state: new Uint8Array([0]) };
    };
    const f = await fixture(t, { store }); const editor = await peer(t, f.url); const viewer = await peer(t, f.url, 'view');
    editor.sendUpdate(edit('committed-despite-error').update);
    for (const client of [editor, viewer]) {
      const closed = await client.closed; assert.equal(closed.code, 1011); assert.equal(closed.reason, 'Room resync required.'); assert.equal(client.frames.length, 0);
    }
    const fresh = await peer(t, f.url, 'view'); assert.equal(body(fresh.initial), 'committed-despite-error');
  }
});

test('definite rejected writes close only the offender without disrupting readers', async t => {
  const store = storeFixture(); store.applyUpdate = async () => { throw Object.assign(new Error('invalid'), { code: 'BAD_REQUEST' }); };
  const f = await fixture(t, { store }); const editor = await peer(t, f.url); const viewer = await peer(t, f.url, 'view');
  editor.sendUpdate(edit('rejected').update); assert.equal((await editor.closed).code, 1008);
  viewer.ws.send('{"type":"sync"}'); assert.equal((await viewer.next()).revision, 0); assert.equal(viewer.ws.readyState, WebSocket.OPEN);
});

test('connection, room, pending and payload bounds fail closed and reclaim idle rooms', async t => {
  const f = await fixture(t, { limits: { maxConnections: 2, maxConnectionsPerRoom: 1 } }); const a = await peer(t, f.url);
  const b = await peer(t, f.url, null); b.ws.send('{"type":"authenticate","token":"view"}'); assert.equal((await b.closed).code, 1013); await until(() => f.server.stats().connections === 1);
  const c = await peer(t, f.url.replace('/room', '/second')); assert.equal(await deniedUpgrade(f.url, { origin: ORIGIN }), 503);
  a.ws.close(); c.ws.close(); await Promise.all([a.closed, c.closed]); await until(() => f.server.stats().connections === 0); assert.equal(f.server.stats().rooms, 0);
  const payload = await peer(t, f.url, null); payload.ws.send(Buffer.alloc(65538)); assert.ok([1009, 1006].includes((await payload.closed).code));
  const bounded = await fixture(t, { limits: { maxPendingPerConnection: 1 }, authenticate: async () => { await delay(50); return { principalId: 'x', tenantId: 'one', role: 'editor' }; } });
  const flood = await peer(t, bounded.url, null); flood.ws.send('{"type":"authenticate","token":"edit"}'); flood.ws.send('{"type":"sync"}'); assert.equal((await flood.closed).code, 1013);
});

test('reject unsafe listener options and malformed configuration', async () => {
  await assert.rejects(startLocalCollaborationServer({ host: '0.0.0.0' }), /loopback/);
  assert.throws(() => attachCollaborationServer({}), /Explicit/);
  await assert.rejects(startLocalCollaborationServer({ store: storeFixture(), authenticate: () => null, allowedOrigins: ['http://public.example'] }), /HTTPS/);
  await assert.rejects(startLocalCollaborationServer({ store: storeFixture(), authenticate: () => null, allowedOrigins: [ORIGIN], limits: { maxConnections: 9999 } }), /Invalid/);
});

test('authentication receives a stable frozen server-owned context unique to each socket', async t => {
  const contexts = new Map();
  const f = await fixture(t, { authenticate(request, context) {
    const token = request.headers.get('authorization');
    assert.equal(Object.isFrozen(context), true);
    assert.deepEqual(Object.keys(context), ['connectionId']);
    assert.match(context.connectionId, /^[a-zA-Z0-9_-]{43}$/);
    if (contexts.has(token)) assert.equal(contexts.get(token), context);
    else contexts.set(token, context);
    return { principalId: 'user', tenantId: 'one', role: 'editor' };
  } });
  const a = await peer(t, f.url, 'first');
  const b = await peer(t, f.url, 'second');
  assert.notEqual(contexts.get('Bearer first').connectionId, contexts.get('Bearer second').connectionId);
  a.ws.send('{"type":"sync"}'); await a.next();
  b.ws.send('{"type":"sync"}'); await b.next();
});
