// Opt-in actual PostgreSQL + actual local oidc-provider + browser BFF network
// integration. Synthetic loopback target only; no ambient/remote database use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { PostgresAccountStore, initializePostgresAccountSchema } from '../src/account-store.mjs';
import { createBrowserOidc } from '../src/browser-oidc.mjs';
import { MemoryDocumentStore } from '../src/memory-store.mjs';
import { startLoopbackApp, startSyntheticProvider, NetworkCookieJar, authorizeAtProvider } from '../test/fixtures/oidc-provider.mjs';

function testTarget(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('A synthetic local PostgreSQL test URL is required'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/opendoc_test' || url.username !== 'opendoc_test' || url.password !== 'synthetic-test-only' || url.search || url.hash) {
    throw new Error('Refusing a database target outside the synthetic local opendoc_test contract');
  }
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local test port');
  return { host: url.hostname === '[::1]' ? '::1' : '127.0.0.1', port, user: 'opendoc_test', password: 'synthetic-test-only', database: 'opendoc_test',
    ssl: false, options: '-c search_path=pg_catalog', application_name: 'opendoc-browser-synthetic-integration',
    max: 1, connectionTimeoutMillis: 3000, query_timeout: 10000, statement_timeout: 8000, idle_in_transaction_session_timeout: 8000 };
}
function expectedServerAddresses(raw) {
  if (raw === undefined) return ['127.0.0.1', '::1'];
  if (typeof raw !== 'string' || isIP(raw) === 0 || raw.includes('%')) throw new Error('The expected PostgreSQL server address must be one exact IP address');
  return [raw];
}

test('browser account harness rejects remote, ambient, option-bearing and non-synthetic database targets before connecting', () => {
  for (const value of [undefined, '', 'postgres://prod.example.test/opendoc_test',
    'postgres://opendoc_test:synthetic-test-only@127.0.0.1/production',
    'postgres://opendoc_test:synthetic-test-only@127.0.0.1/opendoc_test?host=remote.example.test',
    'postgres://opendoc_test:synthetic-test-only@127.0.0.1/opendoc_test#ignored',
    'postgres://postgres:real-secret@127.0.0.1/opendoc_test']) assert.throws(() => testTarget(value));
  assert.equal(testTarget('postgres://opendoc_test:synthetic-test-only@127.0.0.1:55432/opendoc_test').port, 55432);
  assert.deepEqual(expectedServerAddresses(undefined), ['127.0.0.1', '::1']);
  assert.deepEqual(expectedServerAddresses('172.18.0.2'), ['172.18.0.2']);
  for (const value of ['', '*', 'localhost', '172.18.0.0/16', '172.18.0.2,172.18.0.3', '[::1]', 'fe80::1%eth0']) assert.throws(() => expectedServerAddresses(value));
});

test('real PostgreSQL accounts drive real OIDC browser sessions without automatic enrollment', {
  skip: process.env.OPENDOC_PG_INTEGRATION !== '1' ? 'Set OPENDOC_PG_INTEGRATION=1 and a synthetic loopback DATABASE_URL to opt in' : false,
  timeout: 90000
}, async t => {
  const config = testTarget(process.env.DATABASE_URL);
  const expectedAddresses = expectedServerAddresses(process.env.OPENDOC_PG_EXPECTED_SERVER_ADDRESS);
  const { Pool } = await import('pg');
  const adminPool = new Pool(config); let readPool = new Pool(config);
  const pools = new Set([adminPool, readPool]);
  const schema = `opendoc_browser_test_${randomBytes(12).toString('hex')}`;
  let createdSchema = false, app, provider; const authenticators = [];
  t.after(async () => {
    for (const auth of authenticators) auth.close();
    await Promise.all([app?.close(), provider?.close()]);
    try {
      if (createdSchema) {
        // Only this successfully created schema and its known tables. No CASCADE.
        for (const table of ['memberships', 'identity_bindings', 'principals', 'account_state']) await adminPool.query(`DROP TABLE "${schema}".${table}`);
        await adminPool.query(`DROP SCHEMA "${schema}"`);
      }
    } finally { await Promise.all([...pools].map(pool => pool.end())); }
  });
  async function verify(pool) {
    const { rows } = await pool.query('SELECT current_database() AS database, current_user AS username, host(inet_server_addr()) AS address, pg_backend_pid() AS pid');
    assert.equal(rows[0].database, 'opendoc_test'); assert.equal(rows[0].username, 'opendoc_test');
    assert.ok(expectedAddresses.includes(rows[0].address), 'The connected PostgreSQL server must report the explicitly expected address');
    return rows[0].pid;
  }
  assert.notEqual(await verify(adminPool), await verify(readPool), 'Independent admin and authentication connections required');
  await initializePostgresAccountSchema({ pool: adminPool, schema }); createdSchema = true;
  const admin = new PostgresAccountStore({ pool: adminPool, schema });
  let accounts = new PostgresAccountStore({ pool: readPool, schema });
  const documents = new MemoryDocumentStore();
  app = await startLoopbackApp(); provider = await startSyntheticProvider({ redirectUri: `${app.origin}/auth/callback` });
  const mapping = { issuer: provider.issuer, subject: 'synthetic-editor', principalId: 'durable-editor', tenantId: 'team-a', role: 'editor' };
  const configure = activeTenantId => {
    const auth = createBrowserOidc({ ...provider, redirectUri: `${app.origin}/auth/callback`, activeTenantId, allowInsecureLoopback: true,
      resolveMembership: input => accounts.resolveMembership(input) });
    authenticators.push(auth); app.setHandler(auth.createHandler({ store: documents })); return auth;
  };
  let auth = configure('team-a');
  async function login(subject = 'synthetic-editor') {
    const jar = new NetworkCookieJar();
    const begin = await jar.fetch(`${app.origin}/auth/login`, { method: 'POST', headers: { origin: app.origin, 'content-type': 'application/json', 'x-opendoc-login': '1' }, body: '{}' });
    assert.equal(begin.status, 200);
    const callback = await authorizeAtProvider({ provider, jar, authorizationUrl: (await begin.json()).authorizationUrl, subject });
    const response = await jar.fetch(callback);
    return { jar, response };
  }
  const session = jar => jar.fetch(`${app.origin}/auth/session`);
  const write = (jar, csrfToken, id) => jar.fetch(`${app.origin}/api/v1/documents`, { method: 'POST',
    headers: { origin: app.origin, 'content-type': 'application/json', 'x-opendoc-csrf': csrfToken },
    body: JSON.stringify({ id, title: 'Synthetic browser+database integration', content: '# Synthetic only' }) });

  await t.test('genuine provider identities do not create missing principals or memberships', async () => {
    const unmapped = await login(); assert.equal(unmapped.response.status, 403);
    assert.equal((await session(unmapped.jar)).status, 401);
    const { rows } = await adminPool.query(`SELECT principal_count, identity_binding_count, membership_count FROM "${schema}".account_state`);
    assert.deepEqual(rows[0], { principal_count: '0', identity_binding_count: '0', membership_count: '0' });
    assert.equal(auth.stats().sessions, 0);
  });

  await admin.provisionAccount(mapping);
  let signedIn = await login(); assert.equal(signedIn.response.status, 303);
  let identity = await (await session(signedIn.jar)).json();
  await t.test('explicit durable issuer/subject mapping controls the principal, active tenant and REST role', async () => {
    assert.equal(identity.principalId, 'durable-editor'); assert.equal(identity.tenantId, 'team-a'); assert.equal(identity.role, 'editor');
    assert.equal((await write(signedIn.jar, identity.csrfToken, 'durable-mapping')).status, 201);
    assert.equal((await login('synthetic-unmapped')).response.status, 403);
    const { rows } = await adminPool.query(`SELECT principal_count, identity_binding_count, membership_count FROM "${schema}".account_state`);
    assert.deepEqual(rows[0], { principal_count: '1', identity_binding_count: '1', membership_count: '1' });
  });

  await t.test('account mapping survives a connection-pool restart and is re-read by an existing session', async () => {
    await readPool.end(); pools.delete(readPool);
    readPool = new Pool(config); pools.add(readPool); await verify(readPool);
    accounts = new PostgresAccountStore({ pool: readPool, schema });
    assert.equal((await session(signedIn.jar)).status, 200);
    assert.equal((await login()).response.status, 303);
  });

  await t.test('separate admin connection can downgrade and revoke an already-issued session immediately', async () => {
    await admin.setMembership({ principalId: mapping.principalId, tenantId: mapping.tenantId, role: 'viewer' });
    const downgraded = await (await session(signedIn.jar)).json(); assert.equal(downgraded.role, 'viewer');
    assert.equal((await write(signedIn.jar, identity.csrfToken, 'must-not-exist')).status, 403);
    await admin.revokeMembership({ principalId: mapping.principalId, tenantId: mapping.tenantId });
    assert.equal((await session(signedIn.jar)).status, 401);
    await admin.setMembership({ principalId: mapping.principalId, tenantId: mapping.tenantId, role: 'editor' });
    assert.equal((await session(signedIn.jar)).status, 401, 'Restoring membership never revives an invalidated session');
    signedIn = await login(); assert.equal(signedIn.response.status, 303); identity = await (await session(signedIn.jar)).json();
    assert.equal(await documents.get('team-a', 'must-not-exist'), null);
  });

  await t.test('another active tenant requires its own explicit membership even for a mapped subject', async () => {
    const originalAuth = auth; auth = configure('team-b');
    assert.equal((await login()).response.status, 403);
    assert.equal(auth.stats().sessions, 0);
    auth.close(); auth = originalAuth; app.setHandler(auth.createHandler({ store: documents }));
    assert.equal((await session(signedIn.jar)).status, 200);
  });

  await t.test('schema mismatch fails closed with a sanitized dependency response', async () => {
    await adminPool.query(`UPDATE "${schema}".account_state SET schema_version = 99`);
    const failed = await session(signedIn.jar); assert.equal(failed.status, 503);
    const text = await failed.text(); assert.ok(!text.includes(schema)); assert.ok(!text.includes('SELECT')); assert.ok(!text.includes('synthetic-test-only'));
    assert.equal(JSON.parse(text).error.code, 'DEPENDENCY_UNAVAILABLE');
    await adminPool.query(`UPDATE "${schema}".account_state SET schema_version = 1`);
    assert.equal((await session(signedIn.jar)).status, 200);
  });

  await t.test('deactivating the durable principal denies all existing and new browser sessions', async () => {
    await admin.setPrincipalActive({ principalId: mapping.principalId, active: false });
    assert.equal((await session(signedIn.jar)).status, 401);
    assert.equal((await login()).response.status, 403);
    assert.equal((await documents.list('team-a')).length, 1);
  });
});
