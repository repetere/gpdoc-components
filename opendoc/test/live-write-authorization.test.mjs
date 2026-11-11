// Synthetic account guard and adapter contracts, not a PostgreSQL isolation proof.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createPostgresAccountWriteGuard } from '../src/account-store.mjs';
import { MemoryDocumentStore, StoreError } from '../src/memory-store.mjs';
import { MemoryLiveDocumentStore, PostgresLiveDocumentStore } from '../src/live-document-store.mjs';
import { createOpenDocHandler } from '../src/api.mjs';
import { startLocalCollaborationServer } from '../src/collaboration-server.mjs';
import { decodeStateFrame } from '../src/collaboration-client.mjs';

const actor = { principalId: 'writer', tenantId: 'tenant-a' };
const mapped = { principal_id: actor.principalId, tenant_id: actor.tenantId, role: 'editor' };
const state = { schema_version: 1, max_principals: 10000, max_identity_bindings: 20000, max_memberships: 50000,
  max_memberships_per_tenant: 10000, max_bytes: '16777216', principal_count: '1', identity_binding_count: '1', membership_count: '1', byte_count: '100' };
const guard = () => createPostgresAccountWriteGuard({ schema: 'test_accounts' });
const rejects = code => error => error instanceof StoreError && error.code === code && error.message === code && error.cause === undefined;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function scripted(steps) {
  const calls = [];
  const client = { async query(sql, values) {
    calls.push({ sql, values }); const step = steps.shift(); assert.ok(step, `Unexpected SQL: ${sql}`);
    if (step.match) assert.match(sql, step.match);
    if (step.values) assert.deepEqual(values, step.values);
    if (step.error) throw step.error;
    return { rows: step.rows ?? [] };
  } };
  return { client, calls, done() { assert.equal(steps.length, 0); } };
}
function pooled(steps) {
  const db = scripted(steps), releases = []; let connections = 0;
  return { ...db, releases, pool: { async connect() { connections++; return { ...db.client, release(discard) { releases.push(discard); } }; } },
    done() { db.done(); assert.equal(connections, 1); assert.deepEqual(releases, [false]); } };
}
const begin = { match: /^BEGIN ISOLATION LEVEL READ COMMITTED$/ }, commit = { match: /^COMMIT$/ }, rollback = { match: /^ROLLBACK$/ };
const accountLock = { match: /"test_accounts"\.account_state .*FOR SHARE$/s, rows: [state] };
const liveCaps = { schema_version: 1, max_documents_per_tenant: 100, max_documents: 1000, max_bytes: '16777216', document_count: '0', byte_count: '0' };
const accountMember = { match: /"test_accounts"\.principals p/, values: [actor.tenantId, actor.principalId], rows: [mapped] };
const pgStore = pool => new PostgresLiveDocumentStore({ pool, schema: 'test_live', accountSchema: 'test_accounts' });

test('account write guard validates schema inertly and snapshots only exact own-data actor fields', () => {
  for (const schema of [undefined, null, '', 'public', 'pg_catalog', 'information_schema', 'a.b', 'a\n', 'a";--', 'a'.repeat(64)]) {
    assert.throws(() => createPostgresAccountWriteGuard({ schema }), TypeError);
  }
  const g = guard(), supplied = { ...actor }, copied = g.snapshot(actor.tenantId, supplied);
  assert.ok(Object.isFrozen(g)); assert.ok(Object.isFrozen(copied)); assert.notEqual(copied, supplied);
  supplied.principalId = 'another'; supplied.tenantId = 'other'; assert.deepEqual(copied, actor);
  let getters = 0;
  const getter = { ...actor }; Object.defineProperty(getter, 'principalId', { get() { getters++; return actor.principalId; } });
  const extra = { ...actor }; Object.defineProperty(extra, 'hidden', { value: true });
  const symbolic = { ...actor, [Symbol('role')]: 'owner' };
  const proxy = new Proxy({}, { getPrototypeOf() { throw new Error('private accessor detail'); } });
  for (const value of [undefined, null, {}, [], Object.create(actor), Object.assign(Object.create(null), actor), getter, extra, symbolic, proxy,
    { ...actor, role: 'owner' }, { ...actor, token: 'secret' }, { ...actor, tenantId: 'other' },
    { ...actor, principalId: 'writer\n' }, { ...actor, principalId: 'x'.repeat(65) }, { ...actor, tenantId: 'tenant-a\n' }]) {
    assert.throws(() => g.snapshot(actor.tenantId, value), rejects('FORBIDDEN'));
  }
  assert.equal(getters, 0);
});

test('account write guard uses only supplied transaction client, locks first, then freshly checks database write role', async () => {
  for (const role of ['owner', 'editor']) {
    const db = scripted([
      { match: /FROM "test_accounts"\.account_state WHERE singleton = true FOR SHARE$/, rows: [state] },
      { match: /JOIN "test_accounts"\.memberships m .*m\.tenant_id = \$1\s+WHERE p\.principal_id = \$2 AND p\.active = true$/s,
        values: [actor.tenantId, actor.principalId], rows: [{ ...mapped, role }] }
    ]);
    const g = guard(); await g.authorize(db.client, g.snapshot(actor.tenantId, actor)); db.done();
    assert.equal(db.calls.length, 2);
    assert.ok(db.calls.every(({ sql }) => !/\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/.test(sql)));
  }
});

test('guard keeps its copied actor while the account lock is pending', async () => {
  const entered = deferred(), release = deferred(), supplied = { ...actor }, g = guard(); let queries = 0;
  const pending = g.authorize({ async query(sql, values) {
    if (++queries === 1) { entered.resolve(); await release.promise; return { rows: [state] }; }
    assert.deepEqual(values, [actor.tenantId, actor.principalId]); return { rows: [mapped] };
  } }, supplied);
  await entered.promise; supplied.principalId = 'another'; supplied.tenantId = 'other'; release.resolve();
  await pending; assert.equal(queries, 2);
});

test('guard denies absent or nonwriting accounts and never accepts supplied role claims', async () => {
  for (const rows of [[], [{ ...mapped, role: 'viewer' }], [{ ...mapped, role: 'commenter' }]]) {
    const db = scripted([{ rows: [state] }, { rows }]); const g = guard();
    await assert.rejects(g.authorize(db.client, g.snapshot(actor.tenantId, actor)), rejects('FORBIDDEN')); db.done();
  }
  const db = scripted([]), g = guard();
  for (const value of [undefined, { ...actor, role: 'owner' }, { tenantId: actor.tenantId }]) {
    await assert.rejects(g.authorize(db.client, value), rejects('FORBIDDEN'));
  }
  db.done();
});

test('guard rejects corrupt account state, wrong returned scope and driver failures without leaking details', async () => {
  for (const rows of [[], [state, state], [{ ...state, schema_version: 2 }], [{ ...state, principal_count: '10001' }],
    [{ ...state, byte_count: '-1' }], [{ ...state, max_memberships: Infinity }]]) {
    const db = scripted([{ rows }]), g = guard();
    await assert.rejects(g.authorize(db.client, actor), rejects('DEPENDENCY_UNAVAILABLE')); db.done();
  }
  for (const rows of [[null], [mapped, mapped], [{ ...mapped, principal_id: 'another' }], [{ ...mapped, tenant_id: 'another' }], [{ ...mapped, role: 'admin' }]]) {
    const db = scripted([{ rows: [state] }, { rows }]), g = guard();
    await assert.rejects(g.authorize(db.client, actor), rejects('DEPENDENCY_UNAVAILABLE')); db.done();
  }
  for (const steps of [[{ error: new Error('private database URL') }], [{ rows: [state] }, { error: new Error('private SQL parameters') }]]) {
    const db = scripted(steps), g = guard();
    await assert.rejects(g.authorize(db.client, actor), rejects('DEPENDENCY_UNAVAILABLE')); db.done();
  }
});

const input = { id: 'live', title: '', content: 'Initial' };
test('guarded live store has no missing-actor or malformed-configuration bypass before connecting', async () => {
  const pool = { async connect() { assert.fail('Invalid guard input must not connect'); } };
  for (const accountSchema of [null, '', 'public', 'a.b', 'test_live']) {
    assert.throws(() => new PostgresLiveDocumentStore({ pool, schema: 'test_live', accountSchema }), TypeError);
  }
  // Explicitly omitted guarding keeps the existing no-I/O constructor contract.
  assert.equal(new PostgresLiveDocumentStore({ pool, schema: 'test_live', accountSchema: undefined }).kind, 'postgresql-live-documents');
  const store = pgStore(pool); let getters = 0;
  const getter = { ...actor }; Object.defineProperty(getter, 'tenantId', { get() { getters++; return actor.tenantId; } });
  for (const supplied of [undefined, null, {}, getter, { ...actor, tenantId: 'other' }, { ...actor, role: 'owner' }]) {
    await assert.rejects(store.create(actor.tenantId, input, supplied), rejects('FORBIDDEN'));
    await assert.rejects(store.applyUpdate(actor.tenantId, input.id, new Uint8Array([0, 0]), supplied), rejects('FORBIDDEN'));
  }
  assert.equal(getters, 0);
});

test('guarded creates and no-op updates deny before any live lock or row read on the same transaction', async () => {
  for (const method of ['create', 'applyUpdate']) for (const role of [null, 'viewer', 'commenter']) {
    const db = pooled([begin, accountLock, { rows: role ? [{ ...mapped, role }] : [] }, rollback]), store = pgStore(db.pool);
    const work = method === 'create' ? store.create(actor.tenantId, input, actor)
      : store.applyUpdate(actor.tenantId, input.id, new Uint8Array([0, 0]), actor);
    await assert.rejects(work, rejects('FORBIDDEN')); db.done();
    assert.ok(db.calls.every(({ sql }) => !sql.includes('"test_live"')));
  }
});

test('guarded live create copies actor before pool acquisition and commits under account then live locks', async () => {
  const now = new Date().toISOString();
  const db = pooled([begin, accountLock, accountMember,
    { match: /"test_live"\.live_document_state .*FOR UPDATE$/s, rows: [liveCaps] },
    { match: /"test_live"\.live_documents WHERE tenant_id = \$1 AND document_id = \$2$/, values: [actor.tenantId, input.id] },
    { match: /count\(\*\)/, rows: [{ count: '0' }] },
    { match: /^INSERT INTO "test_live"\.live_documents/, rows: [{ document_id: input.id, title_json: Buffer.from(JSON.stringify(input.title)), revision: 1, created_at: now, updated_at: now }] },
    { match: /^UPDATE "test_live"\.live_document_state/ }, commit]);
  const entered = deferred(), release = deferred();
  const pool = { async connect() { entered.resolve(); await release.promise; return db.pool.connect(); } };
  const supplied = { ...actor }, pending = pgStore(pool).create(actor.tenantId, input, supplied);
  await entered.promise; supplied.principalId = 'another'; supplied.tenantId = 'other'; release.resolve();
  const created = await pending; assert.equal(created.revision, 1); assert.equal(created.content, input.content); db.done();
});

test('guarded live no-op replay authorizes before locking the live row and before returning its snapshot', async () => {
  const current = await new MemoryLiveDocumentStore().create(actor.tenantId, input);
  const logicalBytes = current.state.byteLength + actor.tenantId.length + input.id.length +
    Buffer.byteLength(JSON.stringify(current.title)) + Buffer.byteLength(JSON.stringify(current.content));
  const row = { document_id: current.id, revision: 1, state: current.state, title_json: Buffer.from(JSON.stringify(current.title)),
    content_json: Buffer.from(JSON.stringify(current.content)), logical_bytes: logicalBytes, created_at: current.createdAt, updated_at: current.updatedAt };
  const db = pooled([begin, accountLock, accountMember,
    { match: /"test_live"\.live_document_state .*FOR UPDATE$/s, rows: [{ ...liveCaps, document_count: 1, byte_count: logicalBytes }] },
    { match: /"test_live"\.live_documents .*FOR UPDATE$/s, values: [actor.tenantId, input.id], rows: [row] }, commit]);
  assert.deepEqual(await pgStore(db.pool).applyUpdate(actor.tenantId, input.id, new Uint8Array([0, 0]), actor), current); db.done();
});

test('HTTP live creation forwards copied verified actor across a delayed body and rejects client authority fields', async () => {
  const liveStore = new MemoryLiveDocumentStore(), restStore = new MemoryDocumentStore();
  const create = liveStore.create.bind(liveStore), calls = [], authenticated = deferred();
  liveStore.create = (...args) => { calls.push(args); return create(...args); };
  const identity = { ...actor, role: 'editor', ignoredClaim: 'not forwarded' };
  const handle = createOpenDocHandler({ store: restStore, liveStore, authenticate() { authenticated.resolve(); return identity; } });
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } });
  const pending = handle(new Request('https://example.test/api/v1/live-documents', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body, duplex: 'half' }));
  await authenticated.promise; await nextTurn();
  identity.principalId = 'changed'; identity.tenantId = 'changed';
  controller.enqueue(new TextEncoder().encode(JSON.stringify(input))); controller.close();
  assert.equal((await pending).status, 201); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [actor.tenantId, input, actor]); assert.ok(Object.isFrozen(calls[0][2]));
  assert.equal(await liveStore.get('changed', 'live'), null);
  const forged = await handle(new Request('https://example.test/api/v1/live-documents', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, principalId: 'forged' }) }));
  assert.equal(forged.status, 400); assert.equal(calls.length, 1);
});

test('HTTP maps a late guarded account denial to 403 without creating a document', async () => {
  const liveStore = new MemoryLiveDocumentStore(); let writes = 0;
  liveStore.create = async (tenant, data, trusted) => {
    assert.equal(tenant, actor.tenantId); assert.deepEqual(trusted, actor);
    const db = scripted([{ rows: [state] }, { rows: [] }]), g = guard();
    await g.authorize(db.client, g.snapshot(tenant, trusted)); writes++;
  };
  const handle = createOpenDocHandler({ store: new MemoryDocumentStore(), liveStore, authenticate: () => ({ ...actor, role: 'editor' }) });
  const response = await handle(new Request('https://example.test/api/v1/live-documents', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }));
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: { code: 'FORBIDDEN', message: 'Access denied.' } });
  assert.equal(writes, 0); assert.equal(await liveStore.get(actor.tenantId, input.id), null);
});

const ORIGIN = 'https://example.test';
async function peer(t, url, token = 'edit') {
  const ws = new WebSocket(url, { origin: ORIGIN }), frames = [], waiters = [];
  ws.on('error', () => {});
  ws.on('message', (bytes, binary) => {
    const value = binary ? decodeStateFrame(bytes) : JSON.parse(bytes);
    if (waiters.length) waiters.shift()(value); else frames.push(value);
  });
  const closed = new Promise(resolve => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  t.after(() => ws.terminate()); await once(ws, 'open');
  const next = () => new Promise((resolve, reject) => {
    if (frames.length) return resolve(frames.shift());
    const timer = setTimeout(() => reject(new Error('Missing authorization test frame')), 4000);
    waiters.push(value => { clearTimeout(timer); resolve(value); });
  });
  ws.send(JSON.stringify({ type: 'authenticate', token })); assert.equal((await next()).type, 'ready'); const initial = await next();
  return { ws, frames, closed, next, initial, send() { ws.send(Buffer.from([3, 0, 0, 0, 1, 0, 0])); } };
}

test('live transport forwards only trusted actor and definite denial leaves healthy readers connected without ACK', { timeout: 10000 }, async t => {
  const backend = new MemoryLiveDocumentStore(); await backend.create(actor.tenantId, input);
  const calls = [];
  const liveStore = { get: backend.get.bind(backend), async applyUpdate(...args) { calls.push(args); throw new StoreError('FORBIDDEN'); } };
  const server = await startLocalCollaborationServer({ liveStore, allowedOrigins: [ORIGIN], authenticate: request => {
    const view = request.headers.get('authorization') === 'Bearer view';
    return { principalId: view ? 'reader' : actor.principalId, tenantId: actor.tenantId, role: view ? 'viewer' : 'editor', ignoredClaim: 'not forwarded' };
  } });
  t.after(() => server.close()); const url = `${server.url}/api/v1/live-documents/live/collaboration`;
  const writer = await peer(t, url), reader = await peer(t, url, 'view'); writer.send();
  assert.deepEqual(await writer.closed, { code: 1008, reason: 'Access denied.' });
  assert.equal(calls.length, 1); assert.equal(calls[0].length, 4);
  assert.deepEqual(calls[0].slice(0, 2), [actor.tenantId, input.id]);
  assert.deepEqual(calls[0][3], actor); assert.ok(Object.isFrozen(calls[0][3]));
  assert.deepEqual(writer.frames, []); assert.deepEqual(reader.frames, []);
  assert.equal(reader.ws.readyState, WebSocket.OPEN);
  reader.ws.send('{"type":"sync"}'); assert.equal((await reader.next()).revision, 1);
  assert.equal((await backend.get(actor.tenantId, input.id)).revision, 1);
});

test('standalone transport keeps the original three-argument store mutation contract', { timeout: 10000 }, async t => {
  const calls = [];
  const store = { async get() { return { revision: 1, state: new Uint8Array([0, 0]) }; }, async applyUpdate(...args) {
    calls.push(args); return { revision: 1, state: new Uint8Array([0, 0]) };
  } };
  const server = await startLocalCollaborationServer({ store, allowedOrigins: [ORIGIN], authenticate: () => ({ ...actor, role: 'editor' }) });
  t.after(() => server.close()); const client = await peer(t, `${server.url}/api/v1/collaboration/room`);
  client.ws.send(Buffer.from([1, 0, 0])); assert.equal((await client.next()).revision, 1);
  assert.equal(calls.length, 1); assert.equal(calls[0].length, 3); assert.deepEqual(calls[0].slice(0, 2), [actor.tenantId, 'room']);
});
