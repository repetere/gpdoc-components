import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createBrowserOidc, BROWSER_OIDC_LIMITS } from '../src/browser-oidc.mjs';
import { createOpenDocHandler } from '../src/api.mjs';
import { MemoryDocumentStore } from '../src/memory-store.mjs';

const issuer = 'https://issuer.example.test';
const origin = 'https://opendoc.example.test';
const identity = { principalId: 'internal-user', tenantId: 'tenant.example', role: 'editor' };
const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
const otherKey = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'fixture-key', use: 'sig', alg: 'RS256' };
const base = () => ({
  issuer, clientId: 'browser-client', clientAuthentication: { method: 'client_secret_basic', clientSecret: 'synthetic-secret' },
  redirectUri: `${origin}/auth/callback`, authorizationEndpoint: `${issuer}/authorize`, tokenEndpoint: `${issuer}/token`, jwksUri: `${issuer}/jwks`,
  activeTenantId: identity.tenantId, resolveMembership: async () => ({ ...identity })
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const connectionId = () => randomBytes(32).toString('base64url');
function jarUpdate(jar, result) {
  for (const cookie of result.headers.getSetCookie()) {
    const [name, value] = cookie.split(';')[0].split('=');
    if (value) jar.set(name, value); else jar.delete(name);
  }
}
const cookieHeader = jar => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
function req(path, jar = new Map(), options = {}) {
  const method = options.method ?? 'GET';
  return new Request(`${origin}${path}`, { method, headers: {
    cookie: cookieHeader(jar), ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}), ...options.headers
  }, ...(method === 'GET' ? {} : { body: JSON.stringify(options.body ?? {}) }) });
}
function fixture(t, overrides = {}, behavior = {}) {
  const codes = new Map(), requests = [], memberships = [];
  let member = { ...identity }, resolver = async () => member;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    if (String(url) === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
    assert.equal(String(url), `${issuer}/token`);
    if (behavior.fetchError) throw new Error('private provider failure');
    if (behavior.delay) await sleep(behavior.delay);
    if (behavior.response) return behavior.response();
    assert.equal(decodeURIComponent(Buffer.from(new Headers(options.headers).get('authorization').slice(6), 'base64').toString()), 'browser-client:synthetic-secret');
    const params = new URLSearchParams(options.body), code = params.get('code'), auth = codes.get(code);
    if (!auth || createHash('sha256').update(params.get('code_verifier')).digest('base64url') !== auth.get('code_challenge')) return Response.json({ error: 'invalid_grant' }, { status: 400 });
    codes.delete(code);
    assert.equal(params.get('redirect_uri'), `${origin}/auth/callback`);
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: issuer, aud: 'browser-client', sub: 'provider|subject', iat: now, exp: now + 3600, nonce: auth.get('nonce'), ...behavior.claims };
    const idToken = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).sign(behavior.wrongKey ? otherKey.privateKey : privateKey);
    return Response.json({ access_token: 'PRIVATE_PROVIDER_ACCESS_TOKEN', refresh_token: 'PRIVATE_PROVIDER_REFRESH_TOKEN', token_type: 'Bearer', ...(!behavior.noIdToken ? { id_token: idToken } : {}) });
  };
  const app = createBrowserOidc({ ...base(), resolveMembership: async input => { memberships.push(input); return resolver(input); }, ...overrides });
  t.after(() => { globalThis.fetch = original; app.close(); });
  async function login(jar = new Map()) {
    const result = await app.handleAuth(req('/auth/login', jar, { method: 'POST', headers: { 'x-opendoc-login': '1' } }));
    assert.equal(result.status, 200);
    jarUpdate(jar, result);
    const auth = new URL((await result.json()).authorizationUrl).searchParams;
    const code = randomBytes(16).toString('hex'); codes.set(code, auth);
    const callbackPath = `/auth/callback?${new URLSearchParams({ code, state: auth.get('state'), iss: issuer })}`;
    return { jar, auth, callbackPath, result };
  }
  async function complete(jar = new Map()) {
    const loginResult = await login(jar);
    const result = await app.handleAuth(req(loginResult.callbackPath, jar));
    jarUpdate(jar, result);
    return { ...loginResult, result };
  }
  return { app, login, complete, requests, memberships, setMember: value => { member = value; }, setResolver: value => { resolver = value; } };
}

test('operator trust and redirect configuration is explicit and HTTPS by default', () => {
  assert.throws(() => createBrowserOidc());
  for (const key of ['issuer', 'redirectUri', 'authorizationEndpoint', 'tokenEndpoint', 'jwksUri']) {
    assert.throws(() => createBrowserOidc({ ...base(), [key]: 'http://example.test/auth/callback' }));
    assert.throws(() => createBrowserOidc({ ...base(), [key]: 'https://user:password@example.test/auth/callback' }));
    assert.throws(() => createBrowserOidc({ ...base(), [key]: 'https://example.test/auth/callback?from=browser' }));
  }
  for (const successPath of ['https://evil.test', '//evil.test', '/\\evil.test', '/%2f%2fevil.test', '/a/../b', '/auth/callback', '/?return=evil']) assert.throws(() => createBrowserOidc({ ...base(), successPath }));
  assert.throws(() => createBrowserOidc({ ...base(), clientAuthentication: undefined }));
  assert.throws(() => createBrowserOidc({ ...base(), activeTenantId: 'other/tenant' }));
  assert.throws(() => createBrowserOidc({ ...base(), allowInsecureLoopback: true }));
  assert.throws(() => createBrowserOidc({ ...base(), limits: { maxSessions: BROWSER_OIDC_LIMITS.maxSessions + 1 } }));
  assert.throws(() => createBrowserOidc({ ...base(), limits: { unknown: 10 } }));
});

test('login uses S256, independent nonce/state, strict preauth origin/header and host-only cookies', async t => {
  const f = fixture(t);
  for (const headers of [{}, { 'x-opendoc-login': '1', origin: 'https://evil.test' }, { 'x-opendoc-login': '1', 'content-type': 'text/plain' }]) {
    assert.ok((await f.app.handleAuth(req('/auth/login', new Map(), { method: 'POST', headers }))).status >= 400);
  }
  assert.equal((await f.app.handleAuth(req('/auth/login', new Map(), { method: 'POST', headers: { 'x-opendoc-login': '1' }, body: { tenantId: 'attacker' } }))).status, 400);
  const started = await f.login();
  assert.equal(started.auth.get('scope'), 'openid');
  assert.equal(started.auth.get('response_type'), 'code');
  assert.equal(started.auth.get('code_challenge_method'), 'S256');
  assert.notEqual(started.auth.get('state'), started.auth.get('nonce'));
  assert.notEqual(started.jar.get(f.app.cookieNames.transaction), started.auth.get('state'));
  const cookie = started.result.headers.getSetCookie()[0];
  assert.match(cookie, /^__Host-opendoc-transaction=/);
  for (const flag of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(cookie.includes(flag));
  assert.ok(!cookie.includes('Domain='));
  assert.equal(f.requests.length, 0);
});

test('verified login yields only opaque session and fresh trusted membership, not provider credentials', async t => {
  const f = fixture(t);
  const { jar, result } = await f.complete();
  assert.equal(result.status, 303);
  assert.equal(result.headers.get('location'), '/');
  assert.equal(jar.has(f.app.cookieNames.transaction), false);
  for (const cookie of result.headers.getSetCookie()) assert.match(cookie, /HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
  const sessionResponse = await f.app.handleAuth(req('/auth/session', jar));
  const session = await sessionResponse.json();
  assert.deepEqual(Object.keys(session).sort(), ['csrfToken', 'expiresAt', 'principalId', 'role', 'tenantId']);
  assert.equal(JSON.stringify(session).includes('PRIVATE_PROVIDER'), false);
  assert.notEqual(jar.get(f.app.cookieNames.session), session.csrfToken);
  assert.equal(jar.get(f.app.cookieNames.csrf), session.csrfToken);
  assert.ok(f.requests.some(r => r.url.endsWith('/jwks')));
  assert.deepEqual(f.memberships[0], { issuer, subject: 'provider|subject', activeTenantId: identity.tenantId });
  assert.equal(Object.isFrozen(f.memberships[0]), true);
  f.setMember({ ...identity, role: 'viewer', extra: 'ignored' });
  assert.deepEqual(await f.app.authenticate(req('/api/v1/session', jar)), { ...identity, role: 'viewer' });
  f.setMember(null);
  assert.equal(await f.app.authenticate(req('/api/v1/session', jar)), null);
  assert.equal(f.app.stats().sessions, 0);
});

test('callback rejects mismatched/missing/duplicate state, issuer, code and missing browser cookie before token exchange', async t => {
  const f = fixture(t);
  for (const mutate of [
    p => p.delete('state'), p => p.set('state', 'wrong'), p => p.append('state', 'duplicate'), p => p.delete('iss'), p => p.set('iss', 'https://evil.test'), p => p.delete('code'), p => p.set('code', ''), p => p.set('next', '//evil.test')
  ]) {
    const { jar, callbackPath } = await f.login();
    const url = new URL(`${origin}${callbackPath}`); mutate(url.searchParams);
    const result = await f.app.handleAuth(req(`${url.pathname}${url.search}`, jar));
    assert.equal(result.status, 401);
    assert.match(result.headers.get('set-cookie'), /Max-Age=0/);
  }
  const flow = await f.login();
  assert.equal((await f.app.handleAuth(req(flow.callbackPath))).status, 401);
  assert.equal(f.requests.length, 0);
});

test('single-use callback and bound transaction deny replay and wrong browser', async t => {
  const f = fixture(t);
  const a = await f.login(), b = await f.login();
  assert.equal((await f.app.handleAuth(req(a.callbackPath, b.jar))).status, 401);
  const saved = new Map(a.jar);
  const result = await f.app.handleAuth(req(a.callbackPath, a.jar));
  assert.equal(result.status, 303);
  assert.equal((await f.app.handleAuth(req(a.callbackPath, saved))).status, 401);
  assert.equal(f.requests.filter(r => r.url.endsWith('/token')).length, 1);
});

test('provider cancellation consumes transaction and errors are sanitized', async t => {
  const f = fixture(t);
  const { jar, auth, callbackPath } = await f.login();
  const result = await f.app.handleAuth(req(`/auth/callback?${new URLSearchParams({ state: auth.get('state'), iss: issuer, error: 'access_denied', error_description: 'PRIVATE_RAW_PROVIDER_ERROR' })}`, jar));
  assert.equal(result.status, 401);
  assert.equal((await result.text()).includes('PRIVATE_RAW'), false);
  assert.equal((await f.app.handleAuth(req(callbackPath, jar))).status, 401);
  assert.equal(f.requests.length, 0);
});

for (const [name, behavior] of [
  ['wrong signing key', { wrongKey: true }], ['missing ID token', { noIdToken: true }],
  ['wrong nonce', { claims: { nonce: 'wrong' } }], ['wrong issuer', { claims: { iss: 'https://evil.test' } }],
  ['wrong audience', { claims: { aud: 'another-client' } }], ['expired ID token', { claims: { exp: 1 } }],
  ['stale ID token', { claims: { iat: 1 } }], ['provider outage', { fetchError: true }],
  ['oversized response', { response: () => new Response('x'.repeat(262145)) }],
  ['malformed response', { response: () => new Response('private not json', { headers: { 'content-type': 'application/json' } }) }]
]) test(`${name} fails closed before membership resolution`, async t => {
  const f = fixture(t, {}, behavior);
  const { result } = await f.complete();
  assert.equal(result.status, 401);
  assert.equal(f.memberships.length, 0);
  assert.equal(f.app.stats().sessions, 0);
  assert.equal((await result.text()).includes('private'), false);
});

test('CSRF is bound to header, cookie and session with exact origin, including direct adapter misuse', async t => {
  const f = fixture(t), { jar } = await f.complete();
  const session = await (await f.app.handleAuth(req('/auth/session', jar))).json();
  const body = { id: 'doc', title: 'Title', content: 'body' };
  const store = new MemoryDocumentStore(), handler = f.app.createHandler({ store });
  for (const headers of [
    {}, { 'x-opendoc-csrf': session.csrfToken, origin: 'https://evil.test' },
    { 'x-opendoc-csrf': session.csrfToken, origin: '' }, { 'x-opendoc-csrf': 'wrong' },
    { 'x-opendoc-csrf': session.csrfToken, 'content-type': 'text/plain' }
  ]) assert.equal((await handler(req('/api/v1/documents', jar, { method: 'POST', headers, body }))).status, 403);
  const wrongCookie = new Map(jar); wrongCookie.set(f.app.cookieNames.csrf, randomBytes(32).toString('base64url'));
  assert.equal((await handler(req('/api/v1/documents', wrongCookie, { method: 'POST', headers: { 'x-opendoc-csrf': session.csrfToken }, body }))).status, 403);
  const direct = createOpenDocHandler({ store, authenticate: f.app.authenticate, allowedOrigins: [origin] });
  assert.equal((await direct(req('/api/v1/documents', jar, { method: 'POST', body }))).status, 401);
  assert.equal((await handler(req('/api/v1/documents', jar, { method: 'POST', headers: { 'x-opendoc-csrf': session.csrfToken }, body }))).status, 201);
});

test('login rotates session and CSRF; POST logout invalidates session and tickets', async t => {
  const f = fixture(t), { jar } = await f.complete();
  const original = new Map(jar), firstSession = jar.get(f.app.cookieNames.session);
  const renewed = await f.complete(jar);
  assert.equal(renewed.result.status, 303);
  assert.notEqual(jar.get(f.app.cookieNames.session), firstSession);
  assert.equal(await f.app.authenticate(req('/api/v1/session', original)), null);
  const session = await (await f.app.handleAuth(req('/auth/session', jar))).json();
  const headers = { 'x-opendoc-csrf': session.csrfToken };
  const ticket = await (await f.app.handleAuth(req('/auth/collaboration-ticket', jar, { method: 'POST', headers, body: { roomId: 'room' } }))).json();
  assert.equal((await f.app.handleAuth(req('/auth/logout', jar))).status, 405);
  assert.equal((await f.app.handleAuth(req('/auth/logout', jar, { method: 'POST' }))).status, 403);
  const result = await f.app.handleAuth(req('/auth/logout', jar, { method: 'POST', headers }));
  assert.equal(result.status, 204);
  assert.equal(await f.app.authenticate(req('/api/v1/session', jar)), null);
  assert.equal(await f.app.authenticateCollaboration(new Request('http://opendoc.invalid/api/v1/collaboration/room', { headers: { origin, authorization: `Bearer ${ticket.ticket}` } }), { connectionId: connectionId() }), null);
});

test('tickets are room-bound, connection-bound, short-lived and revalidate membership every use', async t => {
  const f = fixture(t, { limits: { ticketTtlMs: 300 } }), { jar } = await f.complete();
  const session = await (await f.app.handleAuth(req('/auth/session', jar))).json();
  const result = await f.app.handleAuth(req('/auth/collaboration-ticket', jar, { method: 'POST', headers: { 'x-opendoc-csrf': session.csrfToken }, body: { roomId: 'room' } }));
  const { ticket } = await result.json();
  const collab = (room = 'room') => new Request(`http://opendoc.invalid/api/v1/collaboration/${room}`, { headers: { origin, authorization: `Bearer ${ticket}` } });
  const context = { connectionId: connectionId() };
  assert.equal(await f.app.authenticateCollaboration(collab(), {}), null);
  assert.equal(await f.app.authenticateCollaboration(collab('other'), context), null);
  assert.deepEqual(await f.app.authenticateCollaboration(collab(), context), identity);
  assert.equal(await f.app.authenticateCollaboration(collab(), { connectionId: connectionId() }), null);
  f.setMember({ ...identity, role: 'viewer' });
  assert.deepEqual(await f.app.authenticateCollaboration(collab(), context), { ...identity, role: 'viewer' });
  await sleep(320);
  assert.equal(await f.app.authenticateCollaboration(collab(), context), null);
});

test('transaction and session TTLs do not slide', async t => {
  const f = fixture(t, { limits: { transactionTtlMs: 300, sessionTtlMs: 400 } });
  const pending = await f.login(); await sleep(320);
  assert.equal((await f.app.handleAuth(req(pending.callbackPath, pending.jar))).status, 401);
  const { jar, result } = await f.complete(); assert.equal(result.status, 303);
  assert.deepEqual(await f.app.authenticate(req('/api/v1/session', jar)), identity);
  await sleep(420);
  assert.equal(await f.app.authenticate(req('/api/v1/session', jar)), null);
});

test('bounded maps deny overload without evicting active users', async t => {
  const f = fixture(t, { limits: { maxTransactions: 1, maxSessions: 1, maxTickets: 1 } });
  const flow = await f.login();
  const overloaded = await f.app.handleAuth(req('/auth/login', new Map(), { method: 'POST', headers: { 'x-opendoc-login': '1' } }));
  assert.equal(overloaded.status, 429);
  const completed = await f.app.handleAuth(req(flow.callbackPath, flow.jar)); jarUpdate(flow.jar, completed);
  assert.equal(completed.status, 303);
  const another = await f.complete(); assert.equal(another.result.status, 429);
  assert.deepEqual(await f.app.authenticate(req('/api/v1/session', flow.jar)), identity);
  const session = await (await f.app.handleAuth(req('/auth/session', flow.jar))).json();
  const make = () => f.app.handleAuth(req('/auth/collaboration-ticket', flow.jar, { method: 'POST', headers: { 'x-opendoc-csrf': session.csrfToken }, body: { roomId: 'room' } }));
  assert.equal((await make()).status, 200); assert.equal((await make()).status, 429);
});

test('late membership result after timeout cannot mint a session; occupied slots remain bounded', async t => {
  const f = fixture(t, { limits: { maxPendingOperations: 1, operationTimeoutMs: 300 } });
  let resolve;
  f.setResolver(() => new Promise(r => { resolve = r; }));
  const flow = await f.login();
  const response = await f.app.handleAuth(req(flow.callbackPath, flow.jar));
  assert.equal(response.status, 503);
  assert.equal(f.app.stats().pendingOperations, 1);
  assert.equal((await f.app.handleAuth(req('/auth/session'))).status, 429);
  resolve(identity); await sleep(5);
  assert.equal(f.app.stats().pendingOperations, 0);
  assert.equal(f.app.stats().sessions, 0);
});

test('transaction expiry during token exchange cannot mint a session', async t => {
  const f = fixture(t, { limits: { transactionTtlMs: 20 } }, { delay: 40 });
  const flow = await f.login();
  assert.equal((await f.app.handleAuth(req(flow.callbackPath, flow.jar))).status, 401);
  assert.equal(f.app.stats().sessions, 0);
});

test('logout fences an in-flight authentication result', async t => {
  const f = fixture(t), { jar } = await f.complete();
  const session = await (await f.app.handleAuth(req('/auth/session', jar))).json();
  let resolve, calls = 0;
  f.setResolver(() => ++calls === 1 ? new Promise(r => { resolve = r; }) : Promise.resolve(identity));
  const pending = f.app.authenticate(req('/api/v1/session', jar)); await sleep(5);
  const result = await f.app.handleAuth(req('/auth/logout', jar, { method: 'POST', headers: { 'x-opendoc-csrf': session.csrfToken } }));
  assert.equal(result.status, 204);
  resolve(identity); assert.equal(await pending, null);
});

const waitFor = async predicate => { const until = Date.now() + 2000; while (!predicate()) { if (Date.now() > until) throw new Error('Missing test checkpoint'); await sleep(1); } };

test('logout cancels a re-login callback awaiting membership and cannot be undone by its late result', async t => {
  const f = fixture(t), { jar } = await f.complete();
  const session = await (await f.app.handleAuth(req('/auth/session', jar))).json();
  const flow = await f.login(jar);
  let release, calls = 0;
  f.setResolver(() => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(identity));
  const callback = f.app.handleAuth(req(flow.callbackPath, jar));
  await waitFor(() => release);
  const logout = await f.app.handleAuth(req('/auth/logout', jar, { method: 'POST', headers: { 'x-opendoc-csrf': session.csrfToken } }));
  assert.equal(logout.status, 204);
  release(identity);
  const stale = await callback;
  assert.equal(stale.status, 401);
  assert.deepEqual(stale.headers.getSetCookie(), []);
  assert.equal(f.app.stats().sessions, 0);
  assert.equal(f.app.stats().transactions, 0);
});

test('new anonymous login supersedes an in-flight callback without stale Set-Cookie deletion', async t => {
  const f = fixture(t), first = await f.login();
  let release;
  f.setResolver(() => new Promise(resolve => { release = resolve; }));
  const callback = f.app.handleAuth(req(first.callbackPath, first.jar));
  await waitFor(() => release);
  const replacement = await f.login(first.jar);
  const replacementId = replacement.jar.get(f.app.cookieNames.transaction);
  release(identity);
  const stale = await callback;
  assert.equal(stale.status, 401);
  assert.deepEqual(stale.headers.getSetCookie(), []);
  jarUpdate(replacement.jar, stale);
  assert.equal(replacement.jar.get(f.app.cookieNames.transaction), replacementId);
  assert.equal(f.app.stats().sessions, 0);
  f.setResolver(async () => identity);
  assert.equal((await f.app.handleAuth(req(replacement.callbackPath, replacement.jar))).status, 303);
});

test('session rotation fences sibling in-flight callbacks associated with the previous session', async t => {
  const f = fixture(t), { jar } = await f.complete();
  const first = await f.login(new Map(jar));
  let release, calls = 0;
  f.setResolver(() => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(identity));
  const callback = f.app.handleAuth(req(first.callbackPath, first.jar));
  await waitFor(() => release);
  const second = await f.login(new Map(jar));
  const fresh = await f.app.handleAuth(req(second.callbackPath, second.jar));
  assert.equal(fresh.status, 303);
  release(identity);
  const stale = await callback;
  assert.equal(stale.status, 401);
  assert.deepEqual(stale.headers.getSetCookie(), []);
  assert.equal(f.app.stats().sessions, 1);
});

test('duplicate callback cannot clear an in-flight transaction cookie or exchange its code again', async t => {
  const f = fixture(t), flow = await f.login();
  let release;
  f.setResolver(() => new Promise(resolve => { release = resolve; }));
  const callback = f.app.handleAuth(req(flow.callbackPath, flow.jar));
  await waitFor(() => release);
  const duplicate = await f.app.handleAuth(req(flow.callbackPath, flow.jar));
  assert.equal(duplicate.status, 401);
  assert.deepEqual(duplicate.headers.getSetCookie(), []);
  release(identity);
  assert.equal((await callback).status, 303);
  assert.equal(f.requests.filter(r => r.url.endsWith('/token')).length, 1);
});

test('transaction expiry during membership lookup cannot create a session', async t => {
  const f = fixture(t, { limits: { transactionTtlMs: 300 } }), flow = await f.login();
  let release;
  f.setResolver(() => new Promise(resolve => { release = resolve; }));
  const callback = f.app.handleAuth(req(flow.callbackPath, flow.jar));
  await waitFor(() => release); await sleep(320); release(identity);
  assert.equal((await callback).status, 401);
  assert.equal(f.app.stats().sessions, 0);
});

test('logout cancels an in-flight ticket validation and ticket use remains single-connection under concurrency', async t => {
  const f = fixture(t), { jar } = await f.complete();
  const session = await (await f.app.handleAuth(req('/auth/session', jar))).json();
  const headers = { 'x-opendoc-csrf': session.csrfToken };
  const { ticket } = await (await f.app.handleAuth(req('/auth/collaboration-ticket', jar, { method: 'POST', headers, body: { roomId: 'room' } }))).json();
  const request = new Request('http://opendoc.invalid/api/v1/collaboration/room', { headers: { origin, authorization: `Bearer ${ticket}` } });
  let release, calls = 0;
  f.setResolver(() => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(identity));
  const pending = f.app.authenticateCollaboration(request, { connectionId: connectionId() });
  await waitFor(() => release);
  assert.equal(await f.app.authenticateCollaboration(request, { connectionId: connectionId() }), null);
  assert.equal((await f.app.handleAuth(req('/auth/logout', jar, { method: 'POST', headers }))).status, 204);
  release(identity); assert.equal(await pending, null);
});

test('malformed membership identifiers and multibyte CSRF values fail closed without leaking dependency errors', async t => {
  const f = fixture(t), { jar } = await f.complete();
  const session = await (await f.app.handleAuth(req('/auth/session', jar))).json();
  const result = await f.app.handleAuth(req('/auth/logout', jar, { method: 'POST', headers: { 'x-opendoc-csrf': 'é'.repeat(session.csrfToken.length) } }));
  assert.equal(result.status, 403);
  f.setMember({ ...identity, principalId: 'internal-user\n' });
  assert.equal(await f.app.authenticate(req('/api/v1/session', jar)), null);
});

async function stalledLogin(app, jar) {
  let controller, readPrefix = false;
  const body = new ReadableStream({
    start(value) { controller = value; value.enqueue(new TextEncoder().encode('{')); },
    pull() { readPrefix = true; }
  });
  const request = new Request(`${origin}/auth/login`, {
    method: 'POST', duplex: 'half', body,
    headers: { origin, 'content-type': 'application/json', 'x-opendoc-login': '1', cookie: cookieHeader(jar) }
  });
  const pending = app.handleAuth(request);
  await waitFor(() => readPrefix && app.stats().pendingOperations > 0);
  return { pending, finish() { controller.enqueue(new TextEncoder().encode('}')); controller.close(); } };
}

test('logout fences login initiation stalled while reading its JSON body', async t => {
  const f = fixture(t), { jar } = await f.complete();
  const session = await (await f.app.handleAuth(req('/auth/session', jar))).json();
  const slow = await stalledLogin(f.app, jar);
  const logout = await f.app.handleAuth(req('/auth/logout', jar, { method: 'POST', headers: { 'x-opendoc-csrf': session.csrfToken } }));
  assert.equal(logout.status, 204);
  slow.finish();
  const stale = await slow.pending;
  assert.equal(stale.status, 401);
  assert.deepEqual(stale.headers.getSetCookie(), []);
  assert.equal(f.app.stats().transactions, 0);
  assert.equal(f.app.stats().sessions, 0);
  assert.equal((await stale.text()).includes('authorizationUrl'), false);
});

test('a newer authenticated initiation supersedes an older body-stalled initiation', async t => {
  const f = fixture(t), { jar } = await f.complete();
  const slow = await stalledLogin(f.app, new Map(jar));
  const latest = await f.login(new Map(jar));
  slow.finish();
  const stale = await slow.pending;
  assert.equal(stale.status, 401);
  assert.deepEqual(stale.headers.getSetCookie(), []);
  assert.equal(f.app.stats().transactions, 1);
  assert.equal((await f.app.handleAuth(req(latest.callbackPath, latest.jar))).status, 303);
});

test('an anonymous browser transaction prevents an older delayed initiation overtaking its replacement', async t => {
  const f = fixture(t), first = await f.login();
  const slow = await stalledLogin(f.app, new Map(first.jar));
  const latest = await f.login(new Map(first.jar));
  slow.finish();
  const stale = await slow.pending;
  assert.equal(stale.status, 401);
  assert.deepEqual(stale.headers.getSetCookie(), []);
  assert.equal(f.app.stats().transactions, 1);
  assert.equal((await f.app.handleAuth(req(latest.callbackPath, latest.jar))).status, 303);
});

test('the originating authenticated session must remain live during login initiation', async t => {
  const f = fixture(t, { limits: { sessionTtlMs: 300 } }), { jar } = await f.complete();
  const slow = await stalledLogin(f.app, jar);
  await sleep(320);
  slow.finish();
  assert.equal((await slow.pending).status, 401);
  assert.equal(f.app.stats().transactions, 0);
  assert.equal(f.app.stats().sessions, 0);
});

test('logout fences login initiation paused during asynchronous PKCE digest', async t => {
  const f = fixture(t), { jar } = await f.complete();
  const session = await (await f.app.handleAuth(req('/auth/session', jar))).json();
  const originalDigest = crypto.subtle.digest;
  let release;
  crypto.subtle.digest = async (...args) => {
    await new Promise(resolve => { release = resolve; });
    return originalDigest.apply(crypto.subtle, args);
  };
  t.after(() => { crypto.subtle.digest = originalDigest; });
  const pending = f.app.handleAuth(req('/auth/login', jar, { method: 'POST', headers: { 'x-opendoc-login': '1' } }));
  await waitFor(() => release);
  const logout = await f.app.handleAuth(req('/auth/logout', jar, { method: 'POST', headers: { 'x-opendoc-csrf': session.csrfToken } }));
  assert.equal(logout.status, 204);
  release();
  const stale = await pending;
  assert.equal(stale.status, 401);
  assert.deepEqual(stale.headers.getSetCookie(), []);
  assert.equal(f.app.stats().transactions, 0);
  assert.equal(f.app.stats().sessions, 0);
});
