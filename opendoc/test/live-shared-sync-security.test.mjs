// Original independent shared-live synchronization regressions. MIT.
// @spec OD-LIVE-SHARED-002 OD-LIVE-SHARED-003 OD-LIVE-SHARED-004
// These tests use a deterministic synthetic adapter, not a PostgreSQL proof.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import * as Y from 'yjs';
import { WebSocket } from 'ws';
import { MemoryLiveDocumentStore } from '../src/live-document-store.mjs';
import { startLocalCollaborationServer } from '../src/collaboration-server.mjs';
import { decodeStateFrame } from '../src/collaboration-client.mjs';

const ORIGIN = 'https://shared-security.example.test';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Condition did not settle'); await delay(5); }
}
function failure(code) { return Object.assign(new Error(code), { code }); }
function adapter(backend) {
  const reads = [];
  return {
    kind: 'postgresql-live-documents', reads,
    get: (...args) => backend.get(...args),
    applyUpdate: (...args) => backend.applyUpdate(...args),
    async getIfChanged(tenant, id, revision) {
      reads.push({ tenant, id, revision });
      const value = await backend.get(tenant, id);
      if (!value) throw failure('NOT_FOUND');
      if (value.revision < revision) throw failure('DEPENDENCY_UNAVAILABLE');
      return value.revision === revision ? null : value;
    }
  };
}
async function fixture(t, options = {}) {
  const backend = options.backend ?? new MemoryLiveDocumentStore();
  if (!await backend.get('one', 'live')) await backend.create('one', { id: 'live', title: '', content: '' });
  const store = options.store ?? adapter(backend);
  const memberships = new Map([
    ['edit', { principalId: 'writer', tenantId: 'one', role: 'editor' }],
    ['view', { principalId: 'reader', tenantId: 'one', role: 'viewer' }],
    ['move', { principalId: 'moving', tenantId: 'one', role: 'viewer' }]
  ]);
  const server = await startLocalCollaborationServer({ liveStore: store,
    sharedLiveSync: { intervalMs: 50 }, allowedOrigins: [ORIGIN],
    authenticate: request => memberships.get(request.headers.get('authorization')?.slice(7)),
    ...options.serverOptions });
  t.after(() => server.close());
  return { backend, store, memberships, server, url: `${server.url}/api/v1/live-documents/live/collaboration` };
}
async function peer(t, url, token = 'edit') {
  const ws = new WebSocket(url, { origin: ORIGIN });
  const queue = [], frames = [], waiters = [];
  ws.on('error', () => {});
  ws.on('message', (data, binary) => {
    const frame = binary ? decodeStateFrame(data) : JSON.parse(data.toString());
    frames.push(frame); if (waiters.length) waiters.shift()(frame); else queue.push(frame);
  });
  const closed = new Promise(resolve => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  t.after(() => ws.terminate()); await once(ws, 'open');
  const next = () => new Promise((resolve, reject) => {
    if (queue.length) return resolve(queue.shift());
    const timer = setTimeout(() => reject(new Error('Missing shared-live frame')), 4000);
    waiters.push(value => { clearTimeout(timer); resolve(value); });
  });
  ws.send(JSON.stringify({ type: 'authenticate', token }));
  assert.equal((await next()).type, 'ready'); const initial = await next();
  frames.length = 0;
  return { ws, frames, queue, next, initial, closed, send(sequence, update) {
    const bytes = Buffer.alloc(update.length + 5); bytes[0] = 3;
    bytes.writeUInt32BE(sequence, 1); bytes.set(update, 5); ws.send(bytes);
  } };
}
function delta(state, edit) {
  const doc = new Y.Doc(); Y.applyUpdate(doc, state); const before = Y.encodeStateVector(doc);
  edit(doc); const update = Y.encodeStateAsUpdate(doc, before); doc.destroy(); return update;
}
function content(state) {
  const doc = new Y.Doc(); try { Y.applyUpdate(doc, state); return doc.getText('content').toString(); } finally { doc.destroy(); }
}

test('shared poll read and delivery serialize ahead of a local write and ACK', { timeout: 10000 }, async t => {
  const f = await fixture(t); const writer = await peer(t, f.url), reader = await peer(t, f.url, 'view');
  const entered = deferred(), read = deferred(), captured = deferred(), release = deferred();
  const originalPoll = f.store.getIfChanged.bind(f.store), originalApply = f.store.applyUpdate;
  let first = true, localWrites = 0;
  f.store.getIfChanged = async (...args) => {
    if (!first) return originalPoll(...args); first = false; entered.resolve(); await read.promise;
    const value = await f.backend.get(args[0], args[1]); captured.resolve(); await release.promise; return value;
  };
  t.after(() => { read.resolve(); release.resolve(); });
  f.store.applyUpdate = (...args) => { localWrites++; return originalApply(...args); };
  await entered.promise;
  await f.backend.applyUpdate('one', 'live', delta(writer.initial.state, d => d.getText('content').insert(0, 'remote')));
  read.resolve(); await captured.promise;
  writer.send(1, delta(writer.initial.state, d => d.getText('title').insert(0, 'local')));
  await delay(25); assert.equal(localWrites, 0, 'local write must not overtake an in-flight poll');
  assert.equal(writer.frames.length, 0); assert.equal(reader.frames.length, 0);
  release.resolve();
  assert.equal((await writer.next()).revision, 2); assert.equal((await writer.next()).revision, 3);
  assert.deepEqual(await writer.next(), { type: 'ack', sequence: 1, revision: 3 });
  assert.equal((await reader.next()).revision, 2); assert.equal((await reader.next()).revision, 3);
  assert.ok(reader.frames.every(frame => frame.state), 'polling must never invent a sender ACK');
});

test('new join and explicit sync cannot advance the poll floor past an older idle viewer', { timeout: 10000 }, async t => {
  for (const action of ['join', 'sync']) {
    const f = await fixture(t); const reader = await peer(t, f.url, 'view');
    let polling = false; const originalPoll = f.store.getIfChanged.bind(f.store);
    // Keep the scheduler from observing the external update until the chosen read.
    f.store.getIfChanged = (...args) => polling ? originalPoll(...args) : Promise.resolve(null);
    const writer = action === 'sync' ? await peer(t, f.url) : null;
    await f.backend.applyUpdate('one', 'live', delta(reader.initial.state, d => d.getText('content').insert(0, action)));
    if (action === 'join') {
      const joining = await peer(t, f.url); assert.equal(joining.initial.revision, 2);
    } else {
      writer.ws.send('{"type":"sync"}'); assert.equal((await writer.next()).revision, 2);
    }
    polling = true;
    const observed = await reader.next(); assert.equal(observed.revision, 2); assert.equal(content(observed.state), action);
    await f.server.close();
  }
});

test('poll revalidates revoked and tenant-changing receivers after a delayed storage read', { timeout: 10000 }, async t => {
  const f = await fixture(t); const allowed = await peer(t, f.url), revoked = await peer(t, f.url, 'view'), moved = await peer(t, f.url, 'move');
  const entered = deferred(), read = deferred(), captured = deferred(), release = deferred(); let first = true;
  const originalPoll = f.store.getIfChanged.bind(f.store);
  f.store.getIfChanged = async (...args) => {
    if (!first) return originalPoll(...args); first = false; entered.resolve(); await read.promise;
    const value = await f.backend.get(args[0], args[1]); captured.resolve(); await release.promise; return value;
  };
  t.after(() => { read.resolve(); release.resolve(); }); await entered.promise;
  await f.backend.applyUpdate('one', 'live', delta(allowed.initial.state, d => d.getText('content').insert(0, 'private update')));
  read.resolve(); await captured.promise;
  f.memberships.delete('view'); f.memberships.set('move', { principalId: 'moving', tenantId: 'two', role: 'viewer' });
  release.resolve(); assert.equal(content((await allowed.next()).state), 'private update');
  assert.equal((await revoked.closed).code, 1008); assert.equal((await moved.closed).code, 1008);
  assert.deepEqual(revoked.frames, []); assert.deepEqual(moved.frames, []);
  assert.ok(f.store.reads.every(value => value.tenant === 'one' && value.id === 'live'));
});

test('timed-out poll keeps its dependency slot without unbounded retries or late output', { timeout: 10000 }, async t => {
  const f = await fixture(t, { serverOptions: { limits: { operationTimeoutMs: 150 } } });
  const reader = await peer(t, f.url, 'view'), entered = deferred(), release = deferred(); let calls = 0;
  f.store.getIfChanged = async () => { calls++; entered.resolve(); await release.promise; return f.backend.get('one', 'live'); };
  t.after(() => release.resolve()); await entered.promise;
  const closed = await reader.closed; assert.equal(closed.code, 1011); assert.deepEqual(reader.frames, []);
  assert.equal(f.server.stats().dependencyOperations, 1); await delay(180); assert.equal(calls, 1);
  await f.server.close(); release.resolve(); await until(() => f.server.stats().dependencyOperations === 0);
  await delay(80); assert.equal(calls, 1); assert.deepEqual(reader.frames, []);
});

test('shutdown fences a successful late poll and never starts another sweep', { timeout: 10000 }, async t => {
  const f = await fixture(t); const reader = await peer(t, f.url, 'view');
  const entered = deferred(), release = deferred(); let calls = 0;
  f.store.getIfChanged = async () => { calls++; entered.resolve(); await release.promise; return f.backend.get('one', 'live'); };
  t.after(() => release.resolve()); await entered.promise;
  await f.server.close(); assert.equal((await reader.closed).code, 1001);
  release.resolve(); await until(() => f.server.stats().dependencyOperations === 0); await delay(100);
  assert.equal(calls, 1); assert.deepEqual(reader.frames, []); assert.equal(f.server.stats().connections, 0);
});

test('automatic cross-process snapshots preserve causal pending and delete-only changes without ACKs', { timeout: 15000 }, async t => {
  const a = await fixture(t), b = await fixture(t, { backend: a.backend });
  const writer = await peer(t, a.url), reader = await peer(t, b.url, 'view');
  const doc = new Y.Doc(), updates = []; doc.on('update', value => updates.push(value));
  t.after(() => doc.destroy()); doc.getText('content').insert(0, 'A'); doc.getText('content').insert(1, 'B'); doc.getText('content').delete(0, 1);
  for (const [sequence, update, expected] of [[1, updates[1], ''], [2, updates[0], 'AB'], [3, updates[2], 'B']]) {
    writer.send(sequence, update);
    const committed = await writer.next(); assert.equal(committed.revision, sequence + 1);
    assert.deepEqual(await writer.next(), { type: 'ack', sequence, revision: sequence + 1 });
    const observed = await reader.next(); assert.equal(observed.revision, sequence + 1); assert.equal(content(observed.state), expected);
    if (sequence === 1) {
      const pending = new Y.Doc(); Y.applyUpdate(pending, observed.state);
      assert.ok(pending.store.pendingStructs, 'causally pending bytes must reach the other process'); pending.destroy();
    }
  }
  assert.ok(reader.frames.every(frame => frame.state));
  assert.equal((await b.backend.get('one', 'live')).content, 'B');
});

test('writer downgrade during polling retains read access but cannot mutate or receive a false ACK', { timeout: 10000 }, async t => {
  const f = await fixture(t); const writer = await peer(t, f.url);
  f.memberships.set('edit', { principalId: 'writer', tenantId: 'one', role: 'viewer' });
  await f.backend.applyUpdate('one', 'live', delta(writer.initial.state, d => d.getText('content').insert(0, 'readable')));
  const observed = await writer.next(); assert.equal(observed.revision, 2);
  writer.send(1, delta(observed.state, d => d.getText('content').insert(0, 'forbidden')));
  assert.equal((await writer.closed).code, 1008);
  assert.equal((await f.backend.get('one', 'live')).content, 'readable');
  assert.ok(writer.frames.every(frame => frame.state), 'a downgraded writer must not receive an ACK');
});

test('regressed, conflicting or malformed poll snapshots close the room without publishing them', { timeout: 15000 }, async t => {
  for (const outcome of ['regression', 'equal-revision-conflict', 'invalid-state', 'missing', 'dependency-error']) {
    const backend = new MemoryLiveDocumentStore();
    const initial = await backend.create('one', { id: 'live', title: '', content: '' });
    const base = await backend.applyUpdate('one', 'live', delta(initial.state, d => d.getText('title').insert(0, 'baseline')));
    const f = await fixture(t, { backend }); const editor = await peer(t, f.url), reader = await peer(t, f.url, 'view');
    const changed = { ...base, revision: base.revision + 1,
      state: Y.mergeUpdates([base.state, delta(base.state, d => d.getText('content').insert(0, 'must not leak'))]) };
    f.store.getIfChanged = async () => {
      if (outcome === 'missing') throw failure('NOT_FOUND');
      if (outcome === 'dependency-error') throw new Error('private database host and credentials');
      if (outcome === 'invalid-state') return { ...changed, state: new Uint8Array([0]) };
      return { ...changed, revision: outcome === 'regression' ? base.revision - 1 : base.revision };
    };
    for (const peer of [editor, reader]) {
      const result = await peer.closed; assert.equal(result.code, 1011);
      assert.ok(!result.reason.includes('private')); assert.deepEqual(peer.frames, []);
    }
    await f.server.close();
  }
});

test('an unresolved fenced write cannot stall automatic sync in unrelated rooms', { timeout: 10000 }, async t => {
  const backend = new MemoryLiveDocumentStore();
  await backend.create('one', { id: 'other', title: '', content: '' });
  const f = await fixture(t, { backend, serverOptions: { limits: { operationTimeoutMs: 150 } } });
  const writer = await peer(t, f.url), reader = await peer(t, f.url.replace('/live/', '/other/'), 'view');
  const entered = deferred(), release = deferred(); const originalApply = f.store.applyUpdate;
  f.store.applyUpdate = async (...args) => { entered.resolve(); await release.promise; return originalApply(...args); };
  t.after(() => release.resolve());
  writer.send(1, delta(writer.initial.state, d => d.getText('content').insert(0, 'uncertain')));
  await entered.promise; assert.equal((await writer.closed).code, 1011);
  assert.equal(f.server.stats().dependencyOperations, 1, 'the unresolved write must keep its dependency admission slot');
  await backend.applyUpdate('one', 'other', delta(reader.initial.state, d => d.getText('content').insert(0, 'healthy room')));
  const observed = await reader.next(); assert.equal(observed.revision, 2); assert.equal(content(observed.state), 'healthy room');
  assert.equal(reader.ws.readyState, WebSocket.OPEN);
  release.resolve(); await until(() => f.server.stats().dependencyOperations === 0);
});

test('revocation suppresses post-commit state and ACK but does not cancel an already-authorized write', { timeout: 10000 }, async t => {
  const a = await fixture(t), b = await fixture(t, { backend: a.backend });
  const writer = await peer(t, a.url), reader = await peer(t, b.url, 'view');
  const entered = deferred(), release = deferred(), originalApply = a.store.applyUpdate;
  a.store.applyUpdate = async (...args) => { entered.resolve(); await release.promise; return originalApply(...args); };
  t.after(() => release.resolve());
  writer.send(1, delta(writer.initial.state, d => d.getText('content').insert(0, 'authorized before revocation')));
  await entered.promise; a.memberships.delete('edit');
  assert.deepEqual(writer.frames, []); release.resolve();
  assert.equal((await writer.closed).code, 1008); assert.deepEqual(writer.frames, []);
  const observed = await reader.next(); assert.equal(observed.revision, 2); assert.equal(content(observed.state), 'authorized before revocation');
  assert.equal((await a.backend.get('one', 'live')).revision, 2);
});
