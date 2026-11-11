// SQL contract tests with a scripted Pool. These do NOT prove PostgreSQL behavior.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PostgresDocumentStore, initializePostgresSchema } from '../src/postgres-store.mjs';
import { StoreError } from '../src/memory-store.mjs';

const state = { schema_version: 1, max_documents_per_tenant: 100, max_documents: 1000, max_bytes: '16777216', document_count: '0', byte_count: '0' };
const input = { id: 'doc', title: 'Title', content: 'Text' };
const row = {
  id: input.id, title_json: Buffer.from(JSON.stringify(input.title)), content_json: Buffer.from(JSON.stringify(input.content)),
  revision: '1', created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date('2026-01-01T00:00:00Z')
};
function scripted(steps) {
  const calls = [];
  const releases = [];
  return {
    calls, releases,
    pool: { async connect() {
      return { async query(sql, values) {
        calls.push({ sql, values });
        const step = steps.shift();
        assert.ok(step, `Unexpected query: ${sql}`);
        if (step.match) assert.match(sql, step.match);
        if (step.values) assert.deepEqual(values, step.values);
        if (step.error) throw step.error;
        return { rows: step.rows ?? [] };
      }, release(error) { releases.push(error); } };
    } },
    done() { assert.equal(steps.length, 0, 'All expected queries ran'); assert.equal(releases.length, 1); }
  };
}
function rejection(code) { return e => e instanceof StoreError && e.code === code && e.message === code && e.cause === undefined; }
function store(pool) { return new PostgresDocumentStore({ pool, schema: 'opendoc_test' }); }

// @spec OD-PG-001
test('construction never connects or migrates; schemas and pool are explicit', async () => {
  const pool = { connect() { assert.fail('No startup queries'); } };
  assert.equal(store(pool).kind, 'postgresql');
  for (const schema of [undefined, 'public', 'pg_catalog', 'information_schema', 'a"; DROP SCHEMA public', 'a.b', 'a'.repeat(64)]) {
    assert.throws(() => new PostgresDocumentStore({ pool, schema }), TypeError);
  }
  assert.throws(() => new PostgresDocumentStore({ pool: {}, schema: 'opendoc' }), TypeError);
  await assert.rejects(initializePostgresSchema({ pool, schema: 'opendoc', maxDocumentsPerTenant: 10001 }), TypeError);
});

// @spec OD-PG-001, OD-PG-003
test('fresh schema bootstrap is explicit, versioned, transactional, and refuses existing schemas', async () => {
  const db = scripted([
    { match: /^BEGIN/ }, { match: /CREATE SCHEMA "opendoc_test";/ },
    { match: /INSERT INTO "opendoc_test".store_state/, values: [1, 2, 3, 1024] }, { match: /^COMMIT$/ }
  ]);
  assert.deepEqual(await initializePostgresSchema({ pool: db.pool, schema: 'opendoc_test', maxDocumentsPerTenant: 2, maxDocuments: 3, maxBytes: 1024 }), { schemaVersion: 1 });
  db.done();
  assert.doesNotMatch(db.calls[1].sql, /CREATE SCHEMA IF NOT EXISTS/);
  const failed = scripted([{ match: /^BEGIN/ }, { error: Object.assign(new Error('secret URL'), { code: '42P06' }) }, { match: /^ROLLBACK$/ }]);
  await assert.rejects(initializePostgresSchema({ pool: failed.pool, schema: 'opendoc_test' }), rejection('DEPENDENCY_UNAVAILABLE'));
  failed.done();
});

// @spec OD-PG-002, OD-PG-006
test('list is tenant-scoped, deterministic, bounded, and never silently truncated', async () => {
  const db = scripted([{ rows: [state] }, { match: /WHERE tenant_id = \$1 ORDER BY id COLLATE "C" LIMIT \$2/, values: ['team.a', 101], rows: [row] }]);
  const result = await store(db.pool).list('team.a');
  assert.equal(result[0].title, 'Title');
  assert.equal('content' in result[0], false);
  assert.ok(!db.calls[1].sql.includes('content_json'));
  db.done();
  const over = scripted([{ rows: [{ ...state, max_documents_per_tenant: 1 }] }, { rows: [row, row] }]);
  await assert.rejects(store(over.pool).list('a'), rejection('CAPACITY_EXCEEDED'));
  over.done();
});

// @spec OD-PG-002, OD-PG-005
test('get parameterizes both IDs and preserves opaque strings including NUL and lone surrogates', async () => {
  const content = '"\u0000\ud800\r\n<script>not executed</script>🌿';
  const db = scripted([{ rows: [state] }, { match: /WHERE tenant_id = \$1 AND id = \$2/, values: ['a', 'doc'], rows: [{ ...row, content_json: Buffer.from(JSON.stringify(content)) }] }]);
  assert.equal((await store(db.pool).get('a', 'doc')).content, content);
  db.done();
  const absent = scripted([{ rows: [state] }, { rows: [] }]);
  assert.equal(await store(absent.pool).get('b', 'doc'), null);
  absent.done();
});

// @spec OD-PG-003, OD-PG-004
test('create locks global quotas and updates counters in the same transaction', async () => {
  const db = scripted([
    { match: /^BEGIN/ }, { match: /store_state .*WHERE singleton = true FOR UPDATE/s, rows: [state] },
    { match: /WHERE tenant_id = \$1 AND id = \$2/, values: ['a', 'doc'] },
    { match: /count\(\*\).*WHERE tenant_id = \$1/, values: ['a'], rows: [{ count: '0' }] },
    { match: /INSERT INTO .*documents/, values: ['a', 'doc', row.title_json, row.content_json, 12], rows: [row] },
    { match: /document_count = document_count \+ 1/, values: [12] }, { match: /^COMMIT$/ }
  ]);
  const value = { ...input };
  const pending = store(db.pool).create('a', value);
  value.content = 'mutated by caller';
  assert.equal((await pending).content, 'Text');
  db.done();
});

// @spec OD-PG-003, OD-PG-004
test('replace CAS and byte delta are tenant-scoped and commit together', async () => {
  const db = scripted([
    { match: /^BEGIN/ }, { match: /FOR UPDATE/, rows: [{ ...state, document_count: '1', byte_count: '12' }] },
    { match: /WHERE tenant_id = \$1 AND id = \$2 FOR UPDATE/, values: ['a', 'doc'], rows: [{ revision: '1', logical_bytes: '12' }] },
    { match: /WHERE tenant_id = \$1 AND id = \$2 AND revision = \$3 RETURNING/, values: ['a', 'doc', 1, Buffer.from('"T"'), Buffer.from('"X"'), 5], rows: [{ ...row, revision: '2', title_json: Buffer.from('"T"'), content_json: Buffer.from('"X"') }] },
    { match: /byte_count = byte_count \+ \$1/, values: [-7] }, { match: /^COMMIT$/ }
  ]);
  assert.equal((await store(db.pool).replace('a', 'doc', 1, { title: 'T', content: 'X' })).revision, 2);
  db.done();
});

// @spec OD-PG-003, OD-PG-004
test('duplicate, missing, stale and full writes roll back without changing counters', async () => {
  for (const [method, steps, code] of [
    ['create', [{ rows: [row] }], 'CONFLICT'],
    ['create', [{ rows: [] }, { rows: [{ count: '100' }] }], 'CAPACITY_EXCEEDED'],
    ['replace', [{ rows: [] }], 'NOT_FOUND'],
    ['replace', [{ rows: [{ revision: '2', logical_bytes: '12' }] }], 'PRECONDITION_FAILED']
  ]) {
    const db = scripted([{ match: /^BEGIN/ }, { rows: [state] }, ...steps, { match: /^ROLLBACK$/ }]);
    const op = method === 'create' ? store(db.pool).create('a', input) : store(db.pool).replace('a', 'doc', 1, { title: 'T', content: 'X' });
    await assert.rejects(op, rejection(code));
    db.done();
  }
});

// @spec OD-PG-001, OD-PG-007
test('unsupported or missing schema state and raw driver errors fail closed', async () => {
  for (const rows of [[], [{ ...state, schema_version: 2 }], [{ ...state, max_documents_per_tenant: 10001 }]]) {
    const db = scripted([{ rows }]);
    await assert.rejects(store(db.pool).get('a', 'doc'), rejection('DEPENDENCY_UNAVAILABLE'));
    db.done();
  }
  const db = scripted([{ error: new Error('credential-and-document-content') }]);
  await assert.rejects(store(db.pool).list('a'), rejection('DEPENDENCY_UNAVAILABLE'));
  db.done();
  await assert.rejects(store({ async connect() { throw new Error('connection password'); } }).list('a'), rejection('DEPENDENCY_UNAVAILABLE'));
});

// @spec OD-PG-003, OD-PG-007
test('failed commit is not retried; failed rollback destroys the connection', async () => {
  const db = scripted([
    { match: /^BEGIN/ }, { rows: [state] }, { rows: [] }, { rows: [{ count: '0' }] }, { rows: [row] }, { rows: [] },
    { match: /^COMMIT$/, error: new Error('connection lost') }, { match: /^ROLLBACK$/, error: new Error('still lost') }
  ]);
  await assert.rejects(store(db.pool).create('a', input), rejection('DEPENDENCY_UNAVAILABLE'));
  db.done();
  assert.deepEqual(db.releases, [true]);
});

// @spec OD-PG-003, OD-PG-007
test('a rejected BEGIN may already be open on the server and is rolled back or discarded', async () => {
  for (const rollbackFails of [false, true]) {
    let serverTransactionOpen = false;
    let destroyed = false;
    const queries = [];
    const pool = { async connect() {
      return {
        async query(sql) {
          queries.push(sql);
          if (sql.startsWith('BEGIN')) {
            serverTransactionOpen = true;
            throw new Error('Query read timeout after BEGIN reached PostgreSQL');
          }
          assert.equal(sql, 'ROLLBACK');
          if (rollbackFails) throw new Error('Rollback also timed out');
          serverTransactionOpen = false;
          return { rows: [] };
        },
        release(discard) {
          destroyed = discard;
          assert.ok(!serverTransactionOpen || discard, 'Never return an open transaction to the pool');
        }
      };
    } };
    await assert.rejects(store(pool).create('a', input), rejection('DEPENDENCY_UNAVAILABLE'));
    assert.deepEqual(queries, ['BEGIN ISOLATION LEVEL READ COMMITTED', 'ROLLBACK']);
    assert.equal(destroyed, rollbackFails);
  }
});

// @spec OD-PG-002, OD-PG-007
test('invalid direct-port inputs are rejected before connecting', async () => {
  const db = store({ async connect() { assert.fail('Unexpected connection'); } });
  await assert.rejects(db.get("a' OR true --", 'doc'), rejection('BAD_REQUEST'));
  await assert.rejects(db.get('a', undefined), rejection('BAD_REQUEST'));
  await assert.rejects(db.create('a', { ...input, tenantId: 'b' }), rejection('BAD_REQUEST'));
  await assert.rejects(db.create('a', { ...input, content: 'x'.repeat(1024 * 1024 + 1) }), rejection('TOO_LARGE'));
  await assert.rejects(db.replace('a', 'doc', 0, { title: '', content: '' }), rejection('PRECONDITION_FAILED'));
});
