// Real PostgreSQL and separate-process socket tests. Explicit synthetic target only.
// @spec OD-LIVE-001 OD-LIVE-002 OD-LIVE-003 OD-LIVE-004 OD-LIVE-005
// @spec OD-LIVE-SHARED-001 OD-LIVE-SHARED-002 OD-LIVE-SHARED-003 OD-LIVE-SHARED-004 OD-LIVE-SHARED-005
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
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
import { testDatabaseConfig, testDatabaseChildEnvironment, expectedServerAddresses, verifyTestDatabase, TEST_DATABASE_URL, TEST_CI_DATABASE_URL, TEST_ISSUER, TEST_ORIGIN } from './fixtures/shared-live-sync-common.mjs';

const enabled = process.env.OPENDOC_PG_INTEGRATION === '1';
const initial = { id: 'live', title: 'Shared title', content: 'Base content' };
async function until(check, label, timeout = 6000) {
  const deadline = Date.now() + timeout;
  do { const value = await check(); if (value) return value; await delay(10); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
function edit(state, id, mutate) {
  const doc = new Y.Doc(); doc.clientID = id; Y.applyUpdate(doc, state);
  const vector = Y.encodeStateVector(doc); mutate(doc);
  const update = Y.encodeStateAsUpdate(doc, vector); doc.destroy(); return update;
}
function projected(state) {
  const doc = new Y.Doc(); Y.applyUpdate(doc, state);
  const result = { title: doc.getText('title').toString(), content: doc.getText('content').toString() }; doc.destroy(); return result;
}
function assertMonotonic(peer) {
  for (let index = 1; index < peer.states.length; index++) assert.ok(peer.states[index].revision >= peer.states[index - 1].revision, 'No lower-revision frame may be delivered');
}
async function launchServer(schema, accountSchema, options = {}) {
  let nextId = 0, stderr = '', readyResolve, readyReject, exited = false;
  const replies = new Map();
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const env = { PATH: process.env.PATH, OPENDOC_CHILD_OPTIONS: JSON.stringify(options),
    ...testDatabaseChildEnvironment(process.env.DATABASE_URL, process.env.OPENDOC_PG_EXPECTED_SERVER_ADDRESS) };
  const child = fork(fileURLToPath(new URL('./fixtures/shared-live-sync-server.mjs', import.meta.url)), [schema, accountSchema], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), env, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-16384); });
  child.on('error', readyReject);
  child.on('message', message => {
    if (message.ready) { readyResolve(message); return; }
    const waiting = replies.get(message.id); if (!waiting) return;
    replies.delete(message.id); clearTimeout(waiting.timer);
    if (message.error) waiting.reject(new Error(message.error)); else waiting.resolve(message.value);
  });
  const exit = new Promise(resolve => child.on('exit', (code, signal) => {
    exited = true; const error = new Error(`Synthetic server exited (${code ?? signal}): ${stderr}`); readyReject(error);
    for (const waiting of replies.values()) { clearTimeout(waiting.timer); waiting.reject(error); } replies.clear(); resolve({ code, signal });
  }));
  const command = (command, value) => new Promise((resolve, reject) => {
    if (exited || !child.connected) return reject(new Error(`Synthetic server is not running: ${stderr}`));
    const id = ++nextId;
    const timer = setTimeout(() => { replies.delete(id); reject(new Error(`Missing fixture reply: ${command}`)); }, 5000);
    replies.set(id, { resolve, reject, timer }); child.send({ id, command, value });
  });
  const close = async () => {
    if (!exited) { try { await command('close'); } catch { child.kill('SIGKILL'); } }
    let timer; try { await Promise.race([exit, new Promise(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000); })]); } finally { clearTimeout(timer); }
    await exit;
  };
  let timer;
  try {
    const identity = await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Child startup timed out: ${stderr}`)), 10000); })]);
    return { ...identity, child, command, close, exit };
  } catch (error) { child.kill('SIGKILL'); await exit; throw error; }
  finally { clearTimeout(timer); }
}
async function peer(t, server, { token = 'edit-a', room = 'live', ready = true } = {}) {
  const ws = new WebSocket(`${server.url}/api/v1/live-documents/${room}/collaboration`, { origin: TEST_ORIGIN });
  const states = [], controls = [], errors = [], doc = new Y.Doc(); let opened = false, closeResult = null;
  ws.on('open', () => { opened = true; ws.send(JSON.stringify({ type: 'authenticate', token })); });
  ws.on('message', (data, binary) => {
    try {
      if (binary) { const state = decodeStateFrame(data); states.push(state); Y.applyUpdate(doc, state.state); }
      else controls.push(JSON.parse(data));
    } catch (error) { errors.push(error); }
  });
  ws.on('error', error => errors.push(error));
  ws.on('close', (code, reason) => { closeResult = { code, reason: reason.toString() }; });
  t.after(() => { ws.terminate(); doc.destroy(); });
  await until(() => opened || closeResult, 'socket open');
  const result = { ws, doc, states, controls, errors, get closed() { return closeResult; },
    get revision() { return states.at(-1)?.revision ?? 0; },
    send(sequence, update) { ws.send(encodeLiveUpdateFrame(update, sequence)); },
    ack(sequence) { return until(() => controls.find(value => value.type === 'ack' && value.sequence === sequence), `ACK ${sequence}`); },
    waitRevision(revision) { return until(() => result.revision >= revision, `revision ${revision}`); },
    waitClosed() { return until(() => closeResult, 'socket close'); }
  };
  if (ready) {
    await until(() => states.length || closeResult, 'first authoritative snapshot');
    assert.equal(closeResult, null, `Unexpected close: ${JSON.stringify(closeResult)}`);
    assert.equal(controls[0]?.protocol, 'opendoc-yjs-2'); assert.equal(errors.length, 0);
  }
  return result;
}

test('shared live integration allows only exact synthetic loopback database URLs on the local and CI test ports', () => {
  assert.equal(testDatabaseConfig(TEST_DATABASE_URL).port, 55432);
  assert.equal(testDatabaseConfig(TEST_CI_DATABASE_URL).port, 5432);
  for (const raw of [undefined, '', 'postgres://prod.example.test/opendoc_test', TEST_DATABASE_URL.replace('55432', '55433'), TEST_DATABASE_URL.replace(':55432', ''),
    TEST_DATABASE_URL.replace('127.0.0.1', 'localhost'), TEST_DATABASE_URL.replace('/opendoc_test', '/production'),
    `${TEST_DATABASE_URL}?host=remote`, `${TEST_DATABASE_URL}#fragment`, TEST_DATABASE_URL.replace('synthetic-test-only', 'password')]) assert.throws(() => testDatabaseConfig(raw));
  assert.deepEqual(expectedServerAddresses(undefined), ['127.0.0.1', '::1']);
  assert.deepEqual(expectedServerAddresses('172.18.0.2'), ['172.18.0.2']);
  for (const pin of ['', '*', 'localhost', '172.18.0.0/16', '172.18.0.2,172.18.0.3', '[::1]', 'fe80::1%eth0']) assert.throws(() => expectedServerAddresses(pin));
  for (const target of [TEST_DATABASE_URL, TEST_CI_DATABASE_URL]) {
    assert.deepEqual(testDatabaseChildEnvironment(target), { OPENDOC_PG_INTEGRATION: '1', DATABASE_URL: target });
    assert.deepEqual(testDatabaseChildEnvironment(target, '172.18.0.2'), {
      OPENDOC_PG_INTEGRATION: '1', DATABASE_URL: target, OPENDOC_PG_EXPECTED_SERVER_ADDRESS: '172.18.0.2'
    });
  }
  assert.throws(() => testDatabaseChildEnvironment('postgres://production.example.test/opendoc_test'));
  assert.throws(() => testDatabaseChildEnvironment(TEST_CI_DATABASE_URL, '172.18.0.0/16'));
});

test('shared PostgreSQL live synchronization across separate socket-server processes', { skip: !enabled, timeout: 180000 }, async t => {
  const pool = new Pool(testDatabaseConfig(process.env.DATABASE_URL)); const schemas = [];
  t.after(async () => {
    try {
      for (const { live, account } of schemas) {
        if (account) { for (const table of ['memberships', 'identity_bindings', 'principals', 'account_state']) await pool.query(`DROP TABLE "${account}".${table}`); await pool.query(`DROP SCHEMA "${account}"`); }
        if (live) { await pool.query(`DROP TABLE "${live}".live_documents; DROP TABLE "${live}".live_document_state; DROP SCHEMA "${live}"`); }
      }
    } finally { await pool.end(); }
  });
  const identity = await verifyTestDatabase(pool, process.env.OPENDOC_PG_EXPECTED_SERVER_ADDRESS);
  async function fixture(t, { options = {}, extraRooms = [] } = {}) {
    const names = {}; schemas.push(names);
    const suffix = randomBytes(12).toString('hex'), schema = `opendoc_shared_live_test_${suffix}`, accountSchema = `opendoc_shared_acct_test_${suffix}`;
    await initializePostgresLiveDocumentSchema({ pool, schema }); names.live = schema;
    await initializePostgresAccountSchema({ pool, schema: accountSchema }); names.account = accountSchema;
    const store = new PostgresLiveDocumentStore({ pool, schema }), accounts = new PostgresAccountStore({ pool, schema: accountSchema });
    for (const [subject, role, tenantId] of [['edit-a', 'editor', 'tenant-a'], ['edit-b', 'editor', 'tenant-a'], ['view', 'viewer', 'tenant-a'], ['comment', 'commenter', 'tenant-a'], ['other', 'editor', 'tenant-b']]) {
      await accounts.provisionAccount({ issuer: TEST_ISSUER, subject, principalId: subject, tenantId, role });
    }
    const base = await store.create('tenant-a', initial);
    await store.create('tenant-b', { ...initial, content: 'Private other tenant' });
    for (const id of extraRooms) await store.create('tenant-a', { ...initial, id });
    const servers = [];
    t.after(async () => { for (const server of servers) await server.close(); });
    const launch = async (override = options) => { const server = await launchServer(schema, accountSchema, override); servers.push(server); return server; };
    const a = await launch(), b = await launch();
    assert.notEqual(a.pid, b.pid); assert.notEqual(a.pid, process.pid); assert.notEqual(b.pid, process.pid);
    assert.notEqual(a.backendPid, b.backendPid); assert.notEqual(a.backendPid, identity.pid);
    return { a, b, launch, store, accounts, base, schema };
  }

  await t.test('two processes converge concurrent edits and deletion-only updates without explicit sync', async t => {
    const f = await fixture(t), a = await peer(t, f.a), b = await peer(t, f.b, { token: 'edit-b' });
    const changes = [edit(f.base.state, 1101, doc => doc.getText('title').insert(0, 'A ')), edit(f.base.state, 1102, doc => doc.getText('content').insert(0, 'B '))];
    a.send(1, changes[0]); b.send(1, changes[1]);
    const acknowledgements = await Promise.all([a.ack(1), b.ack(1)]);
    assert.deepEqual(acknowledgements.map(value => value.revision).sort(), [2, 3]);
    await Promise.all([a.waitRevision(3), b.waitRevision(3)]);
    const expected = new Y.Doc(); Y.applyUpdate(expected, f.base.state); changes.forEach(change => Y.applyUpdate(expected, change));
    for (const client of [a, b]) {
      assert.equal(client.doc.getText('title').toString(), expected.getText('title').toString());
      assert.equal(client.doc.getText('content').toString(), expected.getText('content').toString());
    }
    assert.deepEqual(projected((await f.store.get('tenant-a', 'live')).state), projected(Y.encodeStateAsUpdate(expected))); expected.destroy();
    const before = Y.encodeStateVector(a.doc), remove = edit(a.states.at(-1).state, 1103, doc => doc.getText('content').delete(0, 1));
    a.send(2, remove); assert.equal((await a.ack(2)).revision, 4); await b.waitRevision(4);
    assert.deepEqual(Y.encodeStateVector(a.doc), before, 'Deletion-only writes do not advance a Yjs state vector');
    assert.equal(a.doc.getText('content').toString(), b.doc.getText('content').toString());
    assert.equal((await f.store.get('tenant-a', 'live')).content, b.doc.getText('content').toString());
    const frameCount = b.states.length, ackCount = b.controls.filter(value => value.type === 'ack').length;
    await delay(250); assert.equal(b.states.length, frameCount, 'Equal poll revisions must not produce duplicate snapshots');
    assert.equal(b.controls.filter(value => value.type === 'ack').length, ackCount, 'Polls must not manufacture save acknowledgements');
    assertMonotonic(a); assertMonotonic(b); assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, []);
  });

  await t.test('an actual process restart reopens committed state and resumes cross-process updates', async t => {
    const f = await fixture(t), a = await peer(t, f.a), b = await peer(t, f.b, { token: 'view' });
    a.send(1, edit(f.base.state, 1201, doc => doc.getText('content').insert(0, 'Before restart ')));
    await a.ack(1); await b.waitRevision(2);
    const oldPid = f.b.pid; await f.b.close(); await b.waitClosed();
    a.send(2, edit(a.states.at(-1).state, 1202, doc => doc.getText('title').insert(0, 'While offline '))); await a.ack(2);
    const restarted = await f.launch(); assert.notEqual(restarted.pid, oldPid);
    const reopened = await peer(t, restarted, { token: 'edit-b' }); assert.equal(reopened.revision, 3);
    assert.deepEqual(projected(reopened.states[0].state), projected((await f.store.get('tenant-a', 'live')).state));
    reopened.send(1, edit(reopened.states[0].state, 1203, doc => doc.getText('content').delete(0, 1)));
    await reopened.ack(1); await a.waitRevision(4); assertMonotonic(a); assertMonotonic(reopened);
  });

  await t.test('tenant isolation, reader roles and revoked receivers hold across both processes', async t => {
    const f = await fixture(t), writer = await peer(t, f.a), viewer = await peer(t, f.b, { token: 'view' }), other = await peer(t, f.b, { token: 'other' });
    const outsider = await peer(t, f.b, { token: 'unprovisioned', ready: false }); assert.equal((await outsider.waitClosed()).code, 1008); assert.equal(outsider.states.length, 0);
    for (const token of ['view', 'comment']) {
      const reader = await peer(t, f.b, { token }); reader.send(1, edit(reader.states[0].state, token === 'view' ? 1301 : 1302, doc => doc.getText('content').insert(0, 'Denied ')));
      assert.equal((await reader.waitClosed()).code, 1008); assert.equal(reader.controls.filter(value => value.type === 'ack').length, 0);
    }
    assert.equal((await f.store.get('tenant-a', 'live')).revision, 1);
    await f.accounts.revokeMembership({ principalId: 'view', tenantId: 'tenant-a' });
    writer.send(1, edit(f.base.state, 1303, doc => doc.getText('content').insert(0, 'Tenant A only '))); await writer.ack(1);
    assert.equal((await viewer.waitClosed()).code, 1008); assert.equal(viewer.states.length, 1, 'Revoked idle receiver must not receive the remote commit');
    await delay(150); assert.equal(other.states.length, 1); assert.equal(other.doc.getText('content').toString(), 'Private other tenant');
    other.send(1, edit(other.states[0].state, 1304, doc => doc.getText('content').insert(0, 'Tenant B only '))); await other.ack(1);
    await delay(150); assert.equal(writer.revision, 2); assert.ok(!writer.doc.getText('content').toString().includes('Tenant B'));
    await f.accounts.setMembership({ principalId: 'edit-a', tenantId: 'tenant-a', role: 'viewer' });
    writer.send(2, edit(writer.states.at(-1).state, 1305, doc => doc.getText('content').insert(0, 'After downgrade ')));
    assert.equal((await writer.waitClosed()).code, 1008); assert.equal((await f.store.get('tenant-a', 'live')).revision, 2);
  });

  await t.test('a stale authority reply never delivers a lower revision and recovery starts from durable state', async t => {
    const f = await fixture(t), a = await peer(t, f.a), b = await peer(t, f.b, { token: 'view' });
    a.send(1, edit(f.base.state, 1401, doc => doc.getText('content').insert(0, 'Newer '))); await a.ack(1); await b.waitRevision(2);
    await f.b.command('snapshot', { ...f.base, state: Array.from(f.base.state) });
    assert.equal((await b.waitClosed()).code, 1011); assert.equal(b.revision, 2); assertMonotonic(b);
    assert.equal(b.states.filter(state => state.revision === 1).length, 1);
    await f.b.command('snapshot', null);
    const reopened = await peer(t, f.b, { token: 'view' }); assert.equal(reopened.revision, 2);
  });

  await t.test('membership revoked while a changed snapshot is pending is checked again before cross-process delivery', async t => {
    const f = await fixture(t), writer = await peer(t, f.a), receiver = await peer(t, f.b, { token: 'view' });
    await f.b.command('hold-changed-polls');
    writer.send(1, edit(f.base.state, 1451, doc => doc.getText('content').insert(0, 'Restricted '))); await writer.ack(1);
    await until(async () => (await f.b.command('stats')).heldPolls === 1, 'changed snapshot held before delivery');
    await f.accounts.revokeMembership({ principalId: 'view', tenantId: 'tenant-a' });
    await f.b.command('release-polls');
    assert.equal((await receiver.waitClosed()).code, 1008);
    assert.equal(receiver.states.length, 1, 'Post-read reauthorization must prevent the held update from reaching a revoked receiver');
    assert.equal(receiver.controls.filter(value => value.type === 'ack').length, 0);
    assert.equal((await f.store.get('tenant-a', 'live')).revision, 2);
  });

  await t.test('a poll dependency outage fails closed and reconnect recovers every committed update', async t => {
    const f = await fixture(t), a = await peer(t, f.a), b = await peer(t, f.b, { token: 'view' });
    await f.b.command('fail-polls', true); assert.equal((await b.waitClosed()).code, 1011);
    a.send(1, edit(f.base.state, 1501, doc => doc.getText('content').insert(0, 'During outage '))); await a.ack(1);
    assert.equal(b.revision, 1); assert.equal(b.controls.filter(value => value.type === 'ack').length, 0);
    await f.b.command('fail-polls', false);
    const recovered = await peer(t, f.b, { token: 'view' }); assert.equal(recovered.revision, 2);
    a.send(2, edit(a.states.at(-1).state, 1502, doc => doc.getText('content').delete(0, 1))); await a.ack(2); await recovered.waitRevision(3);
    assert.equal(recovered.doc.getText('content').toString(), (await f.store.get('tenant-a', 'live')).content);
  });

  await t.test('a lost real COMMIT reply sends no false ACK while another process observes durability; replay is idempotent', async t => {
    const f = await fixture(t), a = await peer(t, f.a), local = await peer(t, f.a, { token: 'view' }), remote = await peer(t, f.b, { token: 'view' });
    const change = edit(f.base.state, 1601, doc => doc.getText('content').delete(0, 1));
    await f.a.command('lose-commit'); a.send(1, change);
    assert.equal((await a.waitClosed()).code, 1011); assert.equal((await local.waitClosed()).code, 1011);
    assert.equal(a.controls.filter(value => value.type === 'ack').length, 0); assert.equal(local.controls.filter(value => value.type === 'ack').length, 0);
    assert.equal(a.states.length, 1); assert.equal(local.states.length, 1, 'Ambiguous local commit result must not be broadcast as confirmed state');
    assert.equal((await f.a.command('stats')).lostCommits, 1, 'Fault must follow a real PostgreSQL COMMIT');
    await remote.waitRevision(2); const committed = await f.store.get('tenant-a', 'live'); assert.equal(committed.content, 'ase content');
    const reconnect = await peer(t, f.a); assert.equal(reconnect.revision, 2);
    reconnect.send(1, change); assert.deepEqual(await reconnect.ack(1), { type: 'ack', sequence: 1, revision: 2 });
    assert.equal((await f.store.get('tenant-a', 'live')).revision, 2); assertMonotonic(remote); assertMonotonic(reconnect);
  });

  await t.test('polling is active-room-only, bounded under a held adapter, and releases room admission after disconnect', async t => {
    const limits = { maxRooms: 2, maxConnections: 4, maxConnectionsPerRoom: 2, maxPendingOperations: 2, maxDependencyOperations: 2, operationTimeoutMs: 350 };
    const f = await fixture(t, { options: { limits }, extraRooms: ['second', 'third'] });
    await delay(150); assert.equal((await f.b.command('stats')).pollCalls, 0, 'No scans of inactive durable rooms');
    const one = await peer(t, f.b), two = await peer(t, f.b, { room: 'second' });
    const denied = await peer(t, f.b, { room: 'third', ready: false }); assert.equal((await denied.waitClosed()).code, 1013); assert.equal(denied.states.length, 0);
    await f.b.command('hold-polls', true);
    const held = await until(async () => { const stats = await f.b.command('stats'); return stats.heldPolls > 0 ? stats : false; }, 'held shared poll');
    for (let i = 0; i < 6; i++) {
      const stats = await f.b.command('stats'); assert.ok(stats.dependencyOperations <= 2); assert.ok(stats.pendingOperations <= 2); assert.ok(stats.inFlightPolls <= 2); assert.ok(stats.maximumInFlightPolls <= 2); await delay(20);
    }
    await Promise.all([one.waitClosed(), two.waitClosed()]);
    const abandoned = await f.b.command('stats'); await delay(150); const stable = await f.b.command('stats');
    assert.ok(abandoned.inFlightPolls > 0, 'Timed-out dependencies retain their slots until actually settled');
    assert.equal(stable.pollCalls, abandoned.pollCalls, 'No unbounded abandoned polling promises'); assert.ok(stable.pollCalls <= held.pollCalls + 1);
    await f.b.command('release-polls'); await until(async () => { const stats = await f.b.command('stats'); return stats.dependencyOperations === 0 && stats.rooms === 0; }, 'poll and room cleanup');
    const third = await peer(t, f.b, { room: 'third' }); assert.equal(third.revision, 1);
    third.ws.close(); await third.waitClosed(); await until(async () => (await f.b.command('stats')).rooms === 0, 'last room retirement');
    const stopped = (await f.b.command('stats')).pollCalls; await delay(150); assert.equal((await f.b.command('stats')).pollCalls, stopped);
  });

  await t.test('an unsettled timed-out commit cannot starve automatic synchronization in another active room', async t => {
    const f = await fixture(t, { options: { limits: { operationTimeoutMs: 350 } }, extraRooms: ['second'] });
    const stalled = await peer(t, f.a), healthy = await peer(t, f.a, { room: 'second', token: 'view' });
    const remote = await peer(t, f.b, { room: 'second', token: 'edit-b' });
    await f.a.command('hold-commit');
    stalled.send(1, edit(f.base.state, 1701, doc => doc.getText('content').insert(0, 'Uncertain ')));
    await until(async () => (await f.a.command('stats')).heldCommits === 1, 'real commit reply held');
    assert.equal((await stalled.waitClosed()).code, 1011); assert.equal(stalled.controls.filter(value => value.type === 'ack').length, 0);
    const blocked = await f.a.command('stats'); assert.equal(blocked.heldCommits, 1); assert.ok(blocked.pendingOperations >= 1);
    assert.equal((await f.store.get('tenant-a', 'live')).revision, 2, 'The held reply follows a durable PostgreSQL commit');
    remote.send(1, edit(remote.states[0].state, 1702, doc => doc.getText('content').insert(0, 'Healthy '))); await remote.ack(1);
    await healthy.waitRevision(2);
    assert.equal(healthy.closed, null); assert.equal(healthy.doc.getText('content').toString(), 'Healthy Base content');
    assert.equal((await f.a.command('stats')).heldCommits, 1, 'Healthy room must converge before the uncertain room settles');
    await f.a.command('release-commits'); await until(async () => (await f.a.command('stats')).heldCommits === 0, 'late commit reply cleanup');
    assert.equal(stalled.controls.filter(value => value.type === 'ack').length, 0); assertMonotonic(healthy);
  });
});
