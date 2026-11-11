// @spec OD-LIVE-001 OD-LIVE-002 OD-LIVE-003 OD-LIVE-004
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { StoreError } from '../src/memory-store.mjs';
import { MemoryLiveDocumentStore, PostgresLiveDocumentStore, initializePostgresLiveDocumentSchema } from '../src/live-document-store.mjs';
import { LIVE_DOCUMENT_LIMITS } from '../src/collaboration-state.mjs';

const rejects = code => error => error instanceof StoreError && error.code === code && error.message === code && error.cause === undefined;
const input = { id: 'live', title: 'A title', content: 'Synthetic\u0000 🪴 text' };
const project = state => { const doc = new Y.Doc(); Y.applyUpdate(doc, state); const value = { title: doc.getText('title').toString(), content: doc.getText('content').toString() }; doc.destroy(); return value; };
function delta(state, id, edit) {
  const doc = new Y.Doc(); doc.clientID = id; Y.applyUpdate(doc, state); const vector = Y.encodeStateVector(doc); edit(doc);
  const result = Y.encodeStateAsUpdate(doc, vector); doc.destroy(); return result;
}

test('memory live documents create once, project title/content, reopen stable IDs and isolate tenants', async () => {
  const store = new MemoryLiveDocumentStore();
  assert.equal(await store.get('one', 'live'), null); assert.deepEqual(await store.list('one'), []);
  const created = await store.create('one', input);
  assert.equal(created.revision, 1); assert.equal(created.authority, 'yjs');
  assert.deepEqual(project(created.state), { title: input.title, content: input.content });
  assert.equal(await store.get('two', 'live'), null);
  await store.create('two', { ...input, title: 'Other tenant' });
  assert.equal((await store.get('one', 'live')).title, input.title);
  assert.equal((await store.get('two', 'live')).title, 'Other tenant');
  const listed = await store.list('one'); assert.equal(listed.length, 1); assert.equal(listed[0].id, 'live');
  assert.ok(!Object.hasOwn(listed[0], 'content')); assert.ok(!Object.hasOwn(listed[0], 'state'));
  await assert.rejects(store.create('one', input), rejects('CONFLICT'));
  created.state.fill(0); created.title = 'mutated';
  assert.equal((await store.get('one', 'live')).title, input.title);
  await assert.rejects(store.applyUpdate('one', 'missing', new Uint8Array([0, 0])), rejects('NOT_FOUND'));
  assert.equal(store.replace, undefined);
});

test('live creates empty documents and rejects malformed Unicode, untrusted shape and size without allocations', async () => {
  const store = new MemoryLiveDocumentStore();
  const empty = await store.create('one', { id: 'empty', title: '', content: '' });
  assert.deepEqual(project(empty.state), { title: '', content: '' });
  assert.deepEqual(await store.applyUpdate('one', 'empty', new Uint8Array([0, 0])), empty);
  for (const bad of [{ ...input, content: '\ud800' }, { ...input, title: '\udc00' }, { ...input, title: 'a'.repeat(201) }, { ...input, tenantId: 'other' }, { ...input, id: '../bad' }, { ...input, id: 'bad\n' }]) {
    await assert.rejects(store.create('one', bad), rejects('BAD_REQUEST'));
  }
  await assert.rejects(store.create('one', { ...input, content: '💥'.repeat(LIVE_DOCUMENT_LIMITS.maxContentBytes / 4 + 1) }), rejects('TOO_LARGE'));
  assert.equal((await store.list('one')).length, 1);
  await assert.rejects(store.create('../tenant', input), rejects('BAD_REQUEST'));
});

test('concurrent title/body updates and deletion-only replay converge without overwrites or false revision growth', async () => {
  const store = new MemoryLiveDocumentStore(); const base = await store.create('one', input);
  const first = delta(base.state, 1001, doc => doc.getText('content').insert(0, 'First '));
  const second = delta(base.state, 1002, doc => { doc.getText('title').delete(0, input.title.length); doc.getText('title').insert(0, 'New title'); });
  const results = await Promise.all([store.applyUpdate('one', 'live', first), store.applyUpdate('one', 'live', second)]);
  assert.deepEqual(results.map(value => value.revision), [2, 3]);
  const final = await store.get('one', 'live'); assert.equal(final.content, `First ${input.content}`); assert.equal(final.title, 'New title');
  assert.deepEqual(await store.applyUpdate('one', 'live', first), final);
  const deletion = delta(final.state, 1003, doc => doc.getText('content').delete(0, 6));
  const deleted = await store.applyUpdate('one', 'live', deletion); assert.equal(deleted.revision, 4); assert.equal(deleted.content, input.content);
  assert.deepEqual(await store.applyUpdate('one', 'live', deletion), deleted);
  assert.deepEqual(await store.get('one', 'live'), deleted);
});

test('quotas are atomic under racing creates and rejected writes preserve prior state', async () => {
  const store = new MemoryLiveDocumentStore({ maxDocuments: 2, maxDocumentsPerTenant: 1 });
  const raced = await Promise.allSettled([store.create('one', input), store.create('one', { ...input, id: 'second' })]);
  assert.equal(raced.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(raced.find(value => value.status === 'rejected').reason.code, 'CAPACITY_EXCEEDED');
  await store.create('two', input); await assert.rejects(store.create('three', input), rejects('CAPACITY_EXCEEDED'));
  const current = await store.get('one', 'live');
  await assert.rejects(store.applyUpdate('one', 'live', new Uint8Array([255, 255])), rejects('BAD_REQUEST'));
  assert.deepEqual(await store.get('one', 'live'), current);
  const tiny = new MemoryLiveDocumentStore({ maxBytes: 1 }); await assert.rejects(tiny.create('one', input), rejects('CAPACITY_EXCEEDED'));
  assert.deepEqual(await tiny.list('one'), []);
});

function scripted(steps) {
  const calls = [], releases = [];
  return { calls, releases, pool: { async connect() { return { async query(sql, values) {
    calls.push({ sql, values }); const next = steps.shift(); assert.ok(next, `Unexpected SQL ${sql}`);
    if (next.match) assert.match(sql, next.match); if (next.error) throw next.error; return { rows: next.rows ?? [] };
  }, release(discard) { releases.push(discard); } }; } }, done() { assert.equal(steps.length, 0); } };
}
const caps = { schema_version: 1, max_documents_per_tenant: 100, max_documents: 1000, max_bytes: '16777216', document_count: '0', byte_count: '0' };
const pg = pool => new PostgresLiveDocumentStore({ pool, schema: 'test_live_docs' });

test('PostgreSQL adapter is inert, fresh-schema-only, and rejects unsafe schema or quota configuration', async () => {
  const pool = { async connect() { assert.fail('Must not connect implicitly'); } };
  assert.equal(pg(pool).kind, 'postgresql-live-documents');
  for (const schema of [undefined, 'public', 'pg_catalog', 'information_schema', 'a.b', 'a";--', 'a'.repeat(64)]) assert.throws(() => new PostgresLiveDocumentStore({ pool, schema }), TypeError);
  for (const options of [{ maxBytes: 0 }, { maxDocuments: 1000001 }, { maxDocumentsPerTenant: 10001 }]) await assert.rejects(initializePostgresLiveDocumentSchema({ pool, schema: 'test_live_docs', ...options }), TypeError);
  const script = scripted([{ match: /^BEGIN/ }, { match: /CREATE SCHEMA "test_live_docs";/ }, { match: /INSERT INTO .*live_document_state/ }, { match: /^COMMIT$/ }]);
  assert.deepEqual(await initializePostgresLiveDocumentSchema({ pool: script.pool, schema: 'test_live_docs' }), { schemaVersion: 1 }); script.done();
});

test('PostgreSQL live reads fence uncertain writes and never allocate missing documents', async () => {
  const script = scripted([{ match: /^BEGIN/ }, { match: /FOR SHARE$/, rows: [caps] }, { match: /WHERE tenant_id = \$1 AND document_id = \$2/, rows: [] }, { match: /^COMMIT$/ }]);
  assert.equal(await pg(script.pool).get('one', 'missing'), null); script.done();
  const write = scripted([{ match: /^BEGIN/ }, { match: /FOR UPDATE$/, rows: [caps] }, { match: /FOR UPDATE$/, rows: [] }, { match: /^ROLLBACK$/ }]);
  await assert.rejects(pg(write.pool).applyUpdate('one', 'missing', new Uint8Array([0, 0])), rejects('NOT_FOUND')); write.done();
});

test('PostgreSQL live failures sanitize private driver details and discard uncertain rollback clients', async () => {
  for (const failure of ['begin', 'lock', 'commit']) {
    for (const badRollback of [false, true]) {
      const steps = [{ match: /^BEGIN/, ...(failure === 'begin' ? { error: new Error('private DB address') } : {}) }];
      if (failure !== 'begin') steps.push({ match: /FOR SHARE$/, ...(failure === 'lock' ? { error: new Error('private SQL') } : { rows: [caps] }) });
      if (failure === 'commit') steps.push({ rows: [] }, { match: /^COMMIT$/, error: new Error('lost COMMIT') });
      steps.push({ match: /^ROLLBACK$/, ...(badRollback ? { error: new Error('lost rollback') } : {}) });
      const script = scripted(steps); await assert.rejects(pg(script.pool).get('one', 'live'), rejects('DEPENDENCY_UNAVAILABLE'));
      assert.deepEqual(script.releases, [badRollback]); script.done();
    }
  }
});

test('PostgreSQL changed reads fence commits and avoid unchanged state decoding', async () => {
  const script = scripted([{ match: /^BEGIN/ }, { match: /FOR SHARE$/, rows: [caps] },
    { match: /^SELECT revision FROM .*WHERE tenant_id = \$1 AND document_id = \$2$/, rows: [{ revision: '4' }] }, { match: /^COMMIT$/ }]);
  assert.equal(await pg(script.pool).getIfChanged('one', 'live', 4), null);
  assert.deepEqual(script.calls[2].values, ['one', 'live']); script.done();
  const store = pg({ async connect() { assert.fail('Bad input must not connect'); } });
  for (const value of [undefined, null, 0, -1, 1.5, '1', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(store.getIfChanged('one', 'live', value), rejects('BAD_REQUEST'));
  }
  await assert.rejects(store.getIfChanged('../tenant', 'live', 1), rejects('BAD_REQUEST'));
});

test('PostgreSQL changed reads distinguish missing, regressed and corrupt authority', async () => {
  for (const rows of [[], [{ revision: '2' }], [{ revision: 'bad' }], [{ revision: '3' }, { revision: '3' }]]) {
    const script = scripted([{ match: /^BEGIN/ }, { match: /FOR SHARE$/, rows: [caps] }, { rows }, { match: /^ROLLBACK$/ }]);
    await assert.rejects(pg(script.pool).getIfChanged('one', 'live', 3), rejects(rows.length ? 'DEPENDENCY_UNAVAILABLE' : 'NOT_FOUND'));
    script.done();
  }
  const current = await new MemoryLiveDocumentStore().create('one', input);
  const row = { document_id: current.id, revision: '2', title_json: Buffer.from(JSON.stringify(current.title)),
    content_json: Buffer.from(JSON.stringify(current.content)), state: current.state,
    created_at: current.createdAt, updated_at: current.updatedAt };
  const script = scripted([{ match: /^BEGIN/ }, { match: /FOR SHARE$/, rows: [caps] },
    { match: /^SELECT revision/, rows: [{ revision: '2' }] }, { match: /^SELECT \*/, rows: [row] }, { match: /^COMMIT$/ }]);
  assert.deepEqual(await pg(script.pool).getIfChanged('one', 'live', 1), { ...current, revision: 2 }); script.done();
  for (const bad of [{ ...row, revision: '3' }, { ...row, content_json: Buffer.from(JSON.stringify('Wrong projection')) }]) {
    const failure = scripted([{ match: /^BEGIN/ }, { rows: [caps] }, { rows: [{ revision: '2' }] }, { rows: [bad] }, { match: /^ROLLBACK$/ }]);
    await assert.rejects(pg(failure.pool).getIfChanged('one', 'live', 1), rejects('DEPENDENCY_UNAVAILABLE')); failure.done();
  }
});
