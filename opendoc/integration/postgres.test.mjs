// Real PostgreSQL integration tests. No network connection without explicit opt-in.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { PostgresDocumentStore, initializePostgresSchema } from '../src/postgres-store.mjs';
import { createOpenDocHandler } from '../src/api.mjs';
import { StoreError } from '../src/memory-store.mjs';

function testTarget(raw) {
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
    ssl: false, options: '-c search_path=pg_catalog', application_name: 'opendoc-synthetic-integration',
    max: 1, connectionTimeoutMillis: 3000, query_timeout: 10000, statement_timeout: 8000, idle_in_transaction_session_timeout: 8000
  };
}
function rejects(code) { return error => error instanceof StoreError && error.code === code && error.message === code && error.cause === undefined; }
const input = { id: 'doc', title: 'Synthetic', content: 'Synthetic text only.' };

test('integration harness refuses remote, non-test, ambient, and option-bearing targets before connecting', () => {
  for (const value of [undefined, '', 'postgres://prod.example.test/opendoc_test',
    'postgres://opendoc_test:synthetic-test-only@127.0.0.1/production',
    'postgres://opendoc_test:synthetic-test-only@127.0.0.1/opendoc_test?host=prod.example.test',
    'postgres://opendoc_test:synthetic-test-only@127.0.0.1/opendoc_test#ignored',
    'postgres://postgres:real-secret@127.0.0.1/opendoc_test']) {
    assert.throws(() => testTarget(value));
  }
  assert.equal(testTarget('postgres://opendoc_test:synthetic-test-only@127.0.0.1:55432/opendoc_test').port, 55432);
});

test('real PostgreSQL: isolation, persistence, concurrency, quotas and schema safety', {
  skip: process.env.OPENDOC_PG_INTEGRATION !== '1' ? 'Set OPENDOC_PG_INTEGRATION=1 and a synthetic loopback DATABASE_URL to opt in' : false,
  timeout: 90000
}, async t => {
  const config = testTarget(process.env.DATABASE_URL);
  const { Pool } = await import('pg');
  const poolA = new Pool(config);
  const poolB = new Pool(config);
  const schemas = new Set();
  const schema = async (limits = {}) => {
    const name = `opendoc_test_${randomBytes(12).toString('hex')}`;
    await initializePostgresSchema({ pool: poolA, schema: name, ...limits });
    // Only schemas whose creation succeeded here are eligible for cleanup.
    schemas.add(name);
    return { name, a: new PostgresDocumentStore({ pool: poolA, schema: name }), b: new PostgresDocumentStore({ pool: poolB, schema: name }) };
  };
  t.after(async () => {
    try {
      for (const name of schemas) {
        // No CASCADE, database drop, broad cleanup pattern or external objects.
        await poolA.query(`DROP TABLE "${name}".documents; DROP TABLE "${name}".store_state; DROP SCHEMA "${name}";`);
      }
    } finally { await Promise.all([poolA.end(), poolB.end()]); }
  });
  const identity = await poolA.query('SELECT current_database() AS database, current_user AS username, host(inet_server_addr()) AS address, pg_backend_pid() AS pid');
  assert.equal(identity.rows[0].database, 'opendoc_test');
  assert.equal(identity.rows[0].username, 'opendoc_test');
  assert.ok(['127.0.0.1', '::1'].includes(identity.rows[0].address));
  const otherIdentity = await poolB.query('SELECT pg_backend_pid() AS pid');
  assert.notEqual(identity.rows[0].pid, otherIdentity.rows[0].pid, 'Independent server connections are required');

  // @spec OD-PG-002, OD-PG-005
  await t.test('opaque text and metadata survive connection-pool and Node-process restart', async () => {
    const { name, a, b } = await schema();
    const content = '\u0000\ud800\udfff\r\n# Synthetic 🌿\n<script>no execution</script>https://never-fetch.example.test';
    const original = { id: 'restart', title: 'Title\u0000\ud800', content };
    const created = await a.create('team.a', original);
    assert.equal(created.createdAt, created.updatedAt);
    assert.deepEqual(await b.get('team.a', original.id), created);
    const temporaryPool = new Pool(config);
    assert.deepEqual(await new PostgresDocumentStore({ pool: temporaryPool, schema: name }).get('team.a', original.id), created);
    await temporaryPool.end();
    const restartedPool = new Pool(config);
    try { assert.deepEqual(await new PostgresDocumentStore({ pool: restartedPool, schema: name }).get('team.a', original.id), created); }
    finally { await restartedPool.end(); }
    const code = `
      import { Pool } from 'pg';
      import { PostgresDocumentStore } from './src/postgres-store.mjs';
      const pool = new Pool(JSON.parse(process.env.OPENDOC_CHILD_CONFIG));
      try {
        const value = await new PostgresDocumentStore({ pool, schema: process.env.OPENDOC_CHILD_SCHEMA }).get('team.a', 'restart');
        process.stdout.write(JSON.stringify(value));
      } finally { await pool.end(); }
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], {
      cwd: new URL('..', import.meta.url), timeout: 15000,
      env: { ...process.env, OPENDOC_CHILD_CONFIG: JSON.stringify(config), OPENDOC_CHILD_SCHEMA: name }
    });
    assert.deepEqual(JSON.parse(stdout), created);
  });

  // @spec OD-PG-002, OD-PG-006
  await t.test('equal IDs in different tenants cannot leak reads, list entries or writes', async () => {
    const { a, b } = await schema();
    const first = await a.create('team-a', { ...input, content: 'A' });
    assert.equal(await b.get('team-b', input.id), null);
    assert.deepEqual(await b.list('team-b'), []);
    await assert.rejects(b.replace('team-b', input.id, 1, { title: 'B', content: 'B' }), rejects('NOT_FOUND'));
    const second = await b.create('team-b', { ...input, content: 'B' });
    await b.replace('team-b', input.id, 1, { title: 'B2', content: 'B2' });
    assert.deepEqual(await a.get('team-a', input.id), first);
    assert.equal((await a.list('team-a')).length, 1);
    assert.equal('content' in (await a.list('team-a'))[0], false);
    assert.equal(second.revision, 1);
    await a.create('team-a', { ...input, id: 'aaa' });
    assert.deepEqual((await a.list('team-a')).map(d => d.id), ['aaa', 'doc']);
  });

  // @spec OD-PG-003
  await t.test('concurrent creates and exact-revision replacements have exactly one winner', async () => {
    const { a, b } = await schema();
    const creates = await Promise.allSettled([a.create('a', input), b.create('a', input)]);
    assert.equal(creates.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(creates.find(r => r.status === 'rejected').reason.code, 'CONFLICT');
    for (let revision = 1; revision <= 12; revision++) {
      const results = await Promise.allSettled([
        a.replace('a', 'doc', revision, { title: 'One', content: `One-${revision}` }),
        b.replace('a', 'doc', revision, { title: 'Two', content: `Two-${revision}` })
      ]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(results.find(r => r.status === 'rejected').reason.code, 'PRECONDITION_FAILED');
      assert.equal((await a.get('a', 'doc')).revision, revision + 1);
    }
    await assert.rejects(b.replace('a', 'doc', 1, { title: 'Stale', content: 'Stale' }), rejects('PRECONDITION_FAILED'));
    assert.equal((await a.get('a', 'doc')).revision, 13);
  });

  // @spec OD-PG-004
  await t.test('two pools cannot oversubscribe global or per-tenant document limits', async () => {
    const global = await schema({ maxDocumentsPerTenant: 10, maxDocuments: 3 });
    const attempts = await Promise.allSettled(Array.from({ length: 16 }, (_, i) =>
      (i % 2 ? global.a : global.b).create(`tenant-${i}`, { ...input, id: `doc-${i}` })));
    assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 3);
    assert.ok(attempts.filter(r => r.status === 'rejected').every(r => r.reason.code === 'CAPACITY_EXCEEDED'));
    const count = await poolA.query(`SELECT document_count FROM "${global.name}".store_state`);
    assert.equal(Number(count.rows[0].document_count), 3);
    const tenant = await schema({ maxDocumentsPerTenant: 2, maxDocuments: 100 });
    const perTenant = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
      (i % 2 ? tenant.a : tenant.b).create('same-tenant', { ...input, id: `doc-${i}` })));
    assert.equal(perTenant.filter(r => r.status === 'fulfilled').length, 2);
    assert.equal((await tenant.a.list('same-tenant')).length, 2);
    assert.ok(perTenant.filter(r => r.status === 'rejected').every(r => r.reason.code === 'CAPACITY_EXCEEDED'));
    await tenant.b.create('other-tenant', input);
  });

  // @spec OD-PG-004
  await t.test('global byte budget and replacement deltas are atomic and rollback safely', async () => {
    const { name, a, b } = await schema({ maxBytes: 12 });
    // id(1) + title(1) + content(4) = six logical UTF-8 bytes per document.
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      (i % 2 ? a : b).create('a', { id: String(i), title: 'T', content: 'text' })));
    const created = outcomes.filter(r => r.status === 'fulfilled').map(r => r.value);
    assert.equal(created.length, 2);
    const first = created[0];
    await assert.rejects(a.replace('a', first.id, 1, { title: 'T', content: 'larger' }), rejects('CAPACITY_EXCEEDED'));
    assert.deepEqual(await b.get('a', first.id), first);
    const shrunk = await a.replace('a', first.id, 1, { title: '', content: '' });
    assert.equal(shrunk.revision, 2);
    await b.create('b', { id: 'n', title: '', content: 'four' });
    const { rows } = await poolA.query(`SELECT s.byte_count, sum(d.logical_bytes) AS actual FROM "${name}".store_state s CROSS JOIN "${name}".documents d GROUP BY s.byte_count`);
    assert.equal(rows[0].byte_count, '12');
    assert.equal(rows[0].actual, '12');
  });

  // @spec OD-PG-001, OD-PG-006, OD-PG-007
  await t.test('missing/future schemas fail closed, bootstrap never overwrites, overflow is explicit', async () => {
    const { name, a } = await schema({ maxDocumentsPerTenant: 2 });
    const created = await a.create('a', input);
    await assert.rejects(initializePostgresSchema({ pool: poolA, schema: name }), rejects('DEPENDENCY_UNAVAILABLE'));
    assert.deepEqual(await a.get('a', input.id), created);
    const missing = new PostgresDocumentStore({ pool: poolA, schema: `opendoc_absent_${randomBytes(8).toString('hex')}` });
    await assert.rejects(missing.list('a'), rejects('DEPENDENCY_UNAVAILABLE'));
    await poolA.query(`UPDATE "${name}".store_state SET schema_version = 2`);
    await assert.rejects(a.list('a'), rejects('DEPENDENCY_UNAVAILABLE'));
    await assert.rejects(a.create('a', { ...input, id: 'other' }), rejects('DEPENDENCY_UNAVAILABLE'));
    await poolA.query(`UPDATE "${name}".store_state SET schema_version = 1`);
    await a.create('a', { ...input, id: 'other' });
    // Simulate an administrator lowering a bound, never silently omit documents.
    await poolA.query(`UPDATE "${name}".store_state SET max_documents_per_tenant = 1`);
    await assert.rejects(a.list('a'), rejects('CAPACITY_EXCEEDED'));
    await poolA.query(`UPDATE "${name}".documents SET revision = $1 WHERE tenant_id = $2 AND id = $3`, [String(Number.MAX_SAFE_INTEGER), 'a', 'doc']);
    await assert.rejects(a.replace('a', 'doc', Number.MAX_SAFE_INTEGER, { title: 'X', content: 'X' }), rejects('CAPACITY_EXCEEDED'));
  });

  // @spec OD-PG-002, OD-PG-003, OD-PG-007
  await t.test('standard HTTP API uses durable store isolation, revisions and sanitized failures', async () => {
    const { name, a } = await schema();
    const handle = createOpenDocHandler({ store: a, authenticate: async req => ({ principalId: 'synthetic', tenantId: req.headers.get('authorization') === 'Bearer b' ? 'b' : 'a', role: 'editor' }) });
    const request = (path, init) => handle(new Request(`http://localhost${path}`, init));
    const created = await request('/api/v1/documents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('etag'), '"1"');
    assert.equal((await request('/api/v1/documents/doc', { headers: { authorization: 'Bearer b' } })).status, 404);
    const update = { method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': '"1"' }, body: JSON.stringify({ title: 'New', content: 'New' }) };
    assert.equal((await request('/api/v1/documents/doc', update)).status, 200);
    assert.equal((await request('/api/v1/documents/doc', update)).status, 412);
    await poolA.query(`UPDATE "${name}".store_state SET schema_version = 99`);
    const failed = await request('/api/v1/documents');
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Service dependency unavailable.' } });
  });
});
