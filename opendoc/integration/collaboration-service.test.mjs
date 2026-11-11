import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { test } from 'node:test';
import pg from 'pg';
import * as Y from 'yjs';
import { WebSocket } from 'ws';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccessTokenAuthenticator } from '../src/access-token-auth.mjs';
import { initializePostgresCollaborationSchema, PostgresCollaborationStore } from '../src/collaboration-store.mjs';
import { startLocalCollaborationServer } from '../src/collaboration-server.mjs';
import { encodeUpdateFrame, decodeStateFrame } from '../src/collaboration-client.mjs';

const enabled = process.env.OPENDOC_PG_INTEGRATION === '1';
const origin = 'https://editor.example.test';
function testTarget() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  const expectedAddress = process.env.OPENDOC_PG_EXPECTED_SERVER_ADDRESS ?? '127.0.0.1';
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
      url.pathname !== '/opendoc_test' || url.username !== 'opendoc_test' ||
      decodeURIComponent(url.password) !== 'synthetic-test-only' || url.search || url.hash ||
      !isIP(expectedAddress) || expectedAddress.includes('%')) {
    throw new Error('Requires an explicit synthetic loopback database and exact expected server IP');
  }
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid test port');
  return { expectedAddress, config: { host: '127.0.0.1', port, user: 'opendoc_test', password: 'synthetic-test-only',
    database: 'opendoc_test', ssl: false, options: '-c search_path=pg_catalog', max: 6,
    connectionTimeoutMillis: 5000, query_timeout: 10000, statement_timeout: 8000, idle_in_transaction_session_timeout: 8000 } };
}

// This deliberately uses real sockets rather than mocking the transport. A
// retained Y.Doc models local edits during disconnection; it is not a UI test.
function connect(base, token, doc = new Y.Doc(), room = 'shared') {
  const ws = new WebSocket(`${base}/api/v1/collaboration/${room}`, { origin, perMessageDeflate: false });
  const state = { ws, doc, revision: -1, frames: 0, ready: false, closed: false, closeCode: null, error: null };
  const waiters = new Set();
  function notify() { for (const fn of [...waiters]) fn(); }
  ws.on('open', () => ws.send(JSON.stringify({ type: 'authenticate', token })));
  ws.on('message', (bytes, binary) => {
    try {
      if (!binary) {
        const value = JSON.parse(bytes.toString());
        assert.equal(value.type, 'ready'); assert.equal(value.protocol, 'opendoc-yjs-1');
        state.ready = true;
      } else {
        const value = decodeStateFrame(bytes);
        assert.ok(value.revision >= state.revision, 'server state revisions must not move backwards');
        Y.applyUpdate(doc, value.state);
        state.revision = value.revision; state.frames++;
      }
    } catch (error) { state.error = error; }
    notify();
  });
  ws.on('error', error => { state.error = error; notify(); });
  ws.on('close', code => { state.closed = true; state.closeCode = code; notify(); });
  state.wait = (predicate, description = 'socket state') => new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${description}`)), 10000);
    const check = () => {
      if (state.error) finish(state.error);
      else if (predicate(state)) finish();
    };
    function finish(error) { clearTimeout(timer); waiters.delete(check); error ? reject(error) : resolve(state); }
    waiters.add(check); check();
  });
  state.send = update => ws.send(encodeUpdateFrame(update));
  state.close = async () => { if (!state.closed) ws.close(); await state.wait(s => s.closed, 'close'); };
  return state;
}
const text = client => client.doc.getText('content').toString();

// @spec OD-COLLAB-001, OD-COLLAB-002, OD-COLLAB-003, OD-COLLAB-004, OD-COLLAB-005
test('real signed-token WebSockets merge edits, isolate tenants, reconnect and survive service/pool restart', { skip: !enabled, timeout: 60000 }, async t => {
  const { config, expectedAddress } = testTarget();
  const schema = `opendoc_live_${randomUUID().replaceAll('-', '')}`;
  let pool = new pg.Pool(config);
  let server;
  let initialized = false;
  const clients = [];
  const docs = new Set();
  t.after(async () => {
    for (const client of clients) { client.ws.terminate(); docs.add(client.doc); }
    try {
      await server?.close();
      if (initialized) await pool.query(`DROP TABLE "${schema}".collaboration_rooms; DROP TABLE "${schema}".collaboration_state; DROP SCHEMA "${schema}"`);
    } finally { await pool.end(); for (const doc of docs) doc.destroy(); }
  });
  const identity = await pool.query('SELECT current_database() AS db, current_user AS username, host(inet_server_addr()) AS address');
  assert.deepEqual(identity.rows[0], { db: 'opendoc_test', username: 'opendoc_test', address: expectedAddress });
  await initializePostgresCollaborationSchema({ pool, schema }); initialized = true;
  const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
  const key = await exportJWK(publicKey); key.kid = 'synthetic-collaboration';
  const issuer = 'https://issuer.example.test'; const audience = 'urn:example:opendoc:collaboration';
  const members = new Map([
    ['alice', { principalId: 'alice', tenantId: 'tenant-a', role: 'editor' }],
    ['bob', { principalId: 'bob', tenantId: 'tenant-a', role: 'editor' }],
    ['reader', { principalId: 'reader', tenantId: 'tenant-a', role: 'viewer' }],
    ['revocable', { principalId: 'revocable', tenantId: 'tenant-a', role: 'viewer' }],
    ['short-lived', { principalId: 'short-lived', tenantId: 'tenant-a', role: 'viewer' }],
    ['charlie', { principalId: 'charlie', tenantId: 'tenant-b', role: 'editor' }]
  ]);
  const validators = ['tenant-a', 'tenant-b'].map(activeTenantId => createAccessTokenAuthenticator({
    issuer, audience, algorithms: ['RS256'], jwks: { keys: [key] }, activeTenantId,
    resolveMembership: async ({ subject, activeTenantId: tenantId }) => {
      const member = members.get(subject); return member?.tenantId === tenantId ? member : null;
    }
  }));
  const authenticate = async request => await validators[0](request) ?? await validators[1](request);
  const token = async (subject, expiresIn = 300, typ = 'at+jwt') => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ role: 'owner', tenantId: 'untrusted-client-claim' })
      .setProtectedHeader({ alg: 'RS256', typ, kid: key.kid }).setIssuer(issuer).setAudience(audience)
      .setSubject(subject).setIssuedAt(now).setExpirationTime(now + expiresIn).sign(privateKey);
  };
  const start = () => startLocalCollaborationServer({ store: new PostgresCollaborationStore({ pool, schema }),
    authenticate, allowedOrigins: [origin], limits: { revalidationIntervalMs: 100 } });
  server = await start();
  const join = async (subject, doc, room, credential) => {
    const client = connect(server.url, credential ?? await token(subject), doc, room); clients.push(client);
    await client.wait(c => c.ready && c.revision >= 0, 'authenticated snapshot'); return client;
  };
  let alice = await join('alice');
  assert.equal(alice.revision, 0);
  alice.doc.getText('content').insert(0, 'seed'); alice.send(Y.encodeStateAsUpdate(alice.doc));
  await alice.wait(c => c.revision === 1, 'durable first update');
  let bob = await join('bob'); assert.equal(text(bob), 'seed');
  const reader = await join('reader'); assert.equal(text(reader), 'seed');
  const outsider = await join('charlie'); assert.equal(outsider.revision, 0); assert.equal(text(outsider), '');
  const otherRoom = await join('alice', undefined, 'another-room'); assert.equal(otherRoom.revision, 0);
  await otherRoom.close();

  // Two disconnected clients edit the same baseline, then independently merge
  // with committed server state. Full replay is idempotent, never REST overwrite.
  await alice.close(); await bob.close();
  alice.doc.getText('content').insert(0, 'A'); bob.doc.getText('content').insert(4, 'B');
  alice = await join('alice', alice.doc); alice.send(Y.encodeStateAsUpdate(alice.doc));
  await alice.wait(c => c.revision === 2, 'first offline edit');
  bob = await join('bob', bob.doc); bob.send(Y.encodeStateAsUpdate(bob.doc));
  await Promise.all([alice.wait(c => text(c) === 'AseedB', 'offline convergence'), bob.wait(c => c.revision === 3, 'second offline edit'), reader.wait(c => text(c) === 'AseedB', 'read-only convergence')]);
  const aliceVector = Y.encodeStateVector(alice.doc); const bobVector = Y.encodeStateVector(bob.doc);
  alice.doc.getText('content').insert(0, 'X'); bob.doc.getText('content').insert(6, 'Y');
  alice.send(Y.encodeStateAsUpdate(alice.doc, aliceVector)); bob.send(Y.encodeStateAsUpdate(bob.doc, bobVector));
  await Promise.all([alice.wait(c => c.revision === 5 && text(c) === 'XAseedBY', 'concurrent edits'), bob.wait(c => c.revision === 5 && text(c) === 'XAseedBY', 'concurrent convergence')]);
  const frames = alice.frames; alice.send(Y.encodeStateAsUpdate(alice.doc));
  await alice.wait(c => c.frames > frames, 'duplicate replay acknowledgment'); assert.equal(alice.revision, 5);
  assert.equal(text(outsider), ''); assert.equal(outsider.revision, 0);
  // A forged owner role in the JWT cannot turn server-owned viewer membership into a writer.
  reader.doc.getText('content').insert(0, 'forbidden'); reader.send(Y.encodeStateAsUpdate(reader.doc));
  await reader.wait(c => c.closed, 'read-only denial'); assert.equal(reader.closeCode, 1008);
  const revocable = await join('revocable'); const beforeRevocation = text(revocable);
  members.delete('revocable');
  const vector = Y.encodeStateVector(alice.doc); alice.doc.getText('content').insert(alice.doc.getText('content').length, '!');
  alice.send(Y.encodeStateAsUpdate(alice.doc, vector));
  await Promise.all([alice.wait(c => c.revision === 6, 'post-revocation commit'), revocable.wait(c => c.closed, 'membership revocation')]);
  assert.equal(text(revocable), beforeRevocation, 'revoked reader must not receive a later snapshot');
  const expiring = await join('short-lived', undefined, undefined, await token('short-lived', 2));
  await expiring.wait(c => c.closed, 'expired token disconnection'); assert.equal(expiring.closeCode, 1008);
  for (const [subject, credential] of [['missing', await token('missing')], ['alice', await token('alice', 300, 'JWT')]]) {
    const rejected = connect(server.url, credential); clients.push(rejected);
    await rejected.wait(c => c.closed, `${subject} credential rejection`); assert.equal(rejected.ready, false); assert.equal(rejected.frames, 0);
  }

  const expected = text(alice); assert.equal(expected, 'XAseedBY!');
  await server.close(); server = undefined;
  await pool.end(); pool = new pg.Pool(config);
  server = await start();
  const reopened = await join('alice'); assert.equal(text(reopened), expected); assert.equal(reopened.revision, 6);
  const reopenedOther = await join('charlie'); assert.equal(text(reopenedOther), ''); assert.equal(reopenedOther.revision, 0);
});
