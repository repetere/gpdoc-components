// Scripted SQL contract tests, not evidence of real PostgreSQL behavior.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { StoreError } from '../src/memory-store.mjs';
import { MAX_COLLABORATION_UPDATE_BYTES } from '../src/collaboration-state.mjs';
import { PostgresCollaborationStore, initializePostgresCollaborationSchema } from '../src/collaboration-store.mjs';

const state = { schema_version: 1, max_rooms_per_tenant: 100, max_rooms: 1000, max_bytes: '16777216', room_count: '0', byte_count: '0' };
const doc = new Y.Doc(); doc.clientID = 1; doc.getText('body').insert(0, 'Synthetic');
const update = Y.encodeStateAsUpdate(doc); doc.destroy();
const bytes = update.length + 'a'.length + 'room'.length;
const row = { state: Buffer.from(update), revision: '1', logical_bytes: String(bytes) };
const populated = { ...state, room_count: '1', byte_count: String(bytes) };
function rejects(code) { return e => e instanceof StoreError && e.code === code && e.message === code && e.cause === undefined; }
function store(pool) { return new PostgresCollaborationStore({ pool, schema: 'opendoc_collaboration_test' }); }
function scripted(steps) {
  const calls = [], releases = [];
  return { calls, releases, pool: { async connect() {
    return { async query(sql, values) {
      calls.push({ sql, values });
      const step = steps.shift();
      assert.ok(step, `Unexpected query: ${sql}`);
      if (step.match) assert.match(sql, step.match);
      if (step.values) assert.deepEqual(values, step.values);
      if (step.error) throw step.error;
      return { rows: step.rows ?? [] };
    }, release(discard) { releases.push(discard); } };
  } }, done() { assert.equal(steps.length, 0); assert.equal(releases.length, 1); } };
}

// @spec OD-COLLAB-005
test('construction is inert and explicit collaboration bootstrap refuses unsafe namespaces and invalid limits', async () => {
  const pool = { async connect() { assert.fail('No implicit connection'); } };
  assert.equal(store(pool).kind, 'postgresql-collaboration');
  for (const schema of [undefined, 'public', 'pg_catalog', 'information_schema', 'x.y', 'a"; DROP TABLE x', 'a'.repeat(64)]) {
    assert.throws(() => new PostgresCollaborationStore({ pool, schema }), TypeError);
  }
  assert.throws(() => new PostgresCollaborationStore({ pool: {}, schema: 'opendoc_collaboration' }), TypeError);
  for (const caps of [{ maxRooms: 0 }, { maxRooms: 1000001 }, { maxRoomsPerTenant: 10001 }, { maxBytes: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(initializePostgresCollaborationSchema({ pool, schema: 'opendoc_collaboration', ...caps }), TypeError);
  }
  const db = scripted([
    { match: /^BEGIN/ }, { match: /CREATE SCHEMA "opendoc_collaboration_test";/ },
    { match: /INSERT INTO .*collaboration_state/, values: [1, 2, 3, 1024] }, { match: /^COMMIT$/ }
  ]);
  assert.deepEqual(await initializePostgresCollaborationSchema({ pool: db.pool, schema: 'opendoc_collaboration_test', maxRoomsPerTenant: 2, maxRooms: 3, maxBytes: 1024 }), { schemaVersion: 1 });
  assert.doesNotMatch(db.calls[1].sql, /IF NOT EXISTS|DROP |\.documents/);
  db.done();
  const exists = scripted([{ match: /^BEGIN/ }, { error: new Error('secret schema') }, { match: /^ROLLBACK$/ }]);
  await assert.rejects(initializePostgresCollaborationSchema({ pool: exists.pool, schema: 'opendoc_collaboration_test' }), rejects('DEPENDENCY_UNAVAILABLE'));
  exists.done();
});

// @spec OD-COLLAB-003, OD-COLLAB-005
test('get holds a shared quota lock in its transaction, scopes and copies bytes, and creates no room', async () => {
  const db = scripted([
    { match: /^BEGIN ISOLATION LEVEL READ COMMITTED$/ }, { match: /collaboration_state .*FOR SHARE$/s, rows: [populated] },
    { match: /WHERE tenant_id = \$1 AND room_id = \$2/, values: ['a', 'room'], rows: [row] }, { match: /^COMMIT$/ }
  ]);
  const result = await store(db.pool).get('a', 'room');
  assert.deepEqual(result, { state: update, revision: 1 });
  result.state.fill(0); assert.deepEqual(row.state, Buffer.from(update));
  db.done();
  const missing = scripted([
    { match: /^BEGIN ISOLATION LEVEL READ COMMITTED$/ }, { match: /FOR SHARE$/, rows: [state] },
    { values: ['other-tenant', 'room'] }, { match: /^COMMIT$/ }
  ]);
  assert.equal(await store(missing.pool).get('other-tenant', 'room'), null);
  missing.done();
  assert.ok(!missing.calls.some(call => /^INSERT|^UPDATE|^DELETE|^CREATE/.test(call.sql)));
});

// @spec OD-COLLAB-002, OD-COLLAB-005
test('first valid update locks quotas, stores bytes, updates counters and commits before returning', async () => {
  const db = scripted([
    { match: /^BEGIN/ }, { match: /collaboration_state .*FOR UPDATE/s, rows: [state] },
    { match: /WHERE tenant_id = \$1 AND room_id = \$2 FOR UPDATE/, values: ['a', 'room'] },
    { match: /count\(\*\).*WHERE tenant_id = \$1/, values: ['a'], rows: [{ count: '0' }] },
    { match: /INSERT INTO .*collaboration_rooms/, values: ['a', 'room', Buffer.from(update), bytes] },
    { match: /room_count = room_count \+ \$1/, values: [1, bytes] }, { match: /^COMMIT$/ }
  ]);
  const mutable = Uint8Array.from(update);
  const pending = store(db.pool).applyUpdate('a', 'room', mutable);
  mutable.fill(0);
  assert.deepEqual(await pending, { state: update, revision: 1 });
  db.done();
});

// @spec OD-COLLAB-002, OD-COLLAB-004
test('duplicate updates preserve revision and counters without rewriting the room', async () => {
  const db = scripted([{ match: /^BEGIN/ }, { rows: [populated] }, { rows: [row] }, { match: /^COMMIT$/ }]);
  assert.deepEqual(await store(db.pool).applyUpdate('a', 'room', update), { state: update, revision: 1 });
  db.done();
  assert.ok(!db.calls.some(call => /^INSERT|^UPDATE/.test(call.sql)));
});

// @spec OD-COLLAB-002, OD-COLLAB-004, OD-COLLAB-005
test('existing edits use tenant-scoped writes and atomic byte deltas', async () => {
  const editing = new Y.Doc(); editing.clientID = 2; Y.applyUpdate(editing, update);
  const vector = Y.encodeStateVector(editing); editing.getText('body').insert(9, '!');
  const delta = Y.encodeStateAsUpdate(editing, vector), merged = Y.encodeStateAsUpdate(editing);
  const total = merged.length + 5; editing.destroy();
  const db = scripted([
    { match: /^BEGIN/ }, { rows: [populated] }, { rows: [row] },
    { match: /UPDATE .*collaboration_rooms .*WHERE tenant_id = \$1 AND room_id = \$2/s, values: ['a', 'room', Buffer.from(merged), total] },
    { match: /UPDATE .*collaboration_state/, values: [0, total - bytes] }, { match: /^COMMIT$/ }
  ]);
  assert.deepEqual(await store(db.pool).applyUpdate('a', 'room', delta), { state: merged, revision: 2 });
  db.done();
});

// @spec OD-COLLAB-005, OD-COLLAB-006
test('invalid edits, first empty updates, full quotas and corrupt accounting roll back without any write', async () => {
  for (const [quotaState, current, value, next, code] of [
    [state, [], new Uint8Array([0, 0]), [], 'BAD_REQUEST'],
    [state, [], new Uint8Array([255, 255]), [], 'BAD_REQUEST'],
    [{ ...state, max_bytes: String(bytes - 1) }, [], update, [], 'CAPACITY_EXCEEDED'],
    [{ ...state, max_rooms: 1, room_count: '1' }, [], update, [{ rows: [{ count: '0' }] }], 'CAPACITY_EXCEEDED'],
    [{ ...state, max_rooms_per_tenant: 1 }, [], update, [{ rows: [{ count: '1' }] }], 'CAPACITY_EXCEEDED'],
    [populated, [{ ...row, logical_bytes: String(bytes + 1) }], update, [], 'DEPENDENCY_UNAVAILABLE']
  ]) {
    const db = scripted([{ match: /^BEGIN/ }, { rows: [quotaState] }, { rows: current }, ...next, { match: /^ROLLBACK$/ }]);
    await assert.rejects(store(db.pool).applyUpdate('a', 'room', value), rejects(code));
    assert.ok(!db.calls.some(call => /^INSERT|^UPDATE/.test(call.sql)));
    db.done();
  }
});

// @spec OD-COLLAB-005, OD-COLLAB-006
test('invalid IDs and update lengths fail before connecting; driver/schema errors fail closed', async () => {
  const noConnect = store({ async connect() { assert.fail('No connection expected'); } });
  await assert.rejects(noConnect.get('a', undefined), rejects('BAD_REQUEST'));
  await assert.rejects(noConnect.get("a' OR true --", 'room'), rejects('BAD_REQUEST'));
  await assert.rejects(noConnect.applyUpdate('a', 'room', null), rejects('BAD_REQUEST'));
  await assert.rejects(noConnect.applyUpdate('a', 'room', new Uint8Array(MAX_COLLABORATION_UPDATE_BYTES + 1)), rejects('TOO_LARGE'));
  for (const rows of [[], [{ ...state, schema_version: 2 }], [{ ...state, byte_count: '16777217' }]]) {
    const db = scripted([{ match: /^BEGIN/ }, { match: /FOR SHARE$/, rows }, { match: /^ROLLBACK$/ }]);
    await assert.rejects(store(db.pool).get('a', 'room'), rejects('DEPENDENCY_UNAVAILABLE')); db.done();
  }
  const db = scripted([{ match: /^BEGIN/ }, { match: /FOR SHARE$/, error: new Error('password and private document text') }, { match: /^ROLLBACK$/ }]);
  await assert.rejects(store(db.pool).get('a', 'room'), rejects('DEPENDENCY_UNAVAILABLE')); db.done();
  await assert.rejects(store({ async connect() { throw new Error('private database URL'); } }).get('a', 'room'), rejects('DEPENDENCY_UNAVAILABLE'));
});

// @spec OD-COLLAB-002, OD-COLLAB-006
test('uncertain BEGIN and COMMIT are never retried; failed cleanup discards pooled clients', async () => {
  for (const rollbackFails of [false, true]) {
    const begin = scripted([
      { match: /^BEGIN/, error: new Error('BEGIN reached server but response timed out') },
      { match: /^ROLLBACK$/, ...(rollbackFails ? { error: new Error('rollback failed') } : {}) }
    ]);
    await assert.rejects(store(begin.pool).applyUpdate('a', 'room', update), rejects('DEPENDENCY_UNAVAILABLE'));
    assert.deepEqual(begin.releases, [rollbackFails]); begin.done();
    const commit = scripted([
      { match: /^BEGIN/ }, { rows: [populated] }, { rows: [row] },
      { match: /^COMMIT$/, error: new Error('commit response lost') },
      { match: /^ROLLBACK$/, ...(rollbackFails ? { error: new Error('rollback failed') } : {}) }
    ]);
    await assert.rejects(store(commit.pool).applyUpdate('a', 'room', update), rejects('DEPENDENCY_UNAVAILABLE'));
    assert.deepEqual(commit.releases, [rollbackFails]); commit.done();
  }
});

// @spec OD-COLLAB-002, OD-COLLAB-004, OD-COLLAB-006
test('read transactions roll back uncertain lock and commit failures, discarding failed cleanup', async () => {
  for (const rollbackFails of [false, true]) {
    for (const failure of ['begin', 'lock', 'commit']) {
      const steps = [{ match: /^BEGIN/, ...(failure === 'begin' ? { error: new Error('begin reply lost') } : {}) }];
      if (failure !== 'begin') steps.push({ match: /FOR SHARE$/, ...(failure === 'lock' ? { error: new Error('lock reply lost') } : { rows: [populated] }) });
      if (failure === 'commit') steps.push({ rows: [row] }, { match: /^COMMIT$/, error: new Error('commit reply lost') });
      steps.push({ match: /^ROLLBACK$/, ...(rollbackFails ? { error: new Error('rollback failed') } : {}) });
      const db = scripted(steps);
      await assert.rejects(store(db.pool).get('a', 'room'), rejects('DEPENDENCY_UNAVAILABLE'));
      assert.deepEqual(db.releases, [rollbackFails]); db.done();
    }
  }
});
