// Real PostgreSQL tests: explicit synthetic local target only; never ambient DBs.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { StoreError } from '../src/memory-store.mjs';
import { PostgresAccountStore, initializePostgresAccountSchema } from '../src/account-store.mjs';

function target(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('A synthetic local PostgreSQL test URL is required'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/opendoc_test' || url.username !== 'opendoc_test' || url.password !== 'synthetic-test-only' || url.search || url.hash) {
    throw new Error('Refusing a database target outside the synthetic local opendoc_test contract');
  }
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local test port');
  return { host: url.hostname === '[::1]' ? '::1' : '127.0.0.1', port, user: 'opendoc_test', password: 'synthetic-test-only', database: 'opendoc_test',
    ssl: false, options: '-c search_path=pg_catalog', application_name: 'opendoc-account-synthetic-integration',
    max: 2, connectionTimeoutMillis: 3000, query_timeout: 10000, statement_timeout: 8000, idle_in_transaction_session_timeout: 8000 };
}
function serverAddresses(raw) {
  if (raw === undefined) return ['127.0.0.1', '::1'];
  if (typeof raw !== 'string' || isIP(raw) === 0 || raw.includes('%')) throw new Error('Expected server address must be one exact IP');
  return [raw];
}
function rejects(code) { return e => e instanceof StoreError && e.code === code && e.message === code && e.cause === undefined; }
const issuer = 'https://issuer.example.test';
const external = { issuer, subject: 'synthetic-subject' };
const provision = { ...external, principalId: 'principal-a', tenantId: 'tenant-a', role: 'editor' };
const expected = { principalId: 'principal-a', tenantId: 'tenant-a', role: 'editor' };
const lookup = { ...external, activeTenantId: 'tenant-a' };

test('account integration refuses remote, non-test, option-bearing and ambient database targets', () => {
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

test('real PostgreSQL accounts: identity isolation, administration, durability, bounded concurrency and failure recovery', {
  skip: process.env.OPENDOC_PG_INTEGRATION !== '1' ? 'Set OPENDOC_PG_INTEGRATION=1 and synthetic loopback DATABASE_URL to opt in' : false,
  timeout: 90000
}, async t => {
  const config = target(process.env.DATABASE_URL);
  const expectedAddresses = serverAddresses(process.env.OPENDOC_PG_EXPECTED_SERVER_ADDRESS);
  const { Pool } = await import('pg');
  const poolA = new Pool(config), poolB = new Pool(config);
  const schemas = [];
  const create = async (limits = {}) => {
    const name = `opendoc_account_test_${randomBytes(12).toString('hex')}`;
    await initializePostgresAccountSchema({ pool: poolA, schema: name, ...limits });
    schemas.push(name);
    return { name, a: new PostgresAccountStore({ pool: poolA, schema: name }), b: new PostgresAccountStore({ pool: poolB, schema: name }) };
  };
  t.after(async () => {
    try {
      for (const name of schemas) {
        // Only exact successfully-created test objects, never CASCADE or patterns.
        for (const table of ['memberships', 'identity_bindings', 'principals', 'account_state']) await poolA.query(`DROP TABLE "${name}".${table}`);
        await poolA.query(`DROP SCHEMA "${name}"`);
      }
    } finally { await Promise.all([poolA.end(), poolB.end()]); }
  });
  const identity = await poolA.query('SELECT current_database() AS database, current_user AS username, host(inet_server_addr()) AS address, pg_backend_pid() AS pid');
  assert.equal(identity.rows[0].database, 'opendoc_test'); assert.equal(identity.rows[0].username, 'opendoc_test');
  assert.ok(expectedAddresses.includes(identity.rows[0].address), 'Must be the expected local synthetic PostgreSQL server');
  assert.notEqual(identity.rows[0].pid, (await poolB.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);

  await t.test('fresh bootstrap refuses existing schemas; missing accounts and tenants never enroll', async () => {
    const { name, a, b } = await create();
    assert.equal(await a.resolveMembership(lookup), null);
    assert.deepEqual((await poolA.query(`SELECT principal_count, identity_binding_count, membership_count, byte_count FROM "${name}".account_state`)).rows[0],
      { principal_count: '0', identity_binding_count: '0', membership_count: '0', byte_count: '0' });
    assert.deepEqual(await a.provisionAccount(provision), expected);
    await assert.rejects(initializePostgresAccountSchema({ pool: poolB, schema: name }), rejects('DEPENDENCY_UNAVAILABLE'));
    assert.deepEqual(await b.resolveMembership(lookup), expected);
    assert.equal(await b.resolveMembership({ ...lookup, activeTenantId: 'tenant-b' }), null);
    assert.equal(await b.resolveMembership({ ...lookup, subject: 'unprovisioned' }), null);
    assert.deepEqual(await a.provisionAccount(provision), expected);
    assert.equal((await poolA.query(`SELECT principal_count FROM "${name}".account_state`)).rows[0].principal_count, '1');
  });

  await t.test('issuer+subject are exact, case-sensitive, unnormalized and independently tenant-bound; no email linking', async () => {
    const { a, b } = await create();
    await a.provisionAccount(provision);
    await a.provisionAccount({ ...provision, issuer: 'https://other.example.test', principalId: 'principal-b', role: 'viewer' });
    assert.deepEqual(await b.resolveMembership({ ...lookup, issuer: 'https://other.example.test' }), { ...expected, principalId: 'principal-b', role: 'viewer' });
    for (const change of [{ issuer: `${issuer}/` }, { issuer: 'https://ISSUER.example.test' }, { subject: 'Synthetic-subject' },
      { subject: 'synthetic-subject ' }, { subject: ' synthetic-subject' }]) assert.equal(await a.resolveMembership({ ...lookup, ...change }), null);
    await b.setMembership({ principalId: 'principal-a', tenantId: 'tenant-b', role: 'commenter' });
    assert.deepEqual(await a.resolveMembership({ ...lookup, activeTenantId: 'tenant-b' }), { ...expected, tenantId: 'tenant-b', role: 'commenter' });
    assert.deepEqual(await a.resolveMembership(lookup), expected);
    await a.provisionAccount({ ...provision, subject: 'é', principalId: 'composed' });
    assert.equal(await b.resolveMembership({ ...lookup, subject: 'e\u0301' }), null);
    await a.provisionAccount({ ...provision, subject: 'same@example.test', principalId: 'email-shaped-a' });
    assert.equal(await b.resolveMembership({ ...lookup, issuer: 'https://new.example.test', subject: 'same@example.test' }), null);
    await b.provisionAccount({ ...provision, issuer: 'https://new.example.test', subject: 'same@example.test', principalId: 'email-shaped-b' });
    assert.equal((await a.resolveMembership({ ...lookup, issuer: 'https://new.example.test', subject: 'same@example.test' })).principalId, 'email-shaped-b');
    await assert.rejects(a.provisionAccount({ ...provision, email: 'same@example.test' }), rejects('BAD_REQUEST'));
    await assert.rejects(b.resolveMembership({ ...lookup, email: 'same@example.test', role: 'owner' }), rejects('BAD_REQUEST'));
  });

  await t.test('maximum-length UTF-8 identifiers fit bounded indexes and malformed surrogate strings cannot alias', async () => {
    const { a, b } = await create();
    const unicode = { issuer: '界'.repeat(2048), subject: '語'.repeat(512) };
    await a.provisionAccount({ ...provision, ...unicode });
    assert.deepEqual(await b.resolveMembership({ ...lookup, ...unicode }), expected);
    for (const subject of ['\ud800', '\ud801', '\udc00']) {
      await assert.rejects(a.provisionAccount({ ...provision, subject }), rejects('BAD_REQUEST'));
      await assert.rejects(b.resolveMembership({ ...lookup, subject }), rejects('BAD_REQUEST'));
    }
    await a.provisionAccount({ ...provision, subject: '\ufffd', principalId: 'replacement-character' });
    assert.equal((await b.resolveMembership({ ...lookup, subject: '\ufffd' })).principalId, 'replacement-character');
    for (const change of [{ principalId: 'bad\n' }, { tenantId: 'bad\n' }, { role: 'admin' }, { issuer: 'bad\u0000' }]) {
      await assert.rejects(a.provisionAccount({ ...provision, ...change }), rejects('BAD_REQUEST'));
    }
  });

  await t.test('a conflicting link cannot overwrite identity or leave partial principal/membership records', async () => {
    const { name, a, b } = await create();
    await a.provisionAccount(provision);
    await assert.rejects(b.provisionAccount({ ...provision, principalId: 'attacker', tenantId: 'different', role: 'owner' }), rejects('CONFLICT'));
    assert.equal((await poolA.query(`SELECT count(*) AS count FROM "${name}".principals WHERE principal_id = $1`, ['attacker'])).rows[0].count, '0');
    await a.provisionAccount({ ...provision, subject: 'other-subject', principalId: 'other-principal' });
    await assert.rejects(b.linkIdentity({ ...external, principalId: 'other-principal' }), rejects('CONFLICT'));
    assert.deepEqual(await a.resolveMembership(lookup), expected);
    await a.linkIdentity({ issuer: 'https://linked.example.test', subject: 'linked-subject', principalId: 'principal-a' });
    assert.deepEqual(await b.resolveMembership({ issuer: 'https://linked.example.test', subject: 'linked-subject', activeTenantId: 'tenant-a' }), expected);
    await assert.rejects(b.provisionAccount({ ...provision, role: 'owner' }), rejects('CONFLICT'));
    assert.deepEqual(await a.resolveMembership(lookup), expected);
  });

  await t.test('concurrent binding claims select exactly one immutable principal and rollback every loser', async () => {
    const { name, a, b } = await create();
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
      (i % 2 ? a : b).provisionAccount({ ...provision, principalId: `contender-${i}` })));
    const winners = results.filter(r => r.status === 'fulfilled');
    assert.equal(winners.length, 1);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => rejects('CONFLICT')(r.reason)));
    assert.deepEqual(await a.resolveMembership(lookup), winners[0].value);
    assert.deepEqual((await poolA.query(`SELECT principal_count, identity_binding_count, membership_count FROM "${name}".account_state`)).rows[0],
      { principal_count: '1', identity_binding_count: '1', membership_count: '1' });
    const duplicate = { ...provision, principalId: winners[0].value.principalId };
    const idempotent = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).provisionAccount(duplicate)));
    assert.ok(idempotent.every(value => value.principalId === duplicate.principalId));
  });

  await t.test('role changes, revocation and deactivation take effect on the next uncached lookup', async () => {
    const { a, b } = await create();
    await a.provisionAccount(provision);
    await a.setMembership({ principalId: 'principal-a', tenantId: 'tenant-b', role: 'owner' });
    await b.setMembership({ ...expected, role: 'viewer' });
    assert.deepEqual(await a.resolveMembership(lookup), { ...expected, role: 'viewer' });
    assert.equal(await b.revokeMembership({ principalId: 'principal-a', tenantId: 'tenant-a' }), true);
    assert.equal(await a.resolveMembership(lookup), null);
    assert.equal(await b.revokeMembership({ principalId: 'principal-a', tenantId: 'tenant-a' }), false);
    assert.deepEqual(await a.resolveMembership({ ...lookup, activeTenantId: 'tenant-b' }), { ...expected, tenantId: 'tenant-b', role: 'owner' });
    await b.setPrincipalActive({ principalId: 'principal-a', active: false });
    assert.equal(await a.resolveMembership({ ...lookup, activeTenantId: 'tenant-b' }), null);
    await assert.rejects(a.provisionAccount(provision), rejects('CONFLICT'));
    await assert.rejects(a.setMembership(expected), rejects('CONFLICT'));
    await b.setPrincipalActive({ principalId: 'principal-a', active: true });
    assert.equal(await a.resolveMembership(lookup), null, 'Reactivation must not recreate revoked memberships');
    assert.equal((await a.resolveMembership({ ...lookup, activeTenantId: 'tenant-b' })).role, 'owner');
    await assert.rejects(a.setMembership({ ...expected, principalId: 'missing' }), rejects('NOT_FOUND'));
    await assert.rejects(a.linkIdentity({ ...external, principalId: 'missing' }), rejects('NOT_FOUND'));
    await assert.rejects(a.setPrincipalActive({ principalId: 'missing', active: false }), rejects('NOT_FOUND'));
  });

  await t.test('global principal, binding, membership, per-tenant and byte quotas are atomic across connections', async () => {
    for (const limits of [{ maxPrincipals: 2 }, { maxIdentityBindings: 2 }, { maxMemberships: 2 }, { maxMembershipsPerTenant: 2 }]) {
      const { name, a, b } = await create(limits);
      const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).provisionAccount({
        ...provision, subject: `sub-${i}`, principalId: `principal-${i}`
      })));
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
      assert.ok(results.filter(r => r.status === 'rejected').every(r => rejects('CAPACITY_EXCEEDED')(r.reason)));
      assert.deepEqual((await poolA.query(`SELECT principal_count, identity_binding_count, membership_count FROM "${name}".account_state`)).rows[0],
        { principal_count: '2', identity_binding_count: '2', membership_count: '2' });
    }
    const oneBytes = 1 * 3 + issuer.length + 1 + 1 + 6;
    const quota = await create({ maxBytes: oneBytes * 2 });
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => (i % 2 ? quota.a : quota.b).provisionAccount({
      issuer, subject: String(i), principalId: String(i), tenantId: 't', role: 'editor'
    })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => rejects('CAPACITY_EXCEEDED')(r.reason)));
    const accounting = (await poolA.query(`SELECT s.byte_count, s.principal_count, s.identity_binding_count, s.membership_count,
      (SELECT sum(octet_length(principal_id)) FROM "${quota.name}".principals) +
      (SELECT sum(octet_length(issuer) + octet_length(subject) + octet_length(principal_id)) FROM "${quota.name}".identity_bindings) +
      (SELECT sum(octet_length(tenant_id) + octet_length(principal_id) + octet_length(role)) FROM "${quota.name}".memberships) AS actual
      FROM "${quota.name}".account_state s`)).rows[0];
    assert.equal(accounting.byte_count, accounting.actual);
    assert.equal(accounting.byte_count, String(oneBytes * 2));
    const successful = results.find(r => r.status === 'fulfilled').value;
    await quota.a.revokeMembership({ principalId: successful.principalId, tenantId: 't' });
    await quota.b.setMembership(successful);
    assert.equal((await poolA.query(`SELECT byte_count FROM "${quota.name}".account_state`)).rows[0].byte_count, String(oneBytes * 2));
  });

  await t.test('a new pool and process preserve principal bindings and authorization without login reenrollment', async () => {
    const { name, a } = await create();
    await a.provisionAccount(provision);
    const reopened = new Pool(config);
    try { assert.deepEqual(await new PostgresAccountStore({ pool: reopened, schema: name }).resolveMembership(lookup), expected); }
    finally { await reopened.end(); }
    const child = `
      import { Pool } from 'pg';
      import { PostgresAccountStore } from './src/account-store.mjs';
      const pool = new Pool(JSON.parse(process.env.OPENDOC_CHILD_CONFIG));
      try {
        const store = new PostgresAccountStore({ pool, schema: process.env.OPENDOC_CHILD_SCHEMA });
        process.stdout.write(JSON.stringify(await store.resolveMembership(JSON.parse(process.env.OPENDOC_CHILD_LOOKUP))));
      } finally { await pool.end(); }
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', child], {
      cwd: new URL('..', import.meta.url), timeout: 15000,
      env: { OPENDOC_CHILD_CONFIG: JSON.stringify(config), OPENDOC_CHILD_SCHEMA: name, OPENDOC_CHILD_LOOKUP: JSON.stringify(lookup) }
    });
    assert.deepEqual(JSON.parse(stdout), expected);
  });

  for (const ending of ['COMMIT', 'ROLLBACK']) {
    await t.test(`fresh authorization waits for an unsettled revocation's ${ending} instead of reading stale access`, async () => {
      const { name, a } = await create();
      await a.provisionAccount(provision);
      const writer = await poolA.connect();
      let transactionOpen = false, readResult;
      try {
        const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        transactionOpen = true;
        await writer.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await writer.query(`SELECT singleton FROM "${name}".account_state WHERE singleton = true FOR UPDATE`);
        await writer.query(`DELETE FROM "${name}".memberships WHERE tenant_id = $1 AND principal_id = $2`, ['tenant-a', 'principal-a']);
        await writer.query(`UPDATE "${name}".account_state SET membership_count = membership_count - 1, byte_count = byte_count - $1 WHERE singleton = true`,
          ['tenant-a'.length + 'principal-a'.length + 'editor'.length]);
        let readerPid;
        const observedPool = { async connect() {
          const client = await poolB.connect();
          readerPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          return client;
        } };
        let settled = false;
        readResult = new PostgresAccountStore({ pool: observedPool, schema: name }).resolveMembership(lookup)
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
        assert.equal(settled, false, 'No access decision may escape before a pending earlier writer settles');
        assert.equal(blocked, true, 'PostgreSQL must confirm this reader is blocked by the pending writer');
        await writer.query(ending); transactionOpen = false;
        const result = await readResult;
        if (result.error) throw result.error;
        assert.deepEqual(result.value, ending === 'COMMIT' ? null : expected);
      } finally {
        let discard = false;
        if (transactionOpen) { try { await writer.query('ROLLBACK'); } catch { discard = true; } }
        writer.release(discard);
        if (readResult) await readResult;
      }
    });
  }

  await t.test('uncertain COMMIT is never replayed and a fresh lookup observes the actual grant or revocation', async () => {
    const { name, a } = await create();
    let commits = 0;
    const unreliable = { async connect() {
      const client = await poolB.connect();
      return { async query(sql, values) {
        const result = await client.query(sql, values);
        if (sql === 'COMMIT') { commits++; throw new Error('Synthetic lost COMMIT reply with private identity details'); }
        return result;
      }, release(discard) { client.release(discard); } };
    } };
    const uncertain = new PostgresAccountStore({ pool: unreliable, schema: name });
    await assert.rejects(uncertain.provisionAccount(provision), rejects('DEPENDENCY_UNAVAILABLE'));
    assert.equal(commits, 1); assert.deepEqual(await a.resolveMembership(lookup), expected);
    await assert.rejects(uncertain.revokeMembership({ principalId: 'principal-a', tenantId: 'tenant-a' }), rejects('DEPENDENCY_UNAVAILABLE'));
    assert.equal(commits, 2); assert.equal(await a.resolveMembership(lookup), null);
    assert.deepEqual((await poolA.query(`SELECT principal_count, identity_binding_count, membership_count FROM "${name}".account_state`)).rows[0],
      { principal_count: '1', identity_binding_count: '1', membership_count: '0' });
  });
});
