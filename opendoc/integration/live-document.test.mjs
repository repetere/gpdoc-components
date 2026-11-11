// Real PostgreSQL tests use only an explicitly opted-in synthetic loopback target.
// @spec OD-LIVE-001 OD-LIVE-002 OD-LIVE-003 OD-LIVE-004 OD-LIVE-005
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import * as Y from 'yjs';
import { Pool } from 'pg';
import { MemoryDocumentStore } from '../src/memory-store.mjs';
import { PostgresLiveDocumentStore, initializePostgresLiveDocumentSchema } from '../src/live-document-store.mjs';
import { createOpenDocHandler } from '../src/api.mjs';
import { startLocalCollaborationServer } from '../src/collaboration-server.mjs';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { decodeStateFrame } from '../src/collaboration-client.mjs';
const enabled = process.env.OPENDOC_PG_INTEGRATION === '1';
function target(raw) {
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.pathname !== '/opendoc_test' ||
    url.username !== 'opendoc_test' || url.password !== 'synthetic-test-only' || url.search || url.hash) throw new Error('Only the explicit synthetic loopback PostgreSQL target is permitted');
  const port = Number(url.port || 5432); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid test port');
  return { host: '127.0.0.1', port, user: 'opendoc_test', password: 'synthetic-test-only', database: 'opendoc_test', ssl: false,
    options: '-c search_path=pg_catalog', max: 3, connectionTimeoutMillis: 3000, query_timeout: 10000, statement_timeout: 8000, idle_in_transaction_session_timeout: 8000 };
}
const fails = code => error => error.code === code && error.message === code && !error.cause;
function delta(base, id, edit) {
  const doc = new Y.Doc(); doc.clientID = id; Y.applyUpdate(doc, base); const vector = Y.encodeStateVector(doc); edit(doc);
  const update = Y.encodeStateAsUpdate(doc, vector); doc.destroy(); return update;
}
const initial = { id: 'live', title: 'Synthetic\u0000 🌿', content: 'Base\r\n\u0000 text' };

test('live integration target rejects remote, ambient, production and option-bearing connections', () => {
  for (const url of [undefined, '', 'postgres://opendoc_test:synthetic-test-only@prod.test/opendoc_test',
    'postgres://opendoc_test:synthetic-test-only@127.0.0.1/prod', 'postgres://opendoc_test:synthetic-test-only@127.0.0.1/opendoc_test?host=remote',
    'postgres://postgres:password@127.0.0.1/opendoc_test']) assert.throws(() => target(url));
});

test('real PostgreSQL live document authority, durable projections, fencing and WebSocket acknowledgement', { skip: !enabled, timeout: 90000 }, async t => {
  const config = target(process.env.DATABASE_URL); const poolA = new Pool(config), poolB = new Pool(config); const schemas = [];
  const create = async (options = {}) => {
    const schema = `opendoc_live_test_${randomBytes(12).toString('hex')}`;
    await initializePostgresLiveDocumentSchema({ pool: poolA, schema, ...options }); schemas.push(schema);
    return { schema, a: new PostgresLiveDocumentStore({ pool: poolA, schema }), b: new PostgresLiveDocumentStore({ pool: poolB, schema }) };
  };
  t.after(async () => {
    try { for (const schema of schemas) await poolA.query(`DROP TABLE "${schema}".live_documents; DROP TABLE "${schema}".live_document_state; DROP SCHEMA "${schema}"`); }
    finally { await Promise.all([poolA.end(), poolB.end()]); }
  });
  const identity = await poolA.query('SELECT current_database() AS database, current_user AS username, host(inet_server_addr()) AS address');
  assert.equal(identity.rows[0].database, 'opendoc_test'); assert.equal(identity.rows[0].username, 'opendoc_test'); assert.equal(identity.rows[0].address, '127.0.0.1');

  await t.test('create/list/get preserve NUL text; stable IDs isolate tenants; reads and updates never allocate', async () => {
    const { schema, a, b } = await create();
    assert.deepEqual(await a.list('a'), []); assert.equal(await a.get('a', 'live'), null);
    await assert.rejects(a.applyUpdate('a', 'live', new Uint8Array([0, 0])), fails('NOT_FOUND'));
    const base = await a.create('a', initial); assert.deepEqual(await b.get('a', 'live'), base);
    assert.equal(base.title, initial.title); assert.equal(base.content, initial.content);
    await b.create('b', { ...initial, content: 'Other tenant' }); assert.equal((await a.get('b', 'live')).content, 'Other tenant');
    const listed = await b.list('a'); assert.equal(listed[0].title, initial.title); assert.equal(listed[0].content, undefined);
    await assert.rejects(a.create('a', initial), fails('CONFLICT')); await assert.rejects(initializePostgresLiveDocumentSchema({ pool: poolA, schema }), fails('DEPENDENCY_UNAVAILABLE'));
    const empty = await a.create('a', { id: 'empty', title: '', content: '' }); assert.deepEqual(await b.get('a', 'empty'), empty);
  });

  await t.test('independent pools merge concurrent title/content edits and deletion-only replays atomically', async () => {
    const { a, b } = await create(); const base = await a.create('a', initial);
    const updates = Array.from({ length: 8 }, (_, index) => delta(base.state, index + 1000, doc => doc.getText(index % 2 ? 'title' : 'content').insert(0, `${index} `)));
    const results = await Promise.all(updates.map((update, index) => (index % 2 ? a : b).applyUpdate('a', 'live', update)));
    assert.deepEqual(results.map(value => value.revision).sort((x, y) => x - y), [2, 3, 4, 5, 6, 7, 8, 9]);
    const expected = new Y.Doc(); Y.applyUpdate(expected, base.state); for (const update of updates) Y.applyUpdate(expected, update);
    const final = await b.get('a', 'live'); assert.equal(final.title, expected.getText('title').toString()); assert.equal(final.content, expected.getText('content').toString()); expected.destroy();
    for (const update of updates) assert.equal((await a.applyUpdate('a', 'live', update)).revision, 9);
    const deletion = delta(final.state, 2000, doc => doc.getText('content').delete(0, 1)); const deleted = await a.applyUpdate('a', 'live', deletion);
    assert.equal(deleted.revision, 10); assert.deepEqual(await b.applyUpdate('a', 'live', deletion), deleted);
  });

  await t.test('reopening a fresh pool preserves revision, projection, and causally pending updates/deletions', async () => {
    const { schema, a } = await create(); await a.create('a', { id: 'live', title: '', content: '' });
    const doc = new Y.Doc(); doc.clientID = 3000; const updates = []; doc.on('update', update => updates.push(update));
    doc.getText('content').insert(0, 'A'); doc.getText('content').insert(1, 'B'); doc.getText('content').delete(0, 1);
    await a.applyUpdate('a', 'live', updates[1]); const pending = await a.applyUpdate('a', 'live', updates[2]); assert.equal(pending.content, '');
    const freshPool = new Pool(config);
    try {
      const fresh = new PostgresLiveDocumentStore({ pool: freshPool, schema }); assert.deepEqual(await fresh.get('a', 'live'), pending);
      assert.equal((await fresh.applyUpdate('a', 'live', updates[0])).content, 'B');
    } finally { await freshPool.end(); doc.destroy(); }
  });

  await t.test('global, per-tenant and logical byte limits survive concurrent creates with exact accounting', async () => {
    const limited = await create({ maxDocuments: 2, maxDocumentsPerTenant: 1 });
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => (index % 2 ? limited.a : limited.b).create(String(index % 3), { ...initial, id: `doc-${index}` })));
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 2);
    assert.ok(results.filter(value => value.status === 'rejected').every(value => value.reason.code === 'CAPACITY_EXCEEDED'));
    const check = await poolA.query(`SELECT document_count, byte_count, (SELECT count(*) FROM "${limited.schema}".live_documents) AS actual_count,
      (SELECT sum(logical_bytes) FROM "${limited.schema}".live_documents) AS actual_bytes FROM "${limited.schema}".live_document_state`);
    assert.equal(check.rows[0].document_count, check.rows[0].actual_count); assert.equal(check.rows[0].byte_count, check.rows[0].actual_bytes);
    const tiny = await create({ maxBytes: 1 }); await assert.rejects(tiny.a.create('a', initial), fails('CAPACITY_EXCEEDED')); assert.deepEqual(await tiny.b.list('a'), []);
  });

  await t.test('malformed/schema-invalid writes rollback; lost commit replies resolve safely by idempotent replay', async () => {
    const { schema, a } = await create(); const base = await a.create('a', initial);
    const bad = new Y.Doc(); bad.getMap('content').set('hidden', { unsafe: true });
    for (const update of [new Uint8Array([255, 255]), Y.encodeStateAsUpdate(bad)]) {
      await assert.rejects(a.applyUpdate('a', 'live', update), fails('BAD_REQUEST')); assert.deepEqual(await a.get('a', 'live'), base);
    }
    bad.destroy(); let lost = true;
    const uncertainPool = { async connect() { const client = await poolB.connect(); return { async query(sql, values) { const result = await client.query(sql, values); if (sql === 'COMMIT' && lost) { lost = false; throw new Error('Lost COMMIT response'); } return result; }, release(discard) { client.release(discard); } }; } };
    const uncertain = new PostgresLiveDocumentStore({ pool: uncertainPool, schema });
    const update = delta(base.state, 4000, doc => doc.getText('content').insert(0, 'Committed '));
    await assert.rejects(uncertain.applyUpdate('a', 'live', update), fails('DEPENDENCY_UNAVAILABLE'));
    const saved = await a.get('a', 'live'); assert.equal(saved.revision, 2); assert.deepEqual(await uncertain.applyUpdate('a', 'live', update), saved);
  });

  for (const ending of ['COMMIT', 'ROLLBACK']) await t.test(`reconnect reads fence behind unsettled ${ending}`, async () => {
    const { schema, a } = await create(); const base = await a.create('a', initial); const writer = await poolA.connect(); let open = false, read;
    try {
      const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; await writer.query('BEGIN'); open = true;
      await writer.query(`SELECT singleton FROM "${schema}".live_document_state WHERE singleton = true FOR UPDATE`);
      let readerPid;
      const observedPool = { async connect() { const client = await poolB.connect(); readerPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; return client; } };
      let settled = false; read = new PostgresLiveDocumentStore({ pool: observedPool, schema }).get('a', 'live').then(value => { settled = true; return value; });
      let blocked = false; const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !settled) {
        if (readerPid) { const result = await poolA.query('SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked', [writerPid, readerPid]); if (result.rows[0].blocked) { blocked = true; break; } }
        await delay(10);
      }
      assert.equal(settled, false); assert.equal(blocked, true); await writer.query(ending); open = false; assert.deepEqual(await read, base);
    } finally { if (open) await writer.query('ROLLBACK'); writer.release(); if (read) await read; }
  });

  await t.test('API and network live protocol share one durable authority and only ack committed sequence', async () => {
    const { a } = await create();
    const authenticate = () => ({ principalId: 'editor', tenantId: 'a', role: 'editor' });
    const handle = createOpenDocHandler({ store: new MemoryDocumentStore(), liveStore: a, authenticate });
    const created = await handle(new Request('https://example.test/api/v1/live-documents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(initial) })); assert.equal(created.status, 201);
    const server = await startLocalCollaborationServer({ liveStore: a, authenticate, allowedOrigins: ['https://example.test'] });
    const ws = new WebSocket(`${server.url}/api/v1/live-documents/live/collaboration`, { origin: 'https://example.test' });
    const messages = []; let wake;
    ws.on('message', (bytes, binary) => { const value = binary ? decodeStateFrame(bytes) : JSON.parse(bytes); if (wake) { const resolve = wake; wake = null; resolve(value); } else messages.push(value); });
    const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => { wake = resolve; });
    try {
      await once(ws, 'open'); ws.send('{"type":"authenticate","token":"synthetic"}'); assert.equal((await next()).protocol, 'opendoc-yjs-2'); const first = await next();
      const update = delta(first.state, 5000, doc => doc.getText('content').insert(0, 'Network ')); const frame = Buffer.alloc(update.length + 5); frame[0] = 3; frame.writeUInt32BE(1, 1); frame.set(update, 5); ws.send(frame);
      assert.equal((await next()).revision, 2); assert.deepEqual(await next(), { type: 'ack', sequence: 1, revision: 2 });
      const read = await handle(new Request('https://example.test/api/v1/live-documents/live')); assert.equal((await read.json()).content, `Network ${initial.content}`);
      const overwrite = await handle(new Request('https://example.test/api/v1/live-documents/live', { method: 'PUT' })); assert.equal(overwrite.status, 405);
    } finally { ws.terminate(); await server.close(); }
  });
});
