// Scripted SQL contract tests, not evidence of real PostgreSQL behavior.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { StoreError } from '../src/memory-store.mjs';
import { PostgresAccountStore, initializePostgresAccountSchema } from '../src/account-store.mjs';

const state = { schema_version: 1, max_principals: 10000, max_identity_bindings: 20000, max_memberships: 50000,
  max_memberships_per_tenant: 10000, max_bytes: '16777216', principal_count: '0', identity_binding_count: '0', membership_count: '0', byte_count: '0' };
const issuer = 'https://issuer.example.test', subject = 'External-Subject', principalId = 'internal-user', tenantId = 'tenant-a';
const request = { issuer, subject, activeTenantId: tenantId };
const provision = { issuer, subject, principalId, tenantId, role: 'editor' };
const membership = { principalId, tenantId, role: 'editor' };
const mapped = { principal_id: principalId, tenant_id: tenantId, role: 'editor' };
const binding = { issuer: Buffer.from(issuer), subject: Buffer.from(subject), principal_id: principalId };
const hash = value => createHash('sha256').update(value).digest();
const bytes = principalId.length * 3 + issuer.length + subject.length + tenantId.length + 'editor'.length;
const populated = { ...state, principal_count: '1', identity_binding_count: '1', membership_count: '1', byte_count: String(bytes) };
function rejects(code) { return e => e instanceof StoreError && e.code === code && e.message === code && e.cause === undefined; }
function store(pool) { return new PostgresAccountStore({ pool, schema: 'opendoc_account_test' }); }
function scripted(steps, { releaseError } = {}) {
  const calls = [], releases = [];
  let connections = 0;
  return { calls, releases, pool: { async connect() {
    connections++;
    return { async query(sql, values) {
      calls.push({ sql, values });
      const step = steps.shift();
      assert.ok(step, `Unexpected query: ${sql}`);
      if (step.match) assert.match(sql, step.match);
      if (step.values) assert.deepEqual(values, step.values);
      if (step.error) throw step.error;
      return { rows: step.rows ?? [] };
    }, release(discard) { releases.push(discard); if (releaseError) throw releaseError; } };
  } }, done() { assert.equal(steps.length, 0); assert.equal(releases.length, 1); assert.equal(connections, 1); } };
}
const begin = { match: /^BEGIN ISOLATION LEVEL READ COMMITTED$/ };
const commit = { match: /^COMMIT$/ };
const rollback = { match: /^ROLLBACK$/ };
const shared = rows => ({ match: /account_state .*FOR SHARE$/s, rows });
const locked = rows => ({ match: /account_state .*FOR UPDATE$/s, rows });

test('account construction performs no I/O and explicit bootstrap requires a fresh safe namespace and bounded quotas', async () => {
  const pool = { async connect() { assert.fail('No implicit connection'); } };
  assert.equal(store(pool).kind, 'postgresql-accounts');
  for (const schema of [undefined, '', 'public', 'pg_catalog', 'information_schema', 'a.b', 'a"; SELECT 1', 'a\n', 'a'.repeat(64)]) {
    assert.throws(() => new PostgresAccountStore({ pool, schema }), TypeError);
  }
  assert.throws(() => new PostgresAccountStore({ pool: {}, schema: 'accounts' }), TypeError);
  for (const caps of [{ maxPrincipals: 0 }, { maxIdentityBindings: 1000001 }, { maxMemberships: 1.1 },
    { maxMembershipsPerTenant: 10001 }, { maxBytes: 0 }, { maxBytes: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(initializePostgresAccountSchema({ pool, schema: 'accounts', ...caps }), TypeError);
  }
  const db = scripted([begin, { match: /CREATE SCHEMA "opendoc_account_test";/ },
    { match: /INSERT INTO .*account_state/, values: [1, 2, 3, 4, 5, 1024] }, commit]);
  assert.deepEqual(await initializePostgresAccountSchema({ pool: db.pool, schema: 'opendoc_account_test',
    maxPrincipals: 2, maxIdentityBindings: 3, maxMemberships: 4, maxMembershipsPerTenant: 5, maxBytes: 1024 }), { schemaVersion: 1 });
  assert.doesNotMatch(db.calls[1].sql, /IF NOT EXISTS|DROP |\.documents|\.collaboration_rooms/);
  assert.match(db.calls[1].sql, /GENERATED ALWAYS AS \(sha256\(issuer\)\) STORED/);
  db.done();
  const existing = scripted([begin, { error: new Error('schema and private query') }, rollback]);
  await assert.rejects(initializePostgresAccountSchema({ pool: existing.pool, schema: 'opendoc_account_test' }), rejects('DEPENDENCY_UNAVAILABLE'));
  existing.done();
});

test('resolver binds exact issuer, subject and active tenant, reads fresh under a shared barrier, and never enrolls', async () => {
  for (const present of [true, false]) {
    const db = scripted([begin, shared([populated]), {
      match: /m\.tenant_id = \$1.*b\.issuer_hash = \$2 AND b\.subject_hash = \$3 AND b\.issuer = \$4 AND b\.subject = \$5 AND p\.active = true/s,
      values: [tenantId, hash(issuer), hash(subject), Buffer.from(issuer), Buffer.from(subject)], rows: present ? [mapped] : []
    }, commit]);
    assert.deepEqual(await store(db.pool).resolveMembership(request), present ? membership : null);
    assert.ok(!db.calls.some(({ sql }) => /^INSERT|^UPDATE|^DELETE|^CREATE/.test(sql))); db.done();
  }
});

test('provision creates principal, immutable identity binding and tenant membership in one quota-locked transaction', async () => {
  const db = scripted([begin, locked([state]), { match: /principals WHERE principal_id = \$1$/, values: [principalId] },
    { match: /INSERT INTO .*principals/, values: [principalId] },
    { match: /identity_bindings.*WHERE issuer_hash = \$1 AND subject_hash = \$2/s, values: [hash(issuer), hash(subject)] },
    { match: /INSERT INTO .*identity_bindings/, values: [Buffer.from(issuer), Buffer.from(subject), principalId] },
    { match: /memberships WHERE tenant_id = \$1 AND principal_id = \$2/, values: [tenantId, principalId] },
    { match: /count\(\*\).*WHERE tenant_id = \$1/, values: [tenantId], rows: [{ count: '0' }] },
    { match: /INSERT INTO .*memberships/, values: [tenantId, principalId, 'editor'] },
    { match: /UPDATE .*account_state/, values: [1, 1, 1, bytes] }, commit]);
  const value = { ...provision };
  const pending = store(db.pool).provisionAccount(value);
  value.issuer = 'different'; value.tenantId = 'different'; value.role = 'owner';
  assert.deepEqual(await pending, membership);
  db.done();
});

test('identical provisioning is idempotent and conflicting binding never updates the association', async () => {
  const db = scripted([begin, locked([populated]), { rows: [{ active: true }] }, { rows: [binding] },
    { rows: [{ role: 'editor' }] }, { match: /UPDATE .*account_state/, values: [1, 1, 1, bytes] }, commit]);
  assert.deepEqual(await store(db.pool).provisionAccount(provision), membership); db.done();
  assert.ok(!db.calls.some(({ sql }) => /^INSERT|^DELETE|^UPDATE .*identity_bindings/.test(sql)));
  for (const conflicting of [{ ...binding, principal_id: 'someone-else' }, { ...binding, subject: Buffer.from('hash-collision') }]) {
    const conflict = scripted([begin, locked([populated]), { rows: [{ active: true }] }, { rows: [conflicting] }, rollback]);
    await assert.rejects(store(conflict.pool).provisionAccount(provision), rejects('CONFLICT')); conflict.done();
    assert.ok(!conflict.calls.some(({ sql }) => /^INSERT|^UPDATE|^DELETE/.test(sql)));
  }
  const roleConflict = scripted([begin, locked([populated]), { rows: [{ active: true }] }, { rows: [binding] },
    { rows: [{ role: 'viewer' }] }, rollback]);
  await assert.rejects(store(roleConflict.pool).provisionAccount(provision), rejects('CONFLICT')); roleConflict.done();
});

test('explicit membership changes and revocations are tenant-bound and update byte/count accounting', async () => {
  const change = scripted([begin, locked([populated]), { rows: [{ active: true }] },
    { values: [tenantId, principalId], rows: [{ role: 'editor' }] },
    { match: /UPDATE .*memberships .*WHERE tenant_id = \$1 AND principal_id = \$2/, values: [tenantId, principalId, 'commenter'] },
    { match: /UPDATE .*account_state/, values: [1, 1, 1, bytes + 3] }, commit]);
  assert.deepEqual(await store(change.pool).setMembership({ principalId, tenantId, role: 'commenter' }), { principalId, tenantId, role: 'commenter' }); change.done();
  const removed = scripted([begin, locked([populated]), { match: /DELETE FROM .*memberships WHERE tenant_id = \$1 AND principal_id = \$2 RETURNING role/,
    values: [tenantId, principalId], rows: [{ role: 'editor' }] },
  { match: /UPDATE .*account_state/, values: [1, 1, 0, bytes - tenantId.length - principalId.length - 6] }, commit]);
  assert.equal(await store(removed.pool).revokeMembership({ principalId, tenantId }), true); removed.done();
  const absent = scripted([begin, locked([state]), { values: [tenantId, principalId] }, commit]);
  assert.equal(await store(absent.pool).revokeMembership({ principalId, tenantId }), false); absent.done();
});

test('explicit identity links require an active existing principal; deactivation cannot be undone by provisioning', async () => {
  for (const method of ['linkIdentity', 'setMembership', 'provisionAccount']) {
    for (const active of [null, false]) {
      if (method === 'provisionAccount' && active === null) continue;
      const db = scripted([begin, locked([populated]), { rows: active === null ? [] : [{ active }] }, rollback]);
      const value = method === 'linkIdentity' ? { issuer, subject, principalId } : method === 'setMembership' ? membership : provision;
      await assert.rejects(store(db.pool)[method](value), rejects(active === null ? 'NOT_FOUND' : 'CONFLICT')); db.done();
    }
  }
  const db = scripted([begin, locked([populated]), { values: [principalId], rows: [{ active: true }] },
    { match: /UPDATE .*principals SET active = \$2 WHERE principal_id = \$1/, values: [principalId, false] }, commit]);
  assert.deepEqual(await store(db.pool).setPrincipalActive({ principalId, active: false }), { principalId, active: false }); db.done();
});

test('all account inputs reject malformed values and extra claims before opening a connection', async () => {
  const accounts = store({ async connect() { assert.fail('No connection expected'); } });
  for (const value of [undefined, null, [], { ...request, role: 'owner' }, { ...request, email: 'same@example.test' },
    { ...request, issuer: '' }, { ...request, issuer: 'x'.repeat(2049) }, { ...request, subject: 'x'.repeat(513) },
    { ...request, subject: '\ud800' }, { ...request, subject: 'sub\u0000' }, { ...request, activeTenantId: 'tenant\n' },
    { ...request, subject: ' \t ' }, { ...request, activeTenantId: "a' OR true --" }, { ...request, activeTenantId: 'a'.repeat(129) }]) {
    await assert.rejects(accounts.resolveMembership(value), rejects('BAD_REQUEST'));
  }
  for (const value of [{ ...provision, principalId: 'p\n' }, { ...provision, principalId: 'a'.repeat(65) },
    { ...provision, role: 'administrator' }, { ...provision, token: 'untrusted' }]) {
    await assert.rejects(accounts.provisionAccount(value), rejects('BAD_REQUEST'));
  }
  await assert.rejects(accounts.setMembership({ ...membership, role: null }), rejects('BAD_REQUEST'));
  await assert.rejects(accounts.linkIdentity({ issuer, subject, principalId: '../x' }), rejects('BAD_REQUEST'));
  await assert.rejects(accounts.revokeMembership({ principalId, tenantId: 'x\n' }), rejects('BAD_REQUEST'));
  await assert.rejects(accounts.setPrincipalActive({ principalId, active: 1 }), rejects('BAD_REQUEST'));
  const accessor = { ...request }; Object.defineProperty(accessor, 'issuer', { get() { assert.fail('Accessor must not run'); } });
  await assert.rejects(accounts.resolveMembership(accessor), rejects('BAD_REQUEST'));
});

test('corrupt schema versions, quota state, membership rows and driver errors fail closed without leaking details', async () => {
  for (const rows of [[], [{ ...state, schema_version: 2 }], [{ ...state, principal_count: '10001' }],
    [{ ...state, byte_count: '-1' }], [{ ...state, max_memberships: Infinity }]]) {
    const db = scripted([begin, shared(rows), rollback]);
    await assert.rejects(store(db.pool).resolveMembership(request), rejects('DEPENDENCY_UNAVAILABLE')); db.done();
  }
  for (const rows of [[{ ...mapped, tenant_id: 'other' }], [{ ...mapped, role: 'admin' }], [mapped, mapped], [{ ...mapped, principal_id: 'x\n' }]]) {
    const db = scripted([begin, shared([populated]), { rows }, rollback]);
    await assert.rejects(store(db.pool).resolveMembership(request), rejects('DEPENDENCY_UNAVAILABLE')); db.done();
  }
  const db = scripted([begin, { error: new Error('secret database URL, issuer and subject') }, rollback]);
  await assert.rejects(store(db.pool).resolveMembership(request), rejects('DEPENDENCY_UNAVAILABLE')); db.done();
  await assert.rejects(store({ async connect() { throw new Error('postgres://private'); } }).resolveMembership(request), rejects('DEPENDENCY_UNAVAILABLE'));
});

test('quota failures abort the entire provision including any principal and identity inserts', async () => {
  const global = scripted([begin, locked([{ ...state, principal_count: '10000' }]), { rows: [] }, rollback]);
  await assert.rejects(store(global.pool).provisionAccount(provision), rejects('CAPACITY_EXCEEDED')); global.done();
  for (const quotaState of [{ ...populated, max_memberships: 1 }, { ...populated, max_memberships_per_tenant: 1 },
    { ...populated, max_bytes: bytes }]) {
    const db = scripted([begin, locked([quotaState]), { rows: [{ active: true }] }, { rows: [] },
      { rows: [{ count: '1' }] }, rollback]);
    await assert.rejects(store(db.pool).setMembership({ principalId, tenantId: 'tenant-b', role: 'editor' }), rejects('CAPACITY_EXCEEDED')); db.done();
  }
});

test('uncertain BEGIN, lock and COMMIT never retry; rollback failure discards the client for reads and writes', async () => {
  for (const method of ['resolveMembership', 'setPrincipalActive']) {
    for (const stage of ['begin', 'lock', 'commit']) {
      for (const rollbackFails of [false, true]) {
        const steps = [{ ...begin, ...(stage === 'begin' ? { error: new Error('begin reply lost') } : {}) }];
        if (stage !== 'begin') steps.push({ ...(method === 'resolveMembership' ? shared([populated]) : locked([populated])),
          ...(stage === 'lock' ? { error: new Error('lock reply lost') } : {}) });
        if (stage === 'commit') {
          steps.push({ rows: method === 'resolveMembership' ? [mapped] : [{ active: true }] });
          if (method === 'setPrincipalActive') steps.push({ match: /UPDATE .*principals/ });
          steps.push({ ...commit, error: new Error('commit reply lost') });
        }
        steps.push({ ...rollback, ...(rollbackFails ? { error: new Error('rollback failed') } : {}) });
        const db = scripted(steps);
        await assert.rejects(store(db.pool)[method](method === 'resolveMembership' ? request : { principalId, active: false }), rejects('DEPENDENCY_UNAVAILABLE'));
        assert.deepEqual(db.releases, [rollbackFails]); db.done();
      }
    }
  }
  const release = scripted([begin, shared([state]), {}, commit], { releaseError: new Error('private release error') });
  await assert.rejects(store(release.pool).resolveMembership(request), rejects('DEPENDENCY_UNAVAILABLE')); release.done();
});
