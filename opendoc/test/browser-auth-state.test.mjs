import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createBrowserOidc, BROWSER_OIDC_LIMITS } from '../src/browser-oidc.mjs';
import { BrowserAuthStateError, MemoryBrowserAuthState } from '../src/browser-auth-state.mjs';
import { PostgresBrowserAuthState } from '../src/postgres-browser-auth-state.mjs';

const binding = 'a'.repeat(64), limits = BROWSER_OIDC_LIMITS;
const secret = () => randomBytes(32).toString('base64url');
const config = { issuer: 'https://identity.example.test', clientId: 'client', clientAuthentication: { method: 'none' },
  redirectUri: 'https://opendoc.example.test/auth/callback', authorizationEndpoint: 'https://identity.example.test/auth',
  tokenEndpoint: 'https://identity.example.test/token', jwksUri: 'https://identity.example.test/jwks',
  activeTenantId: 'team', resolveMembership: async () => null };
const request = (body = '{}') => new Request('https://opendoc.example.test/auth/login', { method: 'POST', body,
  headers: { origin: 'https://opendoc.example.test', 'content-type': 'application/json', 'x-opendoc-login': '1' } });
const unavailable = error => error instanceof BrowserAuthStateError && error.code === 'DEPENDENCY_UNAVAILABLE' && error.message === error.code && error.cause === undefined;

function session(state) {
  const intentId = secret(), transactionId = secret(), claimId = secret(), sessionId = secret(), version = secret();
  state.run('beginLogin', { intentId });
  state.run('publishLogin', { intentId, transactionId, transaction: { state: secret(), verifier: secret(), nonce: secret() } });
  state.run('consumeTransaction', { id: transactionId, claimId });
  state.run('finishCallback', { id: transactionId, claimId, sessionId, tokenExpiresAt: Date.now() + 60000,
    session: { version, csrfToken: secret(), subject: 'synthetic', principalId: 'principal' } });
  return { sessionId, version };
}

test('memory operations use snapshots and opaque versions rather than reference identity', () => {
  const state = new MemoryBrowserAuthState(); state.configure({ binding, limits });
  const { sessionId, version } = session(state);
  const first = state.run('getSession', { id: sessionId }); first.subject = 'attacker';
  const second = state.run('getSession', { id: sessionId }); assert.equal(second.subject, 'synthetic'); assert.notEqual(first, second);
  assert.equal(state.run('removeSession', { id: sessionId, version: secret() }), false);
  assert.equal(state.run('checkSession', { id: sessionId, version }), true);
  assert.equal(state.run('removeSession', { id: sessionId, version }), true);
  assert.equal(state.run('checkSession', { id: sessionId, version }), false);
});

test('intent expiry is bounded and a refused publication never restores expired work', async () => {
  const state = new MemoryBrowserAuthState(); state.configure({ binding, limits: { ...limits, operationTimeoutMs: 10, maxTransactions: 1 } });
  const intentId = secret(); state.run('beginLogin', { intentId });
  assert.throws(() => state.run('beginLogin', { intentId: secret() }), { code: 'CAPACITY_EXCEEDED' });
  await delay(15);
  assert.throws(() => state.run('publishLogin', { intentId, transactionId: secret(), transaction: {} }), { code: 'UNAUTHENTICATED' });
  assert.equal(state.run('stats').intents, 0);
});

test('state policy is pinned and rejects unbounded quotas', () => {
  const state = new MemoryBrowserAuthState();
  state.configure({ binding, limits }); state.configure({ binding, limits });
  assert.throws(() => state.configure({ binding: 'b'.repeat(64), limits }));
  assert.throws(() => new MemoryBrowserAuthState().configure({ binding, limits: { ...limits, maxTransactions: 1001 } }));
  for (const authState of [{}, null, false]) assert.throws(() => createBrowserOidc({ ...config, authState }));
});

test('cleanup timeout returns promptly and retains admission until underlying cleanup settles', async () => {
  const underlying = new MemoryBrowserAuthState(); let release;
  const authState = { configure: options => underlying.configure(options), run(operation, input, guard) {
    if (operation === 'abortLogin') return new Promise(resolve => { release = () => resolve(underlying.run(operation, input, guard)); });
    return underlying.run(operation, input, guard);
  } };
  const browser = createBrowserOidc({ ...config, authState, limits: { operationTimeoutMs: 30, maxPendingOperations: 1 } });
  const result = await browser.handleAuth(request('{"invalid":true}'));
  assert.equal(result.status, 503); assert.equal(browser.stats().pendingOperations, 1);
  assert.equal((await browser.handleAuth(request())).status, 429);
  release(); await delay(1); assert.equal(browser.stats().pendingOperations, 0); browser.close();
});

test('PostgreSQL construction is inert and requires namespace, key and bounded timeout', async () => {
  let calls = 0; const pool = { connect() { calls++; throw new Error('private database error'); } };
  for (const schema of ['public', 'pg_auth', 'information_schema', 'quoted"name', 'name\n', '']) assert.throws(() => new PostgresBrowserAuthState({ pool, schema, encryptionKey: randomBytes(32) }));
  for (const encryptionKey of [undefined, 'not-a-key', randomBytes(31)]) assert.throws(() => new PostgresBrowserAuthState({ pool, schema: 'opendoc_auth', encryptionKey }));
  assert.throws(() => new PostgresBrowserAuthState({ pool, schema: 'opendoc_auth', encryptionKey: randomBytes(32), queryTimeoutMs: 10001 }));
  const state = new PostgresBrowserAuthState({ pool, schema: 'opendoc_auth', encryptionKey: randomBytes(32) });
  assert.equal(calls, 0); await assert.rejects(state.initialize(), TypeError);
  state.configure({ binding, limits }); await assert.rejects(state.run('stats'), unavailable); assert.equal(calls, 1);
});

test('database, rollback and release failures are sanitized and never implicitly retried', async () => {
  for (const failure of ['begin', 'query', 'rollback', 'release']) {
    const queries = [], releases = [];
    const client = { async query(sql) {
      queries.push(sql);
      if (failure === 'begin' && sql.startsWith('BEGIN') || failure === 'rollback' && sql === 'ROLLBACK' || sql.includes('FOR UPDATE')) throw new Error('password=PRIVATE_DB_SECRET');
      return { rows: [] };
    }, release(discard) { releases.push(discard); if (failure === 'release') throw new Error('PRIVATE_RELEASE_SECRET'); } };
    const state = new PostgresBrowserAuthState({ pool: { connect: async () => client }, schema: 'opendoc_auth', encryptionKey: randomBytes(32) });
    state.configure({ binding, limits }); await assert.rejects(state.run('stats'), unavailable);
    assert.equal(queries.filter(sql => sql.startsWith('BEGIN')).length, 1);
    assert.equal(queries.filter(sql => sql === 'ROLLBACK').length, 1);
    assert.deepEqual(releases, [failure === 'rollback']);
  }
});

test('missing/mismatched schema metadata fails closed before reading encrypted records', async () => {
  for (const rows of [[], [{ schema_version: 99 }], [{ schema_version: 1, key_check: Buffer.alloc(32), policy: { binding, limits } }]]) {
    const queries = [];
    const state = new PostgresBrowserAuthState({ pool: { connect: async () => ({
      query: async sql => { queries.push(sql); return { rows: sql.includes('FOR UPDATE') ? rows : [] }; }, release() {}
    }) }, schema: 'opendoc_auth', encryptionKey: randomBytes(32) });
    state.configure({ binding, limits }); await assert.rejects(state.run('stats'), unavailable);
    assert.equal(queries.some(sql => sql.includes('FROM "opendoc_auth".browser_auth_records')), false);
  }
});
