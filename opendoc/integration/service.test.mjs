import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createOpenDocHandler } from '../src/api.mjs';
import { createAccessTokenAuthenticator } from '../src/access-token-auth.mjs';
import { initializePostgresSchema, PostgresDocumentStore } from '../src/postgres-store.mjs';
import { startLocalServer } from '../src/node-adapter.mjs';

const enabled = process.env.OPENDOC_PG_INTEGRATION === '1';
function isolatedTestConfig() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
    url.pathname !== '/opendoc_test' || url.username !== 'opendoc_test' ||
    decodeURIComponent(url.password) !== 'synthetic-test-only' || url.search || url.hash) {
    throw new Error('HTTP integration requires the explicit loopback opendoc_test database and synthetic credentials');
  }
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid synthetic local port');
  return { host: '127.0.0.1', port, user: 'opendoc_test', password: 'synthetic-test-only', database: 'opendoc_test',
    ssl: false, options: '-c search_path=pg_catalog', max: 4, connectionTimeoutMillis: 5000,
    query_timeout: 10000, statement_timeout: 8000, idle_in_transaction_session_timeout: 8000 };
}

// @spec OD-PG-002, OD-PG-003, OD-PG-005, OD-AUTH-001, OD-AUTH-002
test('real HTTP composes pinned token auth, trusted membership and persistent PostgreSQL revisions', { skip: !enabled }, async t => {
  const config = isolatedTestConfig();
  const schema = `opendoc_http_${randomUUID().replaceAll('-', '')}`;
  let pool = new pg.Pool(config);
  let server;
  let otherServer;
  let initialized = false;
  t.after(async () => {
    try {
      await server?.close(); await otherServer?.close();
      // This generated schema is created only by this test. Never drop the database.
      if (initialized) await pool.query(`DROP TABLE "${schema}".documents; DROP TABLE "${schema}".store_state; DROP SCHEMA "${schema}"`);
    } finally { await pool.end(); }
  });
  await initializePostgresSchema({ pool, schema }); initialized = true;
  const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey); jwk.kid = 'synthetic-integration';
  const issuer = 'https://issuer.example.test';
  const audience = 'urn:example:opendoc:test';
  const token = (subject, typ = 'at+jwt', expiresIn = 300) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ roles: ['owner'], tenantId: 'not-trusted' })
      .setProtectedHeader({ alg: 'RS256', typ, kid: jwk.kid }).setIssuer(issuer).setAudience(audience)
      .setSubject(subject).setIssuedAt(now).setExpirationTime(now + expiresIn).sign(privateKey);
  };
  const authenticator = activeTenantId => createAccessTokenAuthenticator({
    issuer, audience, algorithms: ['RS256'], jwks: { keys: [jwk] }, activeTenantId,
    resolveMembership: async ({ subject, activeTenantId: tenantId }) =>
      ['alice', 'reader'].includes(subject) ? { principalId: subject, tenantId, role: subject === 'reader' ? 'viewer' : 'editor' } : null
  });
  const start = tenantId => startLocalServer({ port: 0, handle: createOpenDocHandler({
    store: new PostgresDocumentStore({ pool, schema }), authenticate: authenticator(tenantId)
  }) });
  server = await start('tenant-a');
  const alice = await token('alice'); const reader = await token('reader');
  const request = (target, path, credential, method = 'GET', body, etag) => fetch(target.url + path, {
    method, headers: { authorization: `Bearer ${credential}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(etag ? { 'if-match': etag } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const doc = { id: 'brief', title: 'Synthetic integration', content: '# Opaque\r\n\u0000\ud800🌿' };
  let response = await request(server, '/api/v1/documents', alice, 'POST', doc);
  assert.equal(response.status, 201); assert.equal(response.headers.get('etag'), '"1"');
  assert.equal((await response.json()).content, doc.content);
  assert.equal((await request(server, '/api/v1/documents/brief', reader, 'PUT', { title: 'denied', content: '' }, '"1"')).status, 403);
  assert.equal((await request(server, '/api/v1/documents', await token('outsider'))).status, 401);
  assert.equal((await request(server, '/api/v1/documents', await token('alice', 'JWT'))).status, 401);
  assert.equal((await request(server, '/api/v1/documents', await token('alice', 'at+jwt', -1))).status, 401);
  otherServer = await start('tenant-b');
  assert.equal((await request(otherServer, '/api/v1/documents/brief', alice)).status, 404);
  await otherServer.close(); otherServer = undefined;

  // Restart the HTTP service and connection pool, without recreating the schema.
  await server.close(); server = undefined;
  await pool.end();
  pool = new pg.Pool(config);
  server = await start('tenant-a');
  response = await request(server, '/api/v1/documents/brief', alice);
  assert.equal(response.status, 200); assert.equal((await response.json()).content, doc.content);
  const attempts = await Promise.all(['writer-one', 'writer-two'].map(content => request(server,
    '/api/v1/documents/brief', alice, 'PUT', { title: doc.title, content }, '"1"')));
  assert.deepEqual(attempts.map(r => r.status).sort(), [200, 412]);
  response = await request(server, '/api/v1/documents/brief', alice);
  assert.equal(response.headers.get('etag'), '"2"');
  assert.equal((await response.json()).revision, 2);
  const capabilities = await (await fetch(server.url + '/api/v1/capabilities')).json();
  assert.equal(capabilities.storage, 'postgresql');
  assert.equal(capabilities.features.enterpriseLogin, false);
});
