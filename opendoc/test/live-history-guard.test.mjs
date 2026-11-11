// Original guarded-storage tests. Synthetic SQL scripts are not PostgreSQL proof.
// @spec OD-LIVE-GUARD-002 OD-LIVE-GUARD-003 OD-LIVE-GUARD-004
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as Y from 'yjs';
import { StoreError } from '../src/memory-store.mjs';
import { MemoryLiveDocumentStore, PostgresLiveDocumentStore, initializePostgresLiveDocumentSchema } from '../src/live-document-store.mjs';

const authorityId = '4d70654e-646f-4367-8000-000000000001';
const historyGuard = { authorityId };
const caps = { schema_version: 2, authority_id: authorityId, quarantined: false, max_documents_per_tenant: 100,
  max_documents: 1000, max_bytes: '16777216', document_count: '1', byte_count: '1000' };
const rejects = code => error => error instanceof StoreError && error.code === code && error.message === code && error.cause === undefined;
const guarded = pool => new PostgresLiveDocumentStore({ pool, schema: 'test_guarded_docs', historyGuard });
function script(steps) {
  const calls = [], releases = [];
  const pool = { async connect() { return { async query(sql, values) {
    calls.push({ sql, values }); const next = steps.shift(); assert.ok(next, `Unexpected SQL: ${sql}`);
    if (next.match) assert.match(sql, next.match); if (next.check) next.check(sql, values);
    if (next.error) throw next.error; return { rows: typeof next.rows === 'function' ? next.rows(sql, values) : next.rows ?? [] };
  }, release(discard) { releases.push(discard); } }; } };
  return { pool, calls, releases, done() { assert.equal(steps.length, 0); } };
}
function digest(row) {
  const hash = createHash('sha256').update(Buffer.from('opendoc-live-checkpoint-v1\0'));
  const add = bytes => { const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); hash.update(length).update(bytes); };
  add(Buffer.from(row.tenant_id)); add(Buffer.from(row.document_id));
  const revision = Buffer.alloc(8); revision.writeBigUInt64BE(BigInt(row.revision)); hash.update(revision);
  [row.state, row.title_json, row.content_json].forEach(add); return hash.digest();
}
async function fixture() {
  const doc = await new MemoryLiveDocumentStore().create('one', { id: 'live', title: 'Guarded', content: 'Original' });
  const row = { tenant_id: 'one', document_id: 'live', state: doc.state, title_json: Buffer.from(JSON.stringify(doc.title)),
    content_json: Buffer.from(JSON.stringify(doc.content)), revision: '1', created_at: doc.createdAt, updated_at: doc.updatedAt };
  row.logical_bytes = row.state.length + 3 + 4 + row.title_json.length + row.content_json.length;
  return { doc, row, checkpoint: { tenant_id: 'one', document_id: 'live', revision: '1', digest: digest(row) } };
}
const begin = () => ({ match: /^BEGIN/ });
const state = (row = caps) => ({ match: /authority_id, quarantined[\s\S]*FOR UPDATE$/, rows: [row] });
const pair = (row, checkpoint) => [{ match: /FROM .*\.live_documents WHERE/, rows: row ? [row] : [] },
  { match: /FROM .*\.live_document_checkpoints WHERE/, rows: checkpoint ? [checkpoint] : [] }];
const commit = () => ({ match: /^COMMIT$/ });
const rollback = () => ({ match: /^ROLLBACK$/ });
const quarantine = () => ({ match: /SET quarantined = true.*RETURNING singleton/, rows: [{ singleton: true }] });

test('guard configuration is inert, exact, and fresh bootstrap selects schema version 2', async () => {
  const pool = { async connect() { assert.fail('Configuration must not connect'); } };
  for (const option of [null, false, {}, { authorityId: '' }, { authorityId: authorityId.toUpperCase() }, { authorityId, extra: true },
    Object.create({ authorityId }), { get authorityId() { assert.fail('Accessor must not run'); } }]) {
    assert.throws(() => new PostgresLiveDocumentStore({ pool, schema: 'test_guarded_docs', historyGuard: option }), TypeError);
    await assert.rejects(initializePostgresLiveDocumentSchema({ pool, schema: 'test_guarded_docs', historyGuard: option }), TypeError);
  }
  assert.throws(() => new PostgresLiveDocumentStore({ pool, schema: 'same', accountSchema: 'same' }), TypeError);
  assert.throws(() => new PostgresLiveDocumentStore({ pool, schema: 'test_guarded_docs\n', historyGuard }), TypeError);
  const s = script([begin(), { match: /CREATE SCHEMA[\s\S]*ADD COLUMN authority_id[\s\S]*CREATE TABLE .*live_document_checkpoints/ },
    { match: /INSERT INTO .*authority_id/, check: (_, values) => assert.deepEqual(values, [2, 100, 1000, 16777216, authorityId]) }, commit()]);
  assert.deepEqual(await initializePostgresLiveDocumentSchema({ pool: s.pool, schema: 'test_guarded_docs', historyGuard }), { schemaVersion: 2, authorityId }); s.done();
});

test('missing or mismatched guard mode, pin, control row and quarantine fail without poisoning', async () => {
  for (const row of [{ ...caps, schema_version: 1 }, { ...caps, authority_id: '00000000-0000-0000-0000-000000000000' },
    { ...caps, quarantined: true }, { ...caps, quarantined: 'false' }, { ...caps, byte_count: 'invalid' }]) {
    const s = script([begin(), state(row), rollback()]); await assert.rejects(guarded(s.pool).get('one', 'live'), rejects('DEPENDENCY_UNAVAILABLE')); s.done();
  }
  const missing = script([begin(), { match: /FOR UPDATE$/, rows: [] }, rollback()]);
  await assert.rejects(guarded(missing.pool).get('one', 'live'), rejects('DEPENDENCY_UNAVAILABLE')); missing.done();
  const unconfigured = script([begin(), { match: /FOR SHARE$/, rows: [caps] }, rollback()]);
  await assert.rejects(new PostgresLiveDocumentStore({ pool: unconfigured.pool, schema: 'test_guarded_docs' }).get('one', 'live'), rejects('DEPENDENCY_UNAVAILABLE')); unconfigured.done();
});

test('guarded full reads and equal-revision polls verify canonical/projection digest', async () => {
  const f = await fixture();
  const full = script([begin(), state(), ...pair(f.row, f.checkpoint), commit()]);
  assert.deepEqual(await guarded(full.pool).get('one', 'live'), f.doc); full.done();
  const same = script([begin(), state(), ...pair({ ...f.row, actual_digest: f.checkpoint.digest }, f.checkpoint), commit()]);
  assert.equal(await guarded(same.pool).getIfChanged('one', 'live', 1), null);
  assert.match(same.calls[2].sql, /sha256\([\s\S]*int8send\(revision\)[\s\S]*content_json/); same.done();
  const future = script([begin(), state(), ...pair({ ...f.row, actual_digest: f.checkpoint.digest }, f.checkpoint), rollback()]);
  await assert.rejects(guarded(future.pool).getIfChanged('one', 'live', 2), rejects('DEPENDENCY_UNAVAILABLE')); future.done();
});

test('missing one side, conflicting bytes and regression commit quarantine before throwing', async () => {
  const f = await fixture();
  for (const [row, checkpoint] of [[null, f.checkpoint], [f.row, null],
    [{ ...f.row, content_json: Buffer.from('"Tampered"') }, f.checkpoint],
    [f.row, { ...f.checkpoint, revision: '2' }], [f.row, { ...f.checkpoint, digest: Buffer.alloc(31) }]]) {
    const s = script([begin(), state(), ...pair(row, checkpoint), quarantine(), commit()]);
    await assert.rejects(guarded(s.pool).get('one', 'live'), rejects('DEPENDENCY_UNAVAILABLE')); s.done();
    assert.equal(s.calls.some(call => call.sql === 'ROLLBACK'), false);
  }
  const absent = script([begin(), state(), ...pair(null, null), commit()]);
  assert.equal(await guarded(absent.pool).get('one', 'missing'), null); absent.done();
});

test('guarded list detects projection-only changes and orphan checkpoint rows without bulk states', async () => {
  const f = await fixture();
  const row = { ...f.row, actual_digest: f.checkpoint.digest, checkpoint_tenant_id: 'one', checkpoint_document_id: 'live',
    checkpoint_revision: '1', checkpoint_digest: f.checkpoint.digest };
  const s = script([begin(), state(), { match: /FULL OUTER JOIN[\s\S]*LIMIT \$2/, rows: [row] }, commit()]);
  assert.deepEqual(await guarded(s.pool).list('one'), [Object.fromEntries(Object.entries(f.doc).filter(([key]) => !['state', 'content'].includes(key)))]); s.done();
  for (const broken of [{ ...row, actual_digest: digest({ ...f.row, title_json: Buffer.from('"Changed"') }) },
    { ...row, tenant_id: null, document_id: null, revision: null, actual_digest: null }]) {
    const failure = script([begin(), state(), { rows: [broken] }, quarantine(), commit()]);
    await assert.rejects(guarded(failure.pool).list('one'), rejects('DEPENDENCY_UNAVAILABLE')); failure.done();
  }
});

test('guarded create atomically writes bounded document and independently verifiable checkpoint', async () => {
  let inserted, digestValue;
  const s = script([begin(), state({ ...caps, document_count: '0', byte_count: '0' }), ...pair(null, null),
    { match: /count\(\*\).*live_document_checkpoints/, rows: [{ count: '0' }] },
    { match: /count\(\*\).*live_documents WHERE tenant_id/, rows: [{ count: '0' }] },
    { match: /^INSERT INTO .*live_documents /, rows: (_, values) => {
      inserted = { tenant_id: values[0], document_id: values[1], state: values[2], title_json: values[3], content_json: values[4],
        logical_bytes: values[5], revision: '1', created_at: new Date(), updated_at: new Date() }; return [inserted];
    } }, { match: /SET document_count = document_count \+ 1/ },
    { match: /^INSERT INTO .*live_document_checkpoints/, check: (_, values) => { assert.deepEqual(values.slice(0, 2), ['one', 'live']); digestValue = values[2]; } }, commit()]);
  const result = await guarded(s.pool).create('one', { id: 'live', title: 'New', content: 'Bytes' });
  assert.equal(result.revision, 1); assert.deepEqual(digestValue, digest(inserted)); s.done();
});

test('guarded no-op replay preserves checkpoint and invalid input never quarantines', async () => {
  const f = await fixture();
  const s = script([begin(), state(), ...pair(f.row, f.checkpoint), commit()]);
  assert.deepEqual(await guarded(s.pool).applyUpdate('one', 'live', new Uint8Array([0, 0])), f.doc); s.done();
  const invalid = script([begin(), state(), ...pair(f.row, f.checkpoint), rollback()]);
  await assert.rejects(guarded(invalid.pool).applyUpdate('one', 'live', new Uint8Array([255, 255])), rejects('BAD_REQUEST')); invalid.done();
});

test('guarded mutation updates checkpoint at the same revision before commit; lost commit never adds quarantine', async () => {
  const f = await fixture(), ydoc = new Y.Doc(); Y.applyUpdate(ydoc, f.doc.state);
  const before = Y.encodeStateVector(ydoc); ydoc.getText('content').insert(0, 'New '); const update = Y.encodeStateAsUpdate(ydoc, before); ydoc.destroy();
  for (const lose of [false, true]) {
    let changed;
    const s = script([begin(), state(), ...pair(f.row, f.checkpoint),
      { match: /^UPDATE .*live_documents SET/, rows: (_, values) => { changed = { ...f.row, state: values[2], title_json: values[3], content_json: values[4], logical_bytes: values[5], revision: '2' }; return [changed]; } },
      { match: /SET byte_count = byte_count \+/ },
      { match: /^UPDATE .*live_document_checkpoints SET/, check: (_, values) => {
        assert.equal(values[2], 2); assert.equal(values[4], 1); assert.deepEqual(values[3], digest(changed));
      }, rows: [{ revision: '2' }] },
      { match: /^COMMIT$/, ...(lose ? { error: new Error('Synthetic lost real COMMIT response') } : {}) }, ...(lose ? [rollback()] : [])]);
    if (lose) await assert.rejects(guarded(s.pool).applyUpdate('one', 'live', update), rejects('DEPENDENCY_UNAVAILABLE'));
    else assert.equal((await guarded(s.pool).applyUpdate('one', 'live', update)).revision, 2);
    s.done(); assert.ok(s.calls.every(call => !call.sql.includes('SET quarantined')));
  }
});

test('quarantine COMMIT failure remains unavailable and never claims successful persistence', async () => {
  const f = await fixture();
  const s = script([begin(), state(), ...pair(f.row, null), quarantine(),
    { match: /^COMMIT$/, error: new Error('Lost quarantine commit response') }, rollback()]);
  await assert.rejects(guarded(s.pool).get('one', 'live'), rejects('DEPENDENCY_UNAVAILABLE')); s.done();
});
