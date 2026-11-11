// Real PostgreSQL concurrency, HTTP and separate-process socket integration.
// Synthetic loopback target only; never uses ambient PostgreSQL configuration.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import * as Y from 'yjs';
import { Pool } from 'pg';
import { WebSocket } from 'ws';
import { PostgresAccountStore, initializePostgresAccountSchema } from '../src/account-store.mjs';
import { PostgresLiveDocumentStore, initializePostgresLiveDocumentSchema } from '../src/live-document-store.mjs';
import { decodeStateFrame } from '../src/collaboration-client.mjs';
import { encodeLiveUpdateFrame } from '../src/live-collaboration-client.mjs';
import { testDatabaseConfig, testDatabaseChildEnvironment, verifyTestDatabase, TEST_ISSUER, TEST_ORIGIN } from './fixtures/shared-live-sync-common.mjs';

const enabled = process.env.OPENDOC_PG_INTEGRATION === '1';
const initial = { id: 'live', title: 'Guarded title', content: 'Base content' };
const actor = Object.freeze({ principalId: 'edit-a', tenantId: 'tenant-a' });
async function until(check, label, timeout = 6000) {
  const deadline = Date.now() + timeout;
  do { const value = await check(); if (value) return value; await delay(10); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
function edit(state, id, mutate) {
  const doc = new Y.Doc(); doc.clientID = id; Y.applyUpdate(doc, state);
  const vector = Y.encodeStateVector(doc); mutate(doc);
  const result = Y.encodeStateAsUpdate(doc, vector); doc.destroy(); return result;
}
function outcome(promise) { return promise.then(value => ({ value }), error => ({ error })); }
function assertCode(result, code) { assert.equal(result.error?.code, code, `Expected ${code}; received ${JSON.stringify(result)}`); }
// The barrier is before PostgreSQL COMMIT, not merely before its response.
function controlledPool(pool, { pauseCommit = false, rollback = false } = {}) {
  let resume;
  const control = { pid: null, held: false, trace: [], release: () => resume?.() };
  control.pool = { async connect() {
    const client = await pool.connect(); control.pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    return { async query(sql, values) {
      control.trace.push(sql);
      if (sql === 'COMMIT' && pauseCommit) {
        control.held = true; await new Promise(resolve => { resume = resolve; });
        if (rollback) { await client.query('ROLLBACK'); throw new Error('Synthetic administrator rollback'); }
      }
      return client.query(sql, values);
    }, release(discard) { client.release(discard); } };
  } };
  return control;
}
async function assertBlocked(pool, blocker, waiter, label) {
  await until(async () => {
    if (blocker.pid === null || waiter.pid === null) return false;
    return (await pool.query('SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked', [blocker.pid, waiter.pid])).rows[0].blocked;
  }, label, 3500);
}
async function launchServer(schema, accountSchema, options) {
  let nextId = 0, stderr = '', readyResolve, readyReject, exited = false;
  const replies = new Map(), ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const child = fork(fileURLToPath(new URL('./fixtures/guarded-live-server.mjs', import.meta.url)), [schema, accountSchema], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH, OPENDOC_CHILD_OPTIONS: JSON.stringify(options),
      ...testDatabaseChildEnvironment(process.env.DATABASE_URL, process.env.OPENDOC_PG_EXPECTED_SERVER_ADDRESS) }
  });
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-16384); }); child.on('error', readyReject);
  child.on('message', message => {
    if (message.ready) return readyResolve(message);
    const waiting = replies.get(message.id); if (!waiting) return;
    replies.delete(message.id); clearTimeout(waiting.timer);
    if (message.error) { const error = new Error(message.error); error.code = message.error; waiting.reject(error); }
    else waiting.resolve(message.value);
  });
  const exit = new Promise(resolve => child.on('exit', (code, signal) => {
    exited = true; const error = new Error(`Guarded integration server exited (${code ?? signal}): ${stderr}`); readyReject(error);
    for (const waiting of replies.values()) { clearTimeout(waiting.timer); waiting.reject(error); } replies.clear(); resolve();
  }));
  const command = (command, value) => new Promise((resolve, reject) => {
    if (exited || !child.connected) return reject(new Error(`Server is not running: ${stderr}`));
    const id = ++nextId, timer = setTimeout(() => { replies.delete(id); reject(new Error(`Missing fixture reply: ${command}`)); }, 6000);
    replies.set(id, { resolve, reject, timer }); child.send({ id, command, value });
  });
  const close = async () => {
    if (!exited) { try { await command('close'); } catch { child.kill('SIGKILL'); } }
    let timer; try { await Promise.race([exit, new Promise(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000); })]); }
    finally { clearTimeout(timer); } await exit;
  };
  let timer;
  try {
    const identity = await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Child startup timed out: ${stderr}`)), 10000); })]);
    return { ...identity, command, close };
  } catch (error) { child.kill('SIGKILL'); await exit; throw error; }
  finally { clearTimeout(timer); }
}
async function peer(t, server, { token = 'edit-a', room = 'live', ready = true } = {}) {
  const ws = new WebSocket(`${server.url}/api/v1/live-documents/${room}/collaboration`, { origin: TEST_ORIGIN });
  const states = [], controls = [], errors = []; let opened = false, closed = null;
  ws.on('open', () => { opened = true; ws.send(JSON.stringify({ type: 'authenticate', token })); });
  ws.on('message', (data, binary) => { try { if (binary) states.push(decodeStateFrame(data)); else controls.push(JSON.parse(data)); } catch (error) { errors.push(error); } });
  ws.on('close', (code, reason) => { closed = { code, reason: reason.toString() }; }); ws.on('error', error => errors.push(error));
  t.after(() => ws.terminate()); await until(() => opened || closed, 'socket open');
  const result = { ws, states, controls, errors, get closed() { return closed; }, get revision() { return states.at(-1)?.revision ?? 0; },
    send(sequence, update) { ws.send(encodeLiveUpdateFrame(update, sequence)); },
    ack(sequence) { return until(() => controls.find(value => value.type === 'ack' && value.sequence === sequence), `ACK ${sequence}`); },
    waitRevision(revision) { return until(() => result.revision >= revision, `revision ${revision}`); },
    waitClosed() { return until(() => closed, 'socket close'); } };
  if (ready) { await until(() => states.length || closed, 'authoritative snapshot'); assert.equal(closed, null); assert.equal(controls[0]?.protocol, 'opendoc-yjs-2'); }
  return result;
}

test('PostgreSQL live write fences and guarded history across real independent connections/processes', { skip: !enabled, timeout: 240000 }, async t => {
  const pool = new Pool(testDatabaseConfig(process.env.DATABASE_URL));
  const otherPool = new Pool(testDatabaseConfig(process.env.DATABASE_URL)); const namespaces = [];
  await verifyTestDatabase(pool, process.env.OPENDOC_PG_EXPECTED_SERVER_ADDRESS);
  await verifyTestDatabase(otherPool, process.env.OPENDOC_PG_EXPECTED_SERVER_ADDRESS);
  t.after(async () => {
    try {
      for (const { schema, accountSchema, guarded } of namespaces) {
        for (const table of ['memberships', 'identity_bindings', 'principals', 'account_state']) await pool.query(`DROP TABLE "${accountSchema}".${table}`);
        await pool.query(`DROP SCHEMA "${accountSchema}"`);
        if (guarded) await pool.query(`DROP TABLE "${schema}".live_document_checkpoints`);
        await pool.query(`DROP TABLE "${schema}".live_documents; DROP TABLE "${schema}".live_document_state; DROP SCHEMA "${schema}"`);
      }
    } finally { await Promise.all([pool.end(), otherPool.end()]); }
  });
  async function fixture(t, { guarded = false, servers = false } = {}) {
    const suffix = randomBytes(12).toString('hex'), schema = `opendoc_guard_live_test_${suffix}`, accountSchema = `opendoc_guard_acct_test_${suffix}`;
    const guardOptions = guarded ? { historyGuard: { authorityId: randomUUID() } } : {};
    await initializePostgresAccountSchema({ pool, schema: accountSchema });
    await initializePostgresLiveDocumentSchema({ pool, schema, ...guardOptions }); namespaces.push({ schema, accountSchema, guarded });
    const storeOptions = { schema, accountSchema, ...guardOptions };
    const store = new PostgresLiveDocumentStore({ pool, ...storeOptions }), accounts = new PostgresAccountStore({ pool, schema: accountSchema });
    for (const [principalId, role] of [['edit-a', 'editor'], ['edit-b', 'owner'], ['view', 'viewer']]) {
      await accounts.provisionAccount({ issuer: TEST_ISSUER, subject: principalId, principalId, tenantId: 'tenant-a', role });
    }
    const base = await store.create('tenant-a', initial, actor), children = [];
    t.after(async () => { for (const child of children) await child.close(); });
    const launch = async (options = {}) => { const server = await launchServer(schema, accountSchema, { ...options, store: guardOptions }); children.push(server); return server; };
    const result = { schema, accountSchema, store, storeOptions, accounts, base, launch };
    if (servers) { result.a = await launch(); result.b = await launch(); assert.notEqual(result.a.pid, result.b.pid); assert.notEqual(result.a.backendPid, result.b.backendPid); }
    return result;
  }
  const adminChanges = {
    revoke: accounts => accounts.revokeMembership(actor),
    downgrade: accounts => accounts.setMembership({ ...actor, role: 'viewer' }),
    deactivate: accounts => accounts.setPrincipalActive({ principalId: actor.principalId, active: false })
  };
  for (const [change, administer] of Object.entries(adminChanges)) {
    for (const mutation of ['create', 'applyUpdate']) {
      await t.test(`${change} holding the account lock commits before ${mutation} authorization and denies the stale actor`, async t => {
        const f = await fixture(t), admin = controlledPool(pool, { pauseCommit: true }), writer = controlledPool(otherPool);
        const accounts = new PostgresAccountStore({ pool: admin.pool, schema: f.accountSchema });
        const pendingAdmin = outcome(administer(accounts)); let pendingWrite;
        try {
          await until(() => admin.held, 'administrator awaiting commit');
          const gated = new PostgresLiveDocumentStore({ pool: writer.pool, ...f.storeOptions });
          pendingWrite = outcome(mutation === 'create' ? gated.create('tenant-a', { ...initial, id: 'denied' }, actor)
            : gated.applyUpdate('tenant-a', 'live', edit(f.base.state, 2001, doc => doc.getText('content').insert(0, 'Denied ')), actor));
          await assertBlocked(pool, admin, writer, 'live write waits on real account fence');
          assert.equal(writer.trace.some(sql => sql.includes('.live_document_state')), false, 'Lock order is account before live quota');
          admin.release(); assert.equal((await pendingAdmin).error, undefined); assertCode(await pendingWrite, 'FORBIDDEN');
          assert.equal((await f.store.get('tenant-a', 'live')).revision, 1); assert.equal(await f.store.get('tenant-a', 'denied'), null);
        } finally { admin.release(); await pendingAdmin; if (pendingWrite) await pendingWrite; }
      });
    }
  }
  for (const [change, administer] of Object.entries(adminChanges)) {
    await t.test(`an authorized live write holds its shared account fence until commit, blocking ${change}`, async t => {
      const f = await fixture(t, { guarded: true }), writer = controlledPool(otherPool, { pauseCommit: true }), admin = controlledPool(pool);
      const gated = new PostgresLiveDocumentStore({ pool: writer.pool, ...f.storeOptions });
      const pendingWrite = outcome(gated.applyUpdate('tenant-a', 'live', edit(f.base.state, 2101, doc => doc.getText('content').insert(0, 'Accepted ')), actor)); let pendingAdmin;
      try {
        await until(() => writer.held, 'live transaction awaiting commit');
        pendingAdmin = outcome(administer(new PostgresAccountStore({ pool: admin.pool, schema: f.accountSchema })));
        await assertBlocked(pool, writer, admin, 'administrator waits for live account fence');
        writer.release(); assert.equal((await pendingWrite).value.revision, 2); assert.equal((await pendingAdmin).error, undefined);
        const fresh = new PostgresLiveDocumentStore({ pool: otherPool, ...f.storeOptions });
        assertCode(await outcome(fresh.applyUpdate('tenant-a', 'live', Uint8Array.from([0, 0]), actor)), 'FORBIDDEN');
        assert.equal((await f.store.get('tenant-a', 'live')).revision, 2);
      } finally { writer.release(); await pendingWrite; if (pendingAdmin) await pendingAdmin; }
    });
  }
  await t.test('an earlier administrator rollback releases the fence and permits a fresh live write', async t => {
    const f = await fixture(t, { guarded: true }), admin = controlledPool(pool, { pauseCommit: true, rollback: true }), writer = controlledPool(otherPool);
    const pendingAdmin = outcome(adminChanges.revoke(new PostgresAccountStore({ pool: admin.pool, schema: f.accountSchema }))); let pendingWrite;
    try {
      await until(() => admin.held, 'uncommitted revocation');
      pendingWrite = outcome(new PostgresLiveDocumentStore({ pool: writer.pool, ...f.storeOptions }).applyUpdate('tenant-a', 'live', edit(f.base.state, 2201, doc => doc.getText('content').insert(0, 'Allowed ')), actor));
      await assertBlocked(pool, admin, writer, 'live write blocked before rollback'); admin.release();
      assertCode(await pendingAdmin, 'DEPENDENCY_UNAVAILABLE'); assert.equal((await pendingWrite).value.revision, 2);
      assert.equal((await f.store.get('tenant-a', 'live')).content, 'Allowed Base content');
    } finally { admin.release(); await pendingAdmin; if (pendingWrite) await pendingWrite; }
  });
  await t.test('replayed and empty updates are denied after committed revocation before no-op recognition', async t => {
    const f = await fixture(t, { guarded: true }), change = edit(f.base.state, 2301, doc => doc.getText('content').delete(0, 1));
    await f.store.applyUpdate('tenant-a', 'live', change, actor); await f.accounts.revokeMembership(actor);
    for (const update of [change, Uint8Array.from([0, 0])]) assertCode(await outcome(f.store.applyUpdate('tenant-a', 'live', update, actor)), 'FORBIDDEN');
    assert.equal((await f.store.get('tenant-a', 'live')).revision, 2);
  });
  await t.test('HTTP authentication before a delayed request body cannot authorize create after revocation', async t => {
    const f = await fixture(t, { guarded: true }), server = await f.launch(), before = (await server.command('stats')).authenticated;
    const body = JSON.stringify({ ...initial, id: 'delayed' }); let request;
    const response = new Promise((resolve, reject) => {
      request = httpRequest(`${server.httpUrl}/api/v1/live-documents`, { method: 'POST', headers: { authorization: 'Bearer edit-a', origin: TEST_ORIGIN, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, incoming => {
        let text = ''; incoming.on('data', chunk => { text += chunk; }); incoming.on('end', () => resolve({ status: incoming.statusCode, body: JSON.parse(text) }));
      }); request.on('error', reject); request.flushHeaders(); request.write(body.slice(0, 2));
    });
    t.after(() => request.destroy());
    await until(async () => (await server.command('stats')).authenticated > before, 'HTTP auth completed before body');
    await f.accounts.revokeMembership(actor); request.end(body.slice(2));
    const result = await response; assert.equal(result.status, 403); assert.equal(result.body.error.code, 'FORBIDDEN');
    assert.equal(await f.store.get('tenant-a', 'delayed'), null);
    const observed = (await server.command('stats')).actors.at(-1);
    assert.deepEqual(observed.actor, actor); assert.deepEqual(observed.keys.sort(), ['principalId', 'tenantId']); assert.equal(observed.frozen, true);
  });
  await t.test('two guarded server processes atomically converge concurrent writes, preserve narrow actors and reopen after restart', async t => {
    const f = await fixture(t, { guarded: true, servers: true }), a = await peer(t, f.a), b = await peer(t, f.b, { token: 'edit-b' });
    a.send(1, edit(f.base.state, 2401, doc => doc.getText('title').insert(0, 'A ')));
    b.send(1, edit(f.base.state, 2402, doc => doc.getText('content').insert(0, 'B ')));
    assert.deepEqual((await Promise.all([a.ack(1), b.ack(1)])).map(value => value.revision).sort(), [2, 3]);
    await Promise.all([a.waitRevision(3), b.waitRevision(3)]);
    const current = await f.store.get('tenant-a', 'live'); assert.equal(current.title, 'A Guarded title'); assert.equal(current.content, 'B Base content');
    const checkpoint = (await pool.query(`SELECT revision, octet_length(digest) AS digest_bytes FROM "${f.schema}".live_document_checkpoints`)).rows;
    assert.deepEqual(checkpoint, [{ revision: '3', digest_bytes: 32 }]);
    for (const server of [f.a, f.b]) {
      const forwarded = (await server.command('stats')).actors.at(-1);
      assert.deepEqual(forwarded.keys.sort(), ['principalId', 'tenantId']); assert.equal(forwarded.actor.tenantId, 'tenant-a');
      assert.equal(Object.hasOwn(forwarded.actor, 'role'), false); assert.equal(Object.hasOwn(forwarded.actor, 'token'), false); assert.equal(forwarded.frozen, true);
    }
    for (let index = 0; index < 3; index++) assert.equal(await f.b.command('poll', 3), null, 'Unchanged guarded polls must validate and remain healthy');
    const oldPid = f.b.pid; await f.b.close(); await b.waitClosed();
    const restarted = await f.launch(); assert.notEqual(restarted.pid, oldPid);
    const reopened = await peer(t, restarted, { token: 'edit-b' }); assert.equal(reopened.revision, 3);
    assert.deepEqual(Buffer.from(reopened.states[0].state), Buffer.from(current.state));
    reopened.send(1, edit(current.state, 2403, doc => doc.getText('content').delete(0, 1))); assert.equal((await reopened.ack(1)).revision, 4); await a.waitRevision(4);
    assert.equal((await pool.query(`SELECT quarantined FROM "${f.schema}".live_document_state`)).rows[0].quarantined, false);
  });
  await t.test('guarded reads wait for an unsettled write and see one atomic canonical/checkpoint commit', async t => {
    const f = await fixture(t, { guarded: true }), writer = controlledPool(otherPool, { pauseCommit: true }), reader = controlledPool(pool);
    const pendingWrite = outcome(new PostgresLiveDocumentStore({ pool: writer.pool, ...f.storeOptions }).applyUpdate('tenant-a', 'live', edit(f.base.state, 2501, doc => doc.getText('title').insert(0, 'Atomic ')), actor)); let pendingRead;
    try {
      await until(() => writer.held, 'live write before COMMIT');
      pendingRead = outcome(new PostgresLiveDocumentStore({ pool: reader.pool, ...f.storeOptions }).getIfChanged('tenant-a', 'live', 1));
      await assertBlocked(pool, writer, reader, 'guarded read waits on live transaction'); writer.release();
      assert.equal((await pendingWrite).value.revision, 2); assert.equal((await pendingRead).value.revision, 2);
      assert.equal(await f.store.getIfChanged('tenant-a', 'live', 2), null);
    } finally { writer.release(); await pendingWrite; if (pendingRead) await pendingRead; }
  });

  async function canonical(f) { return (await pool.query(`SELECT * FROM "${f.schema}".live_documents WHERE tenant_id = 'tenant-a' AND document_id = 'live'`)).rows[0]; }
  async function putCanonical(f, row) {
    await pool.query(`INSERT INTO "${f.schema}".live_documents (tenant_id, document_id, state, title_json, content_json, logical_bytes, revision, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (tenant_id, document_id) DO UPDATE SET
      state = EXCLUDED.state, title_json = EXCLUDED.title_json, content_json = EXCLUDED.content_json, logical_bytes = EXCLUDED.logical_bytes,
      revision = EXCLUDED.revision, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
    [row.tenant_id, row.document_id, row.state, row.title_json, row.content_json, row.logical_bytes, row.revision, row.created_at, row.updated_at]);
  }
  const corruptions = {
    'document-only rollback': async (f, original) => putCanonical(f, original),
    'equal-revision valid Yjs byte replacement': async f => {
      const row = await canonical(f), doc = new Y.Doc(); Y.applyUpdate(doc, row.state); doc.getText('content').insert(0, 'Tampered ');
      const state = Buffer.from(Y.encodeStateAsUpdate(doc)), title = Buffer.from(JSON.stringify(doc.getText('title').toString())), content = Buffer.from(JSON.stringify(doc.getText('content').toString())); doc.destroy();
      await putCanonical(f, { ...row, state, title_json: title, content_json: content, logical_bytes: state.length + title.length + content.length + row.tenant_id.length + row.document_id.length });
    },
    'equal-revision projection-only replacement': async f => {
      const row = await canonical(f), title = Buffer.from(JSON.stringify('Changed title'));
      await putCanonical(f, { ...row, title_json: title, logical_bytes: Number(row.logical_bytes) - row.title_json.length + title.length });
    },
    'missing canonical row': async f => { await pool.query(`DELETE FROM "${f.schema}".live_documents WHERE tenant_id = 'tenant-a' AND document_id = 'live'`); },
    'missing checkpoint marker': async f => { await pool.query(`DELETE FROM "${f.schema}".live_document_checkpoints WHERE tenant_id = 'tenant-a' AND document_id = 'live'`); },
    'checkpoint-only revision rollback': async f => { await pool.query(`UPDATE "${f.schema}".live_document_checkpoints SET revision = 1 WHERE tenant_id = 'tenant-a' AND document_id = 'live'`); }
  };
  for (const [label, corrupt] of Object.entries(corruptions)) {
    await t.test(`${label} commits sticky namespace quarantine before errors and survives room/process restart`, async t => {
      const f = await fixture(t, { guarded: true, servers: true }), original = await canonical(f);
      await f.store.applyUpdate('tenant-a', 'live', edit(f.base.state, 2601, doc => doc.getText('content').insert(0, 'Committed ')), actor);
      await f.store.create('tenant-a', { ...initial, id: 'other' }, actor);
      const good = await canonical(f), checkpoint = (await pool.query(`SELECT * FROM "${f.schema}".live_document_checkpoints WHERE tenant_id = 'tenant-a' AND document_id = 'live'`)).rows[0];
      const a = await peer(t, f.a), b = await peer(t, f.b, { token: 'view' }); assert.equal(a.revision, 2); assert.equal(b.revision, 2);
      await corrupt(f, original);
      // Even an unchanged-revision poll must fetch and verify the actual bytes.
      assertCode(await outcome(f.store.getIfChanged('tenant-a', 'live', 2)), 'DEPENDENCY_UNAVAILABLE');
      assert.equal((await pool.query(`SELECT quarantined FROM "${f.schema}".live_document_state`)).rows[0].quarantined, true, 'Quarantine must be durable before the failing call returns');
      assert.equal((await a.waitClosed()).code, 1011); assert.equal((await b.waitClosed()).code, 1011);
      for (const client of [a, b]) { assert.equal(client.states.length, 1); assert.equal(client.controls.filter(value => value.type === 'ack').length, 0); }
      // Repairing the triggering row/marker is not an implicit reset procedure.
      await putCanonical(f, good);
      await pool.query(`INSERT INTO "${f.schema}".live_document_checkpoints (tenant_id, document_id, revision, digest) VALUES ($1, $2, $3, $4)
        ON CONFLICT (tenant_id, document_id) DO UPDATE SET revision = EXCLUDED.revision, digest = EXCLUDED.digest`,
      [checkpoint.tenant_id, checkpoint.document_id, checkpoint.revision, checkpoint.digest]);
      const reconnect = await peer(t, f.a, { ready: false }); assert.equal((await reconnect.waitClosed()).code, 1011); assert.equal(reconnect.states.length, 0);
      const otherRoom = await peer(t, f.b, { room: 'other', ready: false }); assert.equal((await otherRoom.waitClosed()).code, 1011); assert.equal(otherRoom.states.length, 0);
      const oldPid = f.a.pid; await f.a.close(); const restarted = await f.launch(); assert.notEqual(restarted.pid, oldPid);
      assertCode(await outcome(restarted.command('get')), 'DEPENDENCY_UNAVAILABLE');
      const afterRestart = await peer(t, restarted, { ready: false }); assert.equal((await afterRestart.waitClosed()).code, 1011); assert.equal(afterRestart.states.length, 0);
      assertCode(await outcome(f.store.create('tenant-a', { ...initial, id: 'blocked' }, actor)), 'DEPENDENCY_UNAVAILABLE');
      assertCode(await outcome(f.store.applyUpdate('tenant-a', 'live', Uint8Array.from([0, 0]), actor)), 'DEPENDENCY_UNAVAILABLE');
      assertCode(await outcome(f.store.list('tenant-a')), 'DEPENDENCY_UNAVAILABLE');
    });
  }
  await t.test('a missing namespace authority marker remains unavailable through process restart', async t => {
    const f = await fixture(t, { guarded: true, servers: true });
    await pool.query(`DELETE FROM "${f.schema}".live_document_state WHERE singleton = true`);
    assertCode(await outcome(f.a.command('get')), 'DEPENDENCY_UNAVAILABLE'); assertCode(await outcome(f.b.command('get')), 'DEPENDENCY_UNAVAILABLE');
    await f.a.close(); const restarted = await f.launch(); assertCode(await outcome(restarted.command('get')), 'DEPENDENCY_UNAVAILABLE');
    const closed = await peer(t, restarted, { ready: false }); assert.equal((await closed.waitClosed()).code, 1011); assert.equal(closed.states.length, 0);
  });
  await t.test('wrong authority pins and caller-ahead revisions fail without quarantining a healthy pinned namespace', async t => {
    const f = await fixture(t, { guarded: true });
    const wrongPin = new PostgresLiveDocumentStore({ pool: otherPool, ...f.storeOptions, historyGuard: { authorityId: randomUUID() } });
    assertCode(await outcome(wrongPin.get('tenant-a', 'live')), 'DEPENDENCY_UNAVAILABLE');
    assertCode(await outcome(f.store.getIfChanged('tenant-a', 'live', 10)), 'DEPENDENCY_UNAVAILABLE');
    assert.equal((await pool.query(`SELECT quarantined FROM "${f.schema}".live_document_state`)).rows[0].quarantined, false);
    assert.equal((await f.store.get('tenant-a', 'live')).revision, 1);
  });
  await t.test('a lost real COMMIT reply causes no ACK or quarantine and a distinct process reopens the durable checkpoint', async t => {
    const f = await fixture(t, { guarded: true, servers: true }), a = await peer(t, f.a), b = await peer(t, f.b, { token: 'view' });
    const change = edit(f.base.state, 2701, doc => doc.getText('content').delete(0, 1));
    await f.a.command('lose-commit'); a.send(1, change);
    assert.equal((await a.waitClosed()).code, 1011); assert.equal(a.controls.filter(value => value.type === 'ack').length, 0);
    assert.equal((await f.a.command('stats')).lostCommits, 1); await b.waitRevision(2);
    assert.equal((await pool.query(`SELECT quarantined FROM "${f.schema}".live_document_state`)).rows[0].quarantined, false);
    await f.a.close(); const restarted = await f.launch(), replay = await peer(t, restarted);
    assert.equal(replay.revision, 2); replay.send(1, change); assert.equal((await replay.ack(1)).revision, 2);
    assert.equal(await restarted.command('poll', 2), null);
  });
  await t.test('a delayed successful COMMIT response cannot falsely quarantine newer durable history', async t => {
    const f = await fixture(t, { guarded: true, servers: true }), a = await peer(t, f.a), b = await peer(t, f.b, { token: 'edit-b' });
    await f.a.command('hold-commit-reply'); a.send(1, edit(f.base.state, 2801, doc => doc.getText('content').insert(0, 'First ')));
    try {
      await until(async () => (await f.a.command('stats')).heldCommits === 1, 'committed response held'); await b.waitRevision(2);
      b.send(1, edit(b.states.at(-1).state, 2802, doc => doc.getText('title').insert(0, 'Second '))); assert.equal((await b.ack(1)).revision, 3);
      await f.a.command('release-commits'); await until(() => a.controls.some(value => value.type === 'ack' && value.sequence === 1) || a.closed, 'delayed commit outcome');
      assert.equal((await pool.query(`SELECT quarantined FROM "${f.schema}".live_document_state`)).rows[0].quarantined, false);
      assert.equal((await f.store.get('tenant-a', 'live')).revision, 3); const reopened = await peer(t, f.a); assert.equal(reopened.revision, 3);
    } finally { await f.a.command('release-commits'); }
  });
  await t.test('a late valid older read completion does not quarantine a newer checkpoint', async t => {
    const f = await fixture(t, { guarded: true, servers: true }), a = await peer(t, f.a), b = await peer(t, f.b, { token: 'view' });
    await f.b.command('hold-changed-polls'); a.send(1, edit(f.base.state, 2901, doc => doc.getText('content').insert(0, 'First '))); await a.ack(1);
    try {
      await until(async () => (await f.b.command('stats')).heldPolls === 1, 'old changed poll committed but not delivered');
      a.send(2, edit(a.states.at(-1).state, 2902, doc => doc.getText('title').insert(0, 'Newer '))); assert.equal((await a.ack(2)).revision, 3);
      assert.equal((await f.store.get('tenant-a', 'live')).revision, 3); await f.b.command('release-polls'); await b.waitRevision(3);
      assert.equal((await pool.query(`SELECT quarantined FROM "${f.schema}".live_document_state`)).rows[0].quarantined, false);
      assert.equal(await f.b.command('poll', 3), null); assert.equal(b.closed, null);
      for (let index = 1; index < b.states.length; index++) assert.ok(b.states[index].revision >= b.states[index - 1].revision);
    } finally { await f.b.command('release-polls'); }
  });
});
