// Real PostgreSQL tests: explicit synthetic local target only; never an ambient DB.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import * as Y from 'yjs';
import { StoreError } from '../src/memory-store.mjs';
import { PostgresDocumentStore, initializePostgresSchema } from '../src/postgres-store.mjs';
import { PostgresCollaborationStore, initializePostgresCollaborationSchema } from '../src/collaboration-store.mjs';
import { MAX_COLLABORATION_UPDATE_BYTES } from '../src/collaboration-state.mjs';

function target(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('A synthetic local PostgreSQL test URL is required'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/opendoc_test' || url.username !== 'opendoc_test' || url.password !== 'synthetic-test-only' || url.search || url.hash) {
    throw new Error('Refusing a database target outside the synthetic local opendoc_test contract');
  }
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local test port');
  return {
    host: url.hostname === '[::1]' ? '::1' : '127.0.0.1', port, user: 'opendoc_test', password: 'synthetic-test-only', database: 'opendoc_test',
    ssl: false, options: '-c search_path=pg_catalog', application_name: 'opendoc-collaboration-synthetic-integration',
    max: 2, connectionTimeoutMillis: 3000, query_timeout: 10000, statement_timeout: 8000, idle_in_transaction_session_timeout: 8000
  };
}
function serverAddresses(raw) {
  if (raw === undefined) return ['127.0.0.1', '::1'];
  if (typeof raw !== 'string' || isIP(raw) === 0 || raw.includes('%')) throw new Error('Expected server address must be one exact IP');
  return [raw];
}
function rejects(code) { return e => e instanceof StoreError && e.code === code && e.message === code && e.cause === undefined; }
function textUpdate(text = 'Synthetic', id = 1) {
  const doc = new Y.Doc(); doc.clientID = id; doc.getText('body').insert(0, text);
  const bytes = Y.encodeStateAsUpdate(doc); doc.destroy(); return bytes;
}
function textFrom(bytes) {
  const doc = new Y.Doc(); Y.applyUpdate(doc, bytes); const value = doc.getText('body').toString(); doc.destroy(); return value;
}

test('collaboration integration refuses remote, non-test, option-bearing and ambient database targets', () => {
  for (const value of [undefined, '', 'postgres://prod.example.test/opendoc_test',
    'postgres://opendoc_test:synthetic-test-only@127.0.0.1/production',
    'postgres://opendoc_test:synthetic-test-only@127.0.0.1/opendoc_test?host=remote.example.test',
    'postgres://opendoc_test:synthetic-test-only@127.0.0.1/opendoc_test#fragment',
    'postgres://postgres:password@127.0.0.1/opendoc_test']) assert.throws(() => target(value));
  assert.equal(target('postgres://opendoc_test:synthetic-test-only@127.0.0.1:55432/opendoc_test').port, 55432);
  assert.deepEqual(serverAddresses(undefined), ['127.0.0.1', '::1']);
  assert.deepEqual(serverAddresses('172.18.0.2'), ['172.18.0.2']);
  for (const value of ['', '*', 'localhost', '172.18.0.0/16', '172.18.0.2,172.18.0.3', '[::1]', 'fe80::1%eth0']) assert.throws(() => serverAddresses(value));
});

test('real PostgreSQL collaboration: durability, isolation, concurrency, quotas, malformed edits, and recovery', {
  skip: process.env.OPENDOC_PG_INTEGRATION !== '1' ? 'Set OPENDOC_PG_INTEGRATION=1 and the synthetic loopback DATABASE_URL to opt in' : false,
  timeout: 90000
}, async t => {
  const config = target(process.env.DATABASE_URL);
  const expectedAddresses = serverAddresses(process.env.OPENDOC_PG_EXPECTED_SERVER_ADDRESS);
  const { Pool } = await import('pg');
  const poolA = new Pool(config), poolB = new Pool(config);
  const schemas = new Map();
  const create = async (limits = {}) => {
    const name = `opendoc_collab_test_${randomBytes(12).toString('hex')}`;
    await initializePostgresCollaborationSchema({ pool: poolA, schema: name, ...limits });
    schemas.set(name, 'collaboration');
    return { name, a: new PostgresCollaborationStore({ pool: poolA, schema: name }), b: new PostgresCollaborationStore({ pool: poolB, schema: name }) };
  };
  t.after(async () => {
    try {
      for (const [name, kind] of schemas) {
        // Only objects successfully created by this test, never CASCADE or patterns.
        const tables = kind === 'collaboration' ? ['collaboration_rooms', 'collaboration_state'] : ['documents', 'store_state'];
        for (const table of tables) await poolA.query(`DROP TABLE "${name}".${table}`);
        await poolA.query(`DROP SCHEMA "${name}"`);
      }
    } finally { await Promise.all([poolA.end(), poolB.end()]); }
  });
  const identity = await poolA.query('SELECT current_database() AS database, current_user AS username, host(inet_server_addr()) AS address, pg_backend_pid() AS pid');
  assert.equal(identity.rows[0].database, 'opendoc_test'); assert.equal(identity.rows[0].username, 'opendoc_test');
  assert.ok(expectedAddresses.includes(identity.rows[0].address), 'Must be the expected local synthetic PostgreSQL server');
  assert.notEqual(identity.rows[0].pid, (await poolB.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);

  // @spec OD-COLLAB-005, OD-COLLAB-003, OD-COLLAB-002
  await t.test('reads create nothing; identical room IDs stay isolated from other tenants, rooms and REST', async () => {
    const { name, a, b } = await create();
    assert.equal(await a.get('tenant-a', 'room'), null);
    const initialCount = await poolA.query(`SELECT room_count FROM "${name}".collaboration_state`);
    assert.equal(initialCount.rows[0].room_count, '0');
    const first = await a.applyUpdate('tenant-a', 'room', textUpdate('A'));
    assert.equal(await b.get('tenant-b', 'room'), null); assert.equal(await b.get('tenant-a', 'other-room'), null);
    await b.applyUpdate('tenant-b', 'room', textUpdate('B'));
    await b.applyUpdate('tenant-a', 'other-room', textUpdate('C'));
    assert.deepEqual(await a.get('tenant-a', 'room'), first);
    assert.equal(textFrom((await b.get('tenant-b', 'room')).state), 'B');
    const restName = `opendoc_rest_test_${randomBytes(12).toString('hex')}`;
    await initializePostgresSchema({ pool: poolA, schema: restName }); schemas.set(restName, 'rest');
    const rest = new PostgresDocumentStore({ pool: poolA, schema: restName });
    const restDoc = await rest.create('tenant-a', { id: 'room', title: 'REST', content: 'Independent REST body' });
    await assert.rejects(initializePostgresCollaborationSchema({ pool: poolA, schema: restName }), rejects('DEPENDENCY_UNAVAILABLE'));
    await assert.rejects(initializePostgresCollaborationSchema({ pool: poolA, schema: name }), rejects('DEPENDENCY_UNAVAILABLE'));
    assert.deepEqual(await rest.get('tenant-a', 'room'), restDoc);
    assert.deepEqual(await a.get('tenant-a', 'room'), first);
    await assert.rejects(new PostgresCollaborationStore({ pool: poolA, schema: restName }).get('tenant-a', 'room'), rejects('DEPENDENCY_UNAVAILABLE'));
  });

  // @spec OD-COLLAB-002, OD-COLLAB-004
  await t.test('independent pools merge concurrent offline edits and replay each without revision growth', async () => {
    const { a, b } = await create();
    const base = await a.applyUpdate('a', 'room', textUpdate('Base'));
    const expected = new Y.Doc(); Y.applyUpdate(expected, base.state);
    const deltas = Array.from({ length: 16 }, (_, i) => {
      const doc = new Y.Doc(); doc.clientID = i + 2; Y.applyUpdate(doc, base.state);
      const vector = Y.encodeStateVector(doc); doc.getText('body').insert(4, `-${i}`);
      const delta = Y.encodeStateAsUpdate(doc, vector); doc.destroy(); Y.applyUpdate(expected, delta); return delta;
    });
    const writes = await Promise.all(deltas.map((delta, i) => (i % 2 ? a : b).applyUpdate('a', 'room', delta)));
    assert.deepEqual(writes.map(row => row.revision).sort((x, y) => x - y), Array.from({ length: 16 }, (_, i) => i + 2));
    const final = await b.get('a', 'room');
    assert.equal(final.revision, 17); assert.equal(textFrom(final.state), expected.getText('body').toString());
    const replays = await Promise.all(deltas.map((delta, i) => (i % 2 ? a : b).applyUpdate('a', 'room', delta)));
    assert.ok(replays.every(row => row.revision === 17));
    assert.deepEqual(await a.get('a', 'room'), final);
    expected.destroy();
  });

  // @spec OD-COLLAB-002, OD-COLLAB-004, OD-COLLAB-006
  for (const ending of ['COMMIT', 'ROLLBACK']) {
    await t.test(`reconnect reads wait for an unsettled writer's ${ending} before choosing their snapshot`, async () => {
      const { name, a } = await create();
      const original = await a.applyUpdate('a', 'room', textUpdate('Before'));
      const editing = new Y.Doc(); editing.clientID = 2; Y.applyUpdate(editing, original.state);
      editing.getText('body').insert(6, '-pending');
      const pendingState = Y.encodeStateAsUpdate(editing); editing.destroy();
      const writer = await poolA.connect();
      let transactionOpen = false;
      let readResult;
      try {
        const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        transactionOpen = true;
        await writer.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await writer.query(`SELECT singleton FROM "${name}".collaboration_state WHERE singleton = true FOR UPDATE`);
        await writer.query(`UPDATE "${name}".collaboration_rooms SET state = $1, revision = revision + 1,
          logical_bytes = $2 WHERE tenant_id = $3 AND room_id = $4`, [Buffer.from(pendingState), pendingState.length + 5, 'a', 'room']);
        await writer.query(`UPDATE "${name}".collaboration_state SET byte_count = byte_count + $1 WHERE singleton = true`,
          [pendingState.length - original.state.length]);
        // Keep this real backend transaction open as if a connection/COMMIT reply
        // were lost. A fresh reconnect must wait instead of publishing old MVCC data.
        let readerPid;
        const observedPool = { async connect() {
          const client = await poolB.connect();
          readerPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          return client;
        } };
        let settled = false;
        readResult = new PostgresCollaborationStore({ pool: observedPool, schema: name }).get('a', 'room')
          .then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
        let blocked = false;
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && !settled) {
          if (readerPid !== undefined) {
            const result = await poolA.query('SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked', [writerPid, readerPid]);
            if (result.rows[0].blocked) { blocked = true; break; }
          }
          await delay(10);
        }
        assert.equal(settled, false, 'A reconnect must not observe state while the earlier writer can still commit');
        assert.equal(blocked, true, 'PostgreSQL must confirm the reader is blocked by the unresolved writer, not merely scheduled later');
        await writer.query(ending);
        transactionOpen = false;
        const result = await readResult;
        if (result.error) throw result.error;
        assert.deepEqual(result.value, ending === 'COMMIT' ? { state: pendingState, revision: 2 } : original);
        assert.equal(textFrom(result.value.state), ending === 'COMMIT' ? 'Before-pending' : 'Before');
      } finally {
        let discard = false;
        if (transactionOpen) { try { await writer.query('ROLLBACK'); } catch { discard = true; } }
        writer.release(discard);
        if (readResult) await readResult;
      }
    });
  }

  // @spec OD-COLLAB-002, OD-COLLAB-004
  await t.test('pool and process restart preserve snapshots, revisions and out-of-order pending edits', async () => {
    const { name, a } = await create();
    const doc = new Y.Doc(); doc.clientID = 42;
    const deltas = []; doc.on('update', bytes => deltas.push(bytes));
    doc.getText('body').insert(0, 'A'); doc.getText('body').insert(1, 'B'); doc.getText('body').delete(0, 1);
    await a.applyUpdate('a', 'room', deltas[1]);
    const pending = await a.applyUpdate('a', 'room', deltas[2]);
    const reopenedPool = new Pool(config);
    try { assert.deepEqual(await new PostgresCollaborationStore({ pool: reopenedPool, schema: name }).get('a', 'room'), pending); }
    finally { await reopenedPool.end(); }
    const child = `
      import { Pool } from 'pg';
      import { PostgresCollaborationStore } from './src/collaboration-store.mjs';
      const pool = new Pool(JSON.parse(process.env.OPENDOC_CHILD_CONFIG));
      try {
        const value = await new PostgresCollaborationStore({ pool, schema: process.env.OPENDOC_CHILD_SCHEMA }).applyUpdate('a', 'room', Uint8Array.from(JSON.parse(process.env.OPENDOC_CHILD_UPDATE)));
        process.stdout.write(JSON.stringify({ state: Array.from(value.state), revision: value.revision }));
      } finally { await pool.end(); }
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', child], {
      cwd: new URL('..', import.meta.url), timeout: 15000,
      env: { OPENDOC_CHILD_CONFIG: JSON.stringify(config), OPENDOC_CHILD_SCHEMA: name, OPENDOC_CHILD_UPDATE: JSON.stringify(Array.from(deltas[0])) }
    });
    const value = JSON.parse(stdout); assert.equal(value.revision, 3); assert.equal(textFrom(Uint8Array.from(value.state)), 'B');
    assert.deepEqual(await a.get('a', 'room'), { state: Uint8Array.from(value.state), revision: 3 });
    doc.destroy();
  });

  // @spec OD-COLLAB-005
  await t.test('global, per-tenant and byte quotas remain atomic across racing connections', async () => {
    const global = await create({ maxRooms: 3 });
    const all = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
      (i % 2 ? global.a : global.b).applyUpdate(`tenant-${i}`, `room-${i}`, textUpdate())));
    assert.equal(all.filter(r => r.status === 'fulfilled').length, 3);
    assert.ok(all.filter(r => r.status === 'rejected').every(r => r.reason.code === 'CAPACITY_EXCEEDED'));
    const tenant = await create({ maxRoomsPerTenant: 2 });
    const same = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      (i % 2 ? tenant.a : tenant.b).applyUpdate('same', `room-${i}`, textUpdate())));
    assert.equal(same.filter(r => r.status === 'fulfilled').length, 2);
    assert.ok(same.filter(r => r.status === 'rejected').every(r => r.reason.code === 'CAPACITY_EXCEEDED'));
    await tenant.a.applyUpdate('different', 'room', textUpdate());
    const update = textUpdate();
    const quota = await create({ maxBytes: (update.length + 2) * 2 });
    const byteRace = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      (i % 2 ? quota.a : quota.b).applyUpdate(String(i), 'r', update)));
    assert.equal(byteRace.filter(r => r.status === 'fulfilled').length, 2);
    assert.ok(byteRace.filter(r => r.status === 'rejected').every(r => r.reason.code === 'CAPACITY_EXCEEDED'));
    const accounting = await poolA.query(`SELECT s.room_count, s.byte_count, count(*) AS rooms, sum(r.logical_bytes) AS actual
      FROM "${quota.name}".collaboration_state s CROSS JOIN "${quota.name}".collaboration_rooms r GROUP BY s.room_count, s.byte_count`);
    assert.equal(accounting.rows[0].room_count, accounting.rows[0].rooms);
    assert.equal(accounting.rows[0].byte_count, accounting.rows[0].actual);
  });

  // @spec OD-COLLAB-002, OD-COLLAB-004, OD-COLLAB-006
  await t.test('malformed edits never persist; lost COMMIT replies are safely resolved by replay', async () => {
    const { name, a } = await create();
    const update = textUpdate();
    for (const [bad, code] of [[new Uint8Array([255, 255]), 'BAD_REQUEST'], [new Uint8Array([...update, 0]), 'BAD_REQUEST'],
      [new Uint8Array([0, 0]), 'BAD_REQUEST'], [new Uint8Array(MAX_COLLABORATION_UPDATE_BYTES + 1), 'TOO_LARGE']]) {
      await assert.rejects(a.applyUpdate('a', 'invalid', bad), rejects(code));
      assert.equal(await a.get('a', 'invalid'), null);
    }
    let loseCommitReply = true;
    const unreliable = { async connect() {
      const client = await poolB.connect();
      return { async query(sql, values) {
        const result = await client.query(sql, values);
        if (sql === 'COMMIT' && loseCommitReply) { loseCommitReply = false; throw new Error('Synthetic lost COMMIT reply'); }
        return result;
      }, release(discard) { client.release(discard); } };
    } };
    const uncertain = new PostgresCollaborationStore({ pool: unreliable, schema: name });
    await assert.rejects(uncertain.applyUpdate('a', 'committed', update), rejects('DEPENDENCY_UNAVAILABLE'));
    const committed = await a.get('a', 'committed'); assert.equal(committed.revision, 1);
    assert.deepEqual(await uncertain.applyUpdate('a', 'committed', update), committed);
    assert.deepEqual(await a.get('a', 'committed'), committed);
    const original = await a.get('a', 'committed');
    await assert.rejects(a.applyUpdate('a', 'committed', new Uint8Array([...update, 0])), rejects('BAD_REQUEST'));
    assert.deepEqual(await a.get('a', 'committed'), original);
    const count = await poolA.query(`SELECT room_count FROM "${name}".collaboration_state`); assert.equal(count.rows[0].room_count, '1');
  });
});
