// Opt-in real PostgreSQL + real local OIDC, including process restarts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createBrowserOidc } from '../src/browser-oidc.mjs';
import { PostgresBrowserAuthState } from '../src/postgres-browser-auth-state.mjs';
import { startLoopbackApp, startSyntheticProvider, NetworkCookieJar, authorizeAtProvider } from '../test/fixtures/oidc-provider.mjs';

function target(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Synthetic local PostgreSQL test URL required'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/opendoc_test' || url.username !== 'opendoc_test' || url.password !== 'synthetic-test-only' || url.search || url.hash) throw new Error('Refusing non-synthetic database target');
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local test port');
  return { host: url.hostname === '[::1]' ? '::1' : '127.0.0.1', port, user: 'opendoc_test', password: 'synthetic-test-only', database: 'opendoc_test',
    ssl: false, options: '-c search_path=pg_catalog', max: 2, connectionTimeoutMillis: 3000, query_timeout: 10000,
    statement_timeout: 8000, idle_in_transaction_session_timeout: 8000 };
}
function addresses(raw) {
  if (raw === undefined) return ['127.0.0.1', '::1'];
  if (typeof raw !== 'string' || isIP(raw) === 0 || raw.includes('%')) throw new Error('Expected server address must be an exact IP');
  return [raw];
}
const secret = () => randomBytes(32).toString('base64url');
const member = { principalId: 'durable-editor', tenantId: 'team-a', role: 'editor' };
const waitFor = async predicate => { const until = Date.now() + 4000; while (!await predicate()) { if (Date.now() > until) throw new Error('Missing checkpoint'); await delay(2); } };
function update(jar, result) {
  for (const cookie of result.headers.getSetCookie()) { const [name, value] = cookie.split(';')[0].split('='); if (value) jar.set(name, value); else jar.delete(name); }
}
const header = jar => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
function subprocess(value) {
  // All sensitive test state goes over stdin, not argv/env or repository files.
  const source = `
    import { Pool } from 'pg';
    import { createBrowserOidc } from './src/browser-oidc.mjs';
    import { PostgresBrowserAuthState } from './src/postgres-browser-auth-state.mjs';
    let text = ''; for await (const chunk of process.stdin) text += chunk;
    const input = JSON.parse(text), pool = new Pool(input.database);
    const state = new PostgresBrowserAuthState({ pool, schema: input.schema, encryptionKey: Buffer.from(input.key, 'base64') });
    const browser = createBrowserOidc({ ...input.browser, authState: state, resolveMembership: async () => input.member });
    try { const result = await browser.handleAuth(new Request(input.url, input.request));
      console.log(JSON.stringify({ status: result.status, cookies: result.headers.getSetCookie(), body: await result.text(), pid: process.pid })); }
    finally { browser.close(); await pool.end(); }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: new URL('..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { errors += b; });
    child.on('error', reject); child.on('exit', code => { if (code !== 0) reject(new Error(`Synthetic child failed: ${errors}`)); else { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } } });
    child.stdin.end(JSON.stringify(value));
  });
}

test('shared auth integration rejects remote, ambient and option-bearing database targets', () => {
  for (const raw of [undefined, '', 'postgres://prod.example.test/opendoc_test', 'postgres://opendoc_test:synthetic-test-only@127.0.0.1/prod',
    'postgres://opendoc_test:synthetic-test-only@127.0.0.1/opendoc_test?host=remote', 'postgres://other:real@localhost/opendoc_test']) assert.throws(() => target(raw));
  assert.equal(target('postgres://opendoc_test:synthetic-test-only@127.0.0.1:55432/opendoc_test').port, 55432);
  for (const raw of ['', '*', 'localhost', '127.0.0.0/8', '::1%eth0']) assert.throws(() => addresses(raw));
});

test('shared browser authentication is durable, atomic, bounded and fail closed', {
  skip: process.env.OPENDOC_PG_INTEGRATION !== '1' ? 'Set OPENDOC_PG_INTEGRATION=1 and synthetic loopback DATABASE_URL' : false, timeout: 90000
}, async t => {
  const database = target(process.env.DATABASE_URL), expected = addresses(process.env.OPENDOC_PG_EXPECTED_SERVER_ADDRESS);
  const { Pool } = await import('pg'); const poolA = new Pool(database), poolB = new Pool(database);
  const schemas = [], browsers = [];
  const app = await startLoopbackApp(), provider = await startSyntheticProvider({ redirectUri: `${app.origin}/auth/callback` });
  const browserConfig = Object.fromEntries(['issuer', 'clientId', 'clientAuthentication', 'authorizationEndpoint', 'tokenEndpoint', 'jwksUri'].map(key => [key, provider[key]]));
  Object.assign(browserConfig, { redirectUri: `${app.origin}/auth/callback`, activeTenantId: 'team-a', allowInsecureLoopback: true });
  t.after(async () => {
    browsers.forEach(browser => browser.close()); await Promise.all([app.close(), provider.close()]);
    try { for (const schema of schemas) { for (const table of ['browser_auth_records', 'browser_auth_state']) await poolA.query(`DROP TABLE "${schema}".${table}`); await poolA.query(`DROP SCHEMA "${schema}"`); } }
    finally { await Promise.all([poolA.end(), poolB.end()]); }
  });
  async function verify(pool) {
    const { rows } = await pool.query('SELECT current_database() AS database, current_user AS username, host(inet_server_addr()) AS address, pg_backend_pid() AS pid');
    assert.equal(rows[0].database, 'opendoc_test'); assert.equal(rows[0].username, 'opendoc_test'); assert.ok(expected.includes(rows[0].address)); return rows[0].pid;
  }
  assert.notEqual(await verify(poolA), await verify(poolB));
  async function setup({ limits = {}, maxBytes, key = randomBytes(32) } = {}) {
    const schema = `opendoc_auth_test_${randomBytes(12).toString('hex')}`;
    let resolverA = async () => member, resolverB = async () => member;
    const stateA = new PostgresBrowserAuthState({ pool: poolA, schema, encryptionKey: key });
    const stateB = new PostgresBrowserAuthState({ pool: poolB, schema, encryptionKey: key });
    const config = { ...browserConfig, limits };
    const a = createBrowserOidc({ ...config, authState: stateA, resolveMembership: value => resolverA(value) });
    const b = createBrowserOidc({ ...config, authState: stateB, resolveMembership: value => resolverB(value) });
    browsers.push(a, b); await stateA.initialize({ maxBytes }); schemas.push(schema);
    const req = (path, jar = new Map(), body, extra = {}) => new Request(new URL(path, app.origin), { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      headers: { cookie: header(jar), ...(body === undefined ? {} : { origin: app.origin, 'content-type': 'application/json' }), ...extra } });
    async function login(browser = a, jar = new Map()) {
      const result = await browser.handleAuth(req('/auth/login', jar, {}, { 'x-opendoc-login': '1' }));
      assert.equal(result.status, 200, await result.clone().text()); update(jar, result);
      const authorizationUrl = (await result.json()).authorizationUrl;
      const callback = await authorizeAtProvider({ provider, jar: new NetworkCookieJar(), authorizationUrl });
      return { jar, callback, authorizationUrl };
    }
    async function complete(browser = a, jar = new Map()) {
      const flow = await login(browser, jar); const response = await browser.handleAuth(req(flow.callback, jar));
      assert.equal(response.status, 303, await response.clone().text()); update(jar, response);
      const session = await (await browser.handleAuth(req('/auth/session', jar))).json(); return { ...flow, response, session };
    }
    const logout = (browser, flow) => browser.handleAuth(req('/auth/logout', flow.jar, {}, { 'x-opendoc-csrf': flow.session.csrfToken }));
    return { a, b, stateA, stateB, config, schema, key, req, login, complete, logout,
      setA: resolver => { resolverA = resolver; }, setB: resolver => { resolverB = resolver; } };
  }

  await t.test('login, callback and session each survive exit into a fresh operating-system process', async () => {
    const f = await setup(), jar = new Map();
    const input = { database, schema: f.schema, key: f.key.toString('base64'), browser: f.config, member };
    const begin = await subprocess({ ...input, url: `${app.origin}/auth/login`, request: { method: 'POST', body: '{}', headers: { origin: app.origin, 'content-type': 'application/json', 'x-opendoc-login': '1' } } });
    assert.equal(begin.status, 200); update(jar, { headers: { getSetCookie: () => begin.cookies } });
    const callback = await authorizeAtProvider({ provider, jar: new NetworkCookieJar(), authorizationUrl: JSON.parse(begin.body).authorizationUrl });
    const finish = await subprocess({ ...input, url: callback, request: { headers: { cookie: header(jar) } } });
    assert.equal(finish.status, 303, finish.body); update(jar, { headers: { getSetCookie: () => finish.cookies } });
    const read = await subprocess({ ...input, url: `${app.origin}/auth/session`, request: { headers: { cookie: header(jar) } } });
    assert.equal(read.status, 200, read.body); assert.equal(JSON.parse(read.body).principalId, member.principalId);
    assert.equal(new Set([begin.pid, finish.pid, read.pid]).size, 3);
    f.a.close(); assert.equal((await f.b.handleAuth(f.req('/auth/session', jar))).status, 200, 'Closing one adapter must not log out shared sessions');
  });

  await t.test('callback on B consumes login from A once; current membership is always resolved', async () => {
    const f = await setup(), flow = await f.login();
    const results = await Promise.all([f.a.handleAuth(f.req(flow.callback, flow.jar)), f.b.handleAuth(f.req(flow.callback, flow.jar))]);
    assert.deepEqual(results.map(r => r.status).sort(), [303, 401]);
    const winner = results.find(r => r.status === 303); update(flow.jar, winner);
    assert.deepEqual(results.find(r => r.status === 401).headers.getSetCookie(), []);
    f.setB(async () => ({ ...member, role: 'viewer' }));
    assert.equal((await (await f.b.handleAuth(f.req('/auth/session', flow.jar))).json()).role, 'viewer');
    f.setB(async () => null); assert.equal((await f.b.handleAuth(f.req('/auth/session', flow.jar))).status, 401);
    assert.equal((await f.a.handleAuth(f.req('/auth/session', flow.jar))).status, 401);
  });

  await t.test('logout on A fences callback and body-stalled login on B without stale cookie deletion', async () => {
    const f = await setup(), signed = await f.complete();
    const flow = await f.login(f.a, new Map(signed.jar));
    let release; f.setB(() => new Promise(resolve => { release = resolve; }));
    const pending = f.b.handleAuth(f.req(flow.callback, flow.jar)); await waitFor(() => release);
    assert.equal((await f.logout(f.a, signed)).status, 204); release(member);
    const stale = await pending; assert.equal(stale.status, 401); assert.deepEqual(stale.headers.getSetCookie(), []);
    assert.equal((await f.a.stats()).sessions, 0);
    f.setB(async () => member); const next = await f.complete();
    let controller;
    const body = new ReadableStream({ start(value) { controller = value; value.enqueue(new TextEncoder().encode('{')); } });
    const slow = f.b.handleAuth(new Request(`${app.origin}/auth/login`, { method: 'POST', duplex: 'half', body,
      headers: { origin: app.origin, 'content-type': 'application/json', 'x-opendoc-login': '1', cookie: header(next.jar) } }));
    await waitFor(async () => (await f.stateA.run('stats')).intents === 1);
    assert.equal((await f.logout(f.a, next)).status, 204); controller.enqueue(new TextEncoder().encode('}')); controller.close();
    const cancelled = await slow; assert.equal(cancelled.status, 401); assert.deepEqual(cancelled.headers.getSetCookie(), []);
    assert.equal((await f.a.stats()).transactions, 0);
  });

  await t.test('a newer anonymous login and authenticated rotation fence older work across adapters', async () => {
    const f = await setup(), first = await f.login();
    let release; f.setB(() => new Promise(resolve => { release = resolve; }));
    const pending = f.b.handleAuth(f.req(first.callback, first.jar)); await waitFor(() => release);
    const next = await f.login(f.a, new Map(first.jar)); release(member);
    const stale = await pending; assert.equal(stale.status, 401); assert.deepEqual(stale.headers.getSetCookie(), []);
    f.setB(async () => member);
    const response = await f.b.handleAuth(f.req(next.callback, next.jar)); assert.equal(response.status, 303); update(next.jar, response);
    const older = await f.login(f.a, new Map(next.jar)); release = undefined;
    f.setB(() => new Promise(resolve => { release = resolve; }));
    const oldCallback = f.b.handleAuth(f.req(older.callback, older.jar)); await waitFor(() => release);
    await f.complete(f.a, new Map(next.jar)); release(member);
    const rotated = await oldCallback; assert.equal(rotated.status, 401); assert.deepEqual(rotated.headers.getSetCookie(), []);
    assert.equal((await f.a.stats()).sessions, 1);
  });

  await t.test('ticket binding is atomic across adapters and logout fences awaited ticket validation', async () => {
    const f = await setup(), flow = await f.complete();
    const issued = await f.a.handleAuth(f.req('/auth/collaboration-ticket', flow.jar, { roomId: 'room' }, { 'x-opendoc-csrf': flow.session.csrfToken }));
    const { ticket } = await issued.json();
    const request = new Request('http://opendoc.invalid/api/v1/collaboration/room', { headers: { origin: app.origin, authorization: `Bearer ${ticket}` } });
    const one = { connectionId: secret() }, two = { connectionId: secret() };
    const results = await Promise.all([f.a.authenticateCollaboration(request, one), f.b.authenticateCollaboration(request, two)]);
    assert.equal(results.filter(Boolean).length, 1);
    const winner = results[0] ? one : two;
    let release; f.setB(() => new Promise(resolve => { release = resolve; }));
    const pending = f.b.authenticateCollaboration(request, winner); await waitFor(() => release);
    assert.equal((await f.logout(f.a, flow)).status, 204); release(member); assert.equal(await pending, null);
    assert.equal((await f.a.stats()).tickets, 0);
  });

  await t.test('durable quotas serialize competing logins and expired records release capacity', async () => {
    const f = await setup({ limits: { maxTransactions: 1, transactionTtlMs: 100 } });
    const results = await Promise.all([f.a.handleAuth(f.req('/auth/login', new Map(), {}, { 'x-opendoc-login': '1' })), f.b.handleAuth(f.req('/auth/login', new Map(), {}, { 'x-opendoc-login': '1' }))]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 429]); assert.equal((await f.b.stats()).transactions, 1);
    await delay(130); assert.equal((await f.a.stats()).transactions, 0);
    assert.equal((await f.b.handleAuth(f.req('/auth/login', new Map(), {}, { 'x-opendoc-login': '1' }))).status, 200);
    const tiny = await setup({ maxBytes: 1 });
    assert.equal((await tiny.a.handleAuth(tiny.req('/auth/login', new Map(), {}, { 'x-opendoc-login': '1' }))).status, 429);
    assert.equal((await tiny.a.stats()).transactions, 0);
  });

  await t.test('database clock is authoritative and plaintext secrets are absent from records', async () => {
    const f = await setup(), flow = await f.complete();
    const sessionId = flow.jar.get(f.a.cookieNames.session), csrfToken = flow.session.csrfToken;
    const pending = await f.login();
    const { rows } = await poolA.query(`SELECT payload, record_key FROM "${f.schema}".browser_auth_records`);
    const bytes = Buffer.concat(rows.flatMap(row => [row.payload, row.record_key]));
    for (const value of [sessionId, csrfToken, pending.jar.get(f.a.cookieNames.transaction), 'synthetic-editor', new URL(pending.authorizationUrl).searchParams.get('nonce')]) assert.equal(bytes.includes(Buffer.from(value)), false);
    const now = Date.now; Date.now = () => now() + 24 * 60 * 60 * 1000;
    try { assert.ok(await f.stateB.run('getSession', { id: sessionId }), 'Application wall clock must not expire shared state'); }
    finally { Date.now = now; }
  });

  await t.test('wrong key, mismatched tenant/client/policy and corrupt ciphertext fail closed', async () => {
    const f = await setup(), flow = await f.complete();
    for (const overrides of [{ activeTenantId: 'team-b' }, { clientId: 'other-client' }, { limits: { sessionTtlMs: 1000 } }, { key: randomBytes(32) }]) {
      const { key = f.key, ...config } = overrides;
      const state = new PostgresBrowserAuthState({ pool: poolB, schema: f.schema, encryptionKey: key });
      const browser = createBrowserOidc({ ...f.config, ...config, authState: state, resolveMembership: async () => member }); browsers.push(browser);
      const result = await browser.handleAuth(f.req('/auth/session', flow.jar)); assert.equal(result.status, 503); assert.deepEqual(result.headers.getSetCookie(), []);
      assert.equal((await result.text()).includes(f.schema), false);
    }
    await assert.rejects(f.stateA.initialize(), { code: 'DEPENDENCY_UNAVAILABLE' });
    const original = await poolA.query(`SELECT record_key, payload FROM "${f.schema}".browser_auth_records WHERE kind = 'sessions'`);
    const corrupt = Buffer.from(original.rows[0].payload); corrupt[30] ^= 1;
    await poolA.query(`UPDATE "${f.schema}".browser_auth_records SET payload = $1 WHERE record_key = $2`, [corrupt, original.rows[0].record_key]);
    assert.equal((await f.b.handleAuth(f.req('/auth/session', flow.jar))).status, 503);
    await poolA.query(`UPDATE "${f.schema}".browser_auth_records SET payload = $1 WHERE record_key = $2`, [original.rows[0].payload, original.rows[0].record_key]);
    assert.equal((await f.a.handleAuth(f.req('/auth/session', flow.jar))).status, 200);
  });

  await t.test('source transaction, initiation and original-session expiry during SQL writes cannot create a new grant', async () => {
    async function delayedState(f, kind, milliseconds) {
      const pool = { async connect() { const client = await poolB.connect(); return {
        async query(sql, values) {
          const result = await client.query(sql, values);
          if (sql.includes('INSERT INTO') && sql.includes('browser_auth_records') && values[0] === kind) await client.query('SELECT pg_sleep($1)', [milliseconds / 1000]);
          return result;
        }, release(discard) { client.release(discard); }
      }; } };
      const state = new PostgresBrowserAuthState({ pool, schema: f.schema, encryptionKey: f.key });
      browsers.push(createBrowserOidc({ ...f.config, authState: state, resolveMembership: async () => member }));
      return state;
    }
    async function prepare(f, priorSessionId) {
      const intentId = secret(), id = secret(), claimId = secret();
      await f.stateA.run('beginLogin', { intentId, priorSessionId });
      await f.stateA.run('publishLogin', { intentId, transactionId: id, transaction: { state: secret(), nonce: secret(), verifier: secret() } });
      await f.stateA.run('consumeTransaction', { id, claimId }); return { id, claimId };
    }
    const grant = () => ({ sessionId: secret(), tokenExpiresAt: Date.now() + 60000,
      session: { version: secret(), subject: 'synthetic-editor', principalId: member.principalId, csrfToken: secret() } });
    const transaction = await setup({ limits: { transactionTtlMs: 200 } });
    const pending = await prepare(transaction), transactionState = await delayedState(transaction, 'sessions', 250);
    await assert.rejects(transactionState.run('finishCallback', { ...pending, ...grant() }), { code: 'UNAUTHENTICATED' });
    assert.equal((await transaction.a.stats()).sessions, 0);

    const intent = await setup({ limits: { operationTimeoutMs: 200 } });
    const intentId = secret(); await intent.stateA.run('beginLogin', { intentId });
    const intentState = await delayedState(intent, 'transactions', 250);
    await assert.rejects(intentState.run('publishLogin', { intentId, transactionId: secret(), transaction: { state: secret(), nonce: secret(), verifier: secret() } }), { code: 'UNAUTHENTICATED' });
    assert.equal((await intent.a.stats()).transactions, 0);

    const original = await setup({ limits: { sessionTtlMs: 400 } });
    const first = grant(); await original.stateA.run('finishCallback', { ...await prepare(original), ...first });
    await delay(250);
    const relogin = await prepare(original, first.sessionId), originalState = await delayedState(original, 'sessions', 200);
    const replacement = grant();
    await assert.rejects(originalState.run('finishCallback', { ...relogin, ...replacement, previous: first.sessionId }), { code: 'UNAUTHENTICATED' });
    assert.equal(await original.stateB.run('getSession', { id: replacement.sessionId }), null);
  });

  await t.test('a delayed successful COMMIT cannot return a grant whose source has expired', async () => {
    const f = await setup({ limits: { transactionTtlMs: 200 } });
    const intentId = secret(), id = secret(), claimId = secret(), sessionId = secret();
    await f.stateA.run('beginLogin', { intentId });
    await f.stateA.run('publishLogin', { intentId, transactionId: id, transaction: { state: secret(), nonce: secret(), verifier: secret() } });
    await f.stateA.run('consumeTransaction', { id, claimId });
    let commits = 0;
    const pool = { async connect() { const client = await poolB.connect(); return {
      async query(sql, values) { const result = await client.query(sql, values); if (sql === 'COMMIT') { commits++; await delay(250); } return result; },
      release(discard) { client.release(discard); }
    }; } };
    const state = new PostgresBrowserAuthState({ pool, schema: f.schema, encryptionKey: f.key });
    browsers.push(createBrowserOidc({ ...f.config, authState: state, resolveMembership: async () => member }));
    await assert.rejects(state.run('finishCallback', { id, claimId, sessionId, tokenExpiresAt: Date.now() + 60000,
      session: { version: secret(), subject: 'synthetic-editor', principalId: member.principalId, csrfToken: secret() } }), { code: 'UNAUTHENTICATED' });
    assert.equal(commits, 1);
    // The commit succeeded but the caller received no credentials. Do not retry
    // it or claim rollback; bounded unreachable state expires normally.
    assert.equal((await f.a.stats()).sessions, 1);
  });

  await t.test('an actually committed but unacknowledged write is not retried or reported as success', async () => {
    const f = await setup(), flow = await f.complete(); let commits = 0, releases = [];
    const pool = { async connect() { const client = await poolB.connect(); return {
      async query(sql, values) { const result = await client.query(sql, values); if (sql === 'COMMIT') { commits++; throw new Error('Synthetic lost COMMIT acknowledgement'); } return result; },
      release(discard) { releases.push(discard); client.release(discard); }
    }; } };
    const state = new PostgresBrowserAuthState({ pool, schema: f.schema, encryptionKey: f.key });
    const browser = createBrowserOidc({ ...f.config, authState: state, resolveMembership: async () => member }); browsers.push(browser);
    const sessionId = flow.jar.get(f.a.cookieNames.session), session = await f.stateA.run('getSession', { id: sessionId });
    const ticketId = secret();
    await assert.rejects(state.run('issueTicket', { sessionId, version: session.version, ticketId, roomId: 'room' }), { code: 'DEPENDENCY_UNAVAILABLE' });
    assert.equal(commits, 1); assert.deepEqual(releases, [true]); assert.equal((await f.a.stats()).tickets, 1);
    assert.equal((await browser.handleAuth(f.req('/auth/session', flow.jar))).status, 503);
  });
});
