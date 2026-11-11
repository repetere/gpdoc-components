// Independent history-guard failure-boundary tests. Scripted SQL is not an
// isolation proof; real PostgreSQL races live in the integration suite.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import workerThreads from 'node:worker_threads';
import { StoreError } from '../src/memory-store.mjs';
import { MemoryLiveDocumentStore, PostgresLiveDocumentStore } from '../src/live-document-store.mjs';

const authorityId = '5267eed6-f2b1-4d18-977f-f4ff05dbf83a';
const tenant = 'tenant-a', id = 'live';
const base = await new MemoryLiveDocumentStore().create(tenant, { id, title: 'Title', content: 'Body\u0000🪴' });
const row = { tenant_id: tenant, document_id: id, revision: String(base.revision), state: Buffer.from(base.state),
  title_json: Buffer.from(JSON.stringify(base.title)), content_json: Buffer.from(JSON.stringify(base.content)),
  created_at: base.createdAt, updated_at: base.updatedAt };
row.logical_bytes = String(row.state.length + tenant.length + id.length + row.title_json.length + row.content_json.length);
const caps = { schema_version: 2, authority_id: authorityId, quarantined: false, max_documents_per_tenant: 100,
  max_documents: 1000, max_bytes: '16777216', document_count: '1', byte_count: row.logical_bytes };
function digest(value) {
  const hash = createHash('sha256').update(Buffer.from('opendoc-live-checkpoint-v1\0'));
  const add = value => { const bytes = Buffer.from(value), length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); hash.update(length).update(bytes); };
  add(value.tenant_id); add(value.document_id);
  const revision = Buffer.alloc(8); revision.writeBigUInt64BE(BigInt(value.revision)); hash.update(revision);
  for (const valueBytes of [value.state, value.title_json, value.content_json]) add(valueBytes);
  return hash.digest();
}
const checkpoint = { tenant_id: tenant, document_id: id, revision: row.revision, digest: digest(row) };
const metadataRow = { ...row, actual_digest: digest(row) };
const rejects = code => error => error instanceof StoreError && error.code === code && error.message === code && error.cause === undefined;
const begin = { match: /^BEGIN ISOLATION LEVEL READ COMMITTED$/ };
const state = value => ({ match: /FROM "security_live"\.live_document_state WHERE singleton = true FOR UPDATE$/, rows: value });
const canonical = rows => ({ match: /FROM "security_live"\.live_documents WHERE tenant_id = \$1 AND document_id = \$2$/, values: [tenant, id], rows });
const history = rows => ({ match: /FROM "security_live"\.live_document_checkpoints WHERE tenant_id = \$1 AND document_id = \$2$/, values: [tenant, id], rows });
const quarantine = { match: /^UPDATE "security_live"\.live_document_state SET quarantined = true WHERE singleton = true RETURNING singleton$/, rows: [{ singleton: true }] };
const commit = { match: /^COMMIT$/ }, rollback = { match: /^ROLLBACK$/ };
function scripted(steps) {
  const calls = [], released = [];
  return { calls, released, pool: { async connect() { return { async query(sql, values) {
    calls.push({ sql, values }); const step = steps.shift(); assert.ok(step, `Unexpected SQL: ${sql}`);
    if (step.match) assert.match(sql, step.match);
    if (step.values) assert.deepEqual(values, step.values);
    if (step.error) throw step.error;
    return { rows: step.rows ?? [] };
  }, release(discard) { released.push(discard); } }; } }, done() { assert.equal(steps.length, 0); } };
}
const store = pool => new PostgresLiveDocumentStore({ pool, schema: 'security_live', historyGuard: { authorityId } });
function neverQuarantined(db) { assert.ok(!db.calls.some(({ sql }) => /SET quarantined/.test(sql))); }

test('guard rejects missing, wrong and malformed namespace control without poisoning a database', async () => {
  for (const rows of [[], [caps, caps], [{ ...caps, schema_version: 1 }], [{ ...caps, authority_id: undefined }],
    [{ ...caps, authority_id: '81327b6b-f591-4ac9-818c-949d83f6de9d' }], [{ ...caps, quarantined: undefined }],
    [{ ...caps, quarantined: null }], [{ ...caps, quarantined: 'false' }], [{ ...caps, quarantined: true }],
    [{ ...caps, document_count: '1001' }], [{ ...caps, byte_count: '-1' }]]) {
    const db = scripted([begin, state(rows), rollback]);
    await assert.rejects(store(db.pool).get(tenant, id), rejects('DEPENDENCY_UNAVAILABLE'));
    neverQuarantined(db); db.done();
  }
  const db = scripted([begin, { rows: [caps] }, rollback]);
  const unguarded = new PostgresLiveDocumentStore({ pool: db.pool, schema: 'security_live' });
  await assert.rejects(unguarded.get(tenant, id), rejects('DEPENDENCY_UNAVAILABLE')); neverQuarantined(db); db.done();
});

test('strict history option never evaluates accessors or silently enables a partial pin', () => {
  const pool = { connect() { assert.fail('Configuration validation must remain inert'); } };
  let getters = 0;
  const accessor = {}; Object.defineProperty(accessor, 'authorityId', { get() { getters++; return authorityId; }, enumerable: true });
  const hidden = { authorityId }; Object.defineProperty(hidden, 'extra', { value: true });
  for (const historyGuard of [null, false, [], {}, Object.create({ authorityId }), Object.assign(Object.create(null), { authorityId }),
    accessor, hidden, { authorityId, [Symbol('extra')]: true }, { authorityId: authorityId.toUpperCase() },
    { authorityId: `${authorityId}\n` }, { authorityId: `${authorityId}0` }, { authorityId: null }]) {
    assert.throws(() => new PostgresLiveDocumentStore({ pool, schema: 'security_live', historyGuard }), TypeError);
  }
  assert.equal(getters, 0);
});

test('an unproven caller revision floor fails closed without permanent quarantine', async () => {
  const db = scripted([begin, state([caps]), canonical([metadataRow]), history([checkpoint]), rollback]);
  await assert.rejects(store(db.pool).getIfChanged(tenant, id, base.revision + 1), rejects('DEPENDENCY_UNAVAILABLE'));
  neverQuarantined(db); db.done();
  const healthy = scripted([begin, state([caps]), canonical([metadataRow]), history([checkpoint]), commit]);
  assert.equal(await store(healthy.pool).getIfChanged(tenant, id, base.revision), null); healthy.done();
  assert.match(healthy.calls[2].sql, /sha256\(.*int8send\(revision\).*content_json/s);
  assert.ok(!/^SELECT \*/.test(healthy.calls[2].sql), 'Unchanged polling must not fetch state bytes for decoding');
});

test('missing one side of durable history commits quarantine instead of adopting or recreating it', async () => {
  for (const [rows, checkpoints] of [[[row], []], [[], [checkpoint]], [[row], [{ ...checkpoint, revision: '2' }]]]) {
    const db = scripted([begin, state([caps]), canonical(rows), history(checkpoints), quarantine, commit]);
    await assert.rejects(store(db.pool).get(tenant, id), rejects('DEPENDENCY_UNAVAILABLE')); db.done();
    assert.equal(db.calls.at(-1).sql, 'COMMIT');
    assert.ok(!db.calls.some(({ sql }) => /^INSERT|^DELETE|^UPDATE .*live_documents\b/.test(sql)));
  }
  const fresh = scripted([begin, state([caps]), canonical([]), history([]), commit]);
  assert.equal(await store(fresh.pool).get(tenant, id), null); fresh.done();
  const latched = scripted([begin, state([{ ...caps, quarantined: true }]), rollback]);
  await assert.rejects(store(latched.pool).get('another-tenant', 'another-document'), rejects('DEPENDENCY_UNAVAILABLE'));
  neverQuarantined(latched); latched.done();
});

test('equal-revision changed digest quarantines even on unchanged polling', async () => {
  const db = scripted([begin, state([caps]), canonical([{ ...metadataRow, actual_digest: Buffer.alloc(32) }]),
    history([checkpoint]), quarantine, commit]);
  await assert.rejects(store(db.pool).getIfChanged(tenant, id, base.revision), rejects('DEPENDENCY_UNAVAILABLE')); db.done();
});

test('invalid input and unclassified worker errors never poison; deterministic stored projection errors quarantine', async () => {
  const invalid = new Uint8Array([255, 255]);
  const incoming = scripted([begin, state([caps]), canonical([row]), history([checkpoint]), rollback]);
  await assert.rejects(store(incoming.pool).applyUpdate(tenant, id, invalid), rejects('BAD_REQUEST'));
  neverQuarantined(incoming); incoming.done();
  const corruptRow = { ...row, state: Buffer.from(invalid) };
  // The existing worker deliberately flattens previous-state parse failures
  // into DEPENDENCY_UNAVAILABLE. That code alone must never poison history.
  const unclassified = scripted([begin, state([caps]), canonical([corruptRow]), history([{ ...checkpoint, digest: digest(corruptRow) }]), rollback]);
  await assert.rejects(store(unclassified.pool).get(tenant, id), rejects('DEPENDENCY_UNAVAILABLE'));
  neverQuarantined(unclassified); unclassified.done();
  const badProjection = { ...row, title_json: Buffer.from('123') };
  const persisted = scripted([begin, state([caps]), canonical([badProjection]), history([{ ...checkpoint, digest: digest(badProjection) }]), quarantine, commit]);
  await assert.rejects(store(persisted.pool).get(tenant, id), rejects('DEPENDENCY_UNAVAILABLE')); persisted.done();
});

test('uncertain quarantine commit is not retried and rollback failure discards the client', async () => {
  for (const failedCleanup of [false, true]) {
    const db = scripted([begin, state([caps]), canonical([row]), history([]), quarantine,
      { ...commit, error: new Error('private lost COMMIT details') },
      { ...rollback, ...(failedCleanup ? { error: new Error('private rollback details') } : {}) }]);
    await assert.rejects(store(db.pool).get(tenant, id), rejects('DEPENDENCY_UNAVAILABLE')); db.done();
    assert.equal(db.calls.filter(({ sql }) => sql === 'COMMIT').length, 1);
    assert.deepEqual(db.released, [failedCleanup]);
  }
});

test('malformed newly generated output rolls back without alleging corrupt durable history', async () => {
  const generatedTitle = 'Independent generated-output boundary';
  const db = scripted([begin, state([{ ...caps, document_count: '0', byte_count: '0' }]), canonical([]), history([]),
    { match: /^SELECT count\(\*\) AS count FROM "security_live"\.live_document_checkpoints$/, rows: [{ count: '0' }] },
    { match: /^SELECT count\(\*\) AS count FROM "security_live"\.live_documents WHERE tenant_id = \$1$/, rows: [{ count: '0' }] }, rollback]);
  const originalFrom = Buffer.from;
  try {
    // A deliberately narrow local serializer fault, after valid worker output.
    // It creates no stored corruption and must never latch namespace quarantine.
    Buffer.from = function (value, ...args) {
      return value === JSON.stringify(generatedTitle) ? Buffer.alloc(1203) : Reflect.apply(originalFrom, Buffer, [value, ...args]);
    };
    await assert.rejects(store(db.pool).create(tenant, { id, title: generatedTitle, content: '' }), rejects('DEPENDENCY_UNAVAILABLE'));
  } finally { Buffer.from = originalFrom; }
  neverQuarantined(db); db.done();
  assert.ok(!db.calls.some(({ sql }) => /^INSERT|^UPDATE|^DELETE/.test(sql)));
});

test('worker OOM TOO_LARGE is transient rejection, never durable corruption', async () => {
  const OriginalWorker = workerThreads.Worker;
  class OomWorker extends EventEmitter {
    stdout = { resume() {} }; stderr = { resume() {} };
    constructor() { super(); queueMicrotask(() => this.emit('error', Object.assign(new Error('synthetic worker failure'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }))); }
    async terminate() { return 0; }
  }
  const db = scripted([begin, state([caps]), canonical([row]), history([checkpoint]), rollback]);
  try {
    workerThreads.Worker = OomWorker; syncBuiltinESMExports();
    await assert.rejects(store(db.pool).get(tenant, id), rejects('TOO_LARGE'));
  } finally { workerThreads.Worker = OriginalWorker; syncBuiltinESMExports(); }
  neverQuarantined(db); db.done();
  const recovered = scripted([begin, state([caps]), canonical([row]), history([checkpoint]), commit]);
  assert.deepEqual(await store(recovered.pool).get(tenant, id), base); recovered.done();
});
