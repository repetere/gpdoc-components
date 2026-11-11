// Real local HTTP + oidc-provider network integration. This is deliberately NOT
// labelled actual-browser QA: fetch does not enforce SameSite or browser CORS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { createBrowserOidc } from '../src/browser-oidc.mjs';
import { MemoryDocumentStore } from '../src/memory-store.mjs';
import { attachCollaborationServer } from '../src/collaboration-server.mjs';
import { decodeStateFrame, encodeUpdateFrame } from '../src/collaboration-client.mjs';
import { startLoopbackApp, startSyntheticProvider, NetworkCookieJar, authorizeAtProvider } from './fixtures/oidc-provider.mjs';

const document = { id: 'synthetic-document', title: 'Synthetic only', content: '# Original synthetic text' };
async function fixture(t, { limits, method, resolveMembership } = {}) {
  const app = await startLoopbackApp();
  const provider = await startSyntheticProvider({ redirectUri: `${app.origin}/auth/callback`, method });
  const memberships = new Map([
    ['synthetic-editor', { principalId: 'mapped-editor', tenantId: 'team-a', role: 'editor' }],
    ['synthetic-viewer', { principalId: 'mapped-viewer', tenantId: 'team-a', role: 'viewer' }],
    ['synthetic-commenter', { principalId: 'mapped-commenter', tenantId: 'team-a', role: 'commenter' }]
  ]);
  const lookups = [];
  const auth = createBrowserOidc({ ...provider, redirectUri: `${app.origin}/auth/callback`, activeTenantId: 'team-a',
    resolveMembership: resolveMembership ?? (async input => { lookups.push(input); assert.equal(input.issuer, provider.issuer); assert.equal(input.activeTenantId, 'team-a'); return memberships.get(input.subject) ?? null; }),
    allowInsecureLoopback: true, limits });
  const store = new MemoryDocumentStore();
  app.setHandler(auth.createHandler({ store }));
  t.after(async () => { auth.close(); await Promise.all([app.close(), provider.close()]); });
  return { app, provider, auth, store, memberships, lookups, jar: new NetworkCookieJar() };
}
async function begin(f, jar = f.jar) {
  const response = await jar.fetch(`${f.app.origin}/auth/login`, { method: 'POST', headers: { origin: f.app.origin, 'content-type': 'application/json', 'x-opendoc-login': '1' }, body: '{}' });
  assert.equal(response.status, 200, await response.clone().text());
  return { response, ...(await response.json()) };
}
async function complete(f, { jar = f.jar, subject, cancel, authorizationUrl } = {}) {
  const url = authorizationUrl ?? (await begin(f, jar)).authorizationUrl;
  const callback = await authorizeAtProvider({ provider: f.provider, jar, authorizationUrl: url, subject, cancel });
  const transactionCookie = jar.header(callback);
  const response = await jar.fetch(callback);
  return { response, callback, transactionCookie };
}
async function login(f, options) {
  const result = await complete(f, options);
  assert.equal(result.response.status, 303, await result.response.clone().text());
  assert.equal(result.response.headers.get('location'), '/');
  const response = await (options?.jar ?? f.jar).fetch(`${f.app.origin}/auth/session`);
  assert.equal(response.status, 200);
  return { ...result, session: await response.json() };
}
function mutate(f, path, body, csrfToken, { jar = f.jar, ...extra } = {}) {
  return jar.fetch(`${f.app.origin}${path}`, { method: 'POST', ...extra,
    headers: { origin: f.app.origin, 'content-type': 'application/json', ...(csrfToken ? { 'x-opendoc-csrf': csrfToken } : {}), ...extra.headers },
    body: JSON.stringify(body) });
}
async function denied(response) { assert.ok([400, 401, 403].includes(response.status), `${response.status}: ${await response.clone().text()}`); }

// @spec OD-LOGIN-001 OD-LOGIN-002 OD-LOGIN-003
test('real provider code exchange uses PKCE, nonce, state and opaque server sessions; REST writes work', async t => {
  const f = await fixture(t);
  const started = await begin(f);
  const authorization = new URL(started.authorizationUrl);
  assert.equal(authorization.origin, f.provider.issuer);
  assert.equal(authorization.searchParams.get('response_type'), 'code');
  assert.equal(authorization.searchParams.get('scope'), 'openid');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  for (const key of ['code_challenge', 'nonce', 'state']) assert.match(authorization.searchParams.get(key), /^[a-zA-Z0-9_-]{43,}$/);
  assert.equal(authorization.searchParams.get('redirect_uri'), `${f.app.origin}/auth/callback`);
  assert.equal(authorization.searchParams.has('client_secret'), false);
  const { session, response } = await login(f, { authorizationUrl: started.authorizationUrl });
  assert.deepEqual(Object.keys(session).sort(), ['csrfToken', 'expiresAt', 'principalId', 'role', 'tenantId']);
  assert.deepEqual({ principalId: session.principalId, tenantId: session.tenantId, role: session.role }, { principalId: 'mapped-editor', tenantId: 'team-a', role: 'editor' });
  assert.ok(session.expiresAt > Date.now());
  assert.match(session.csrfToken, /^[a-zA-Z0-9_-]{43}$/);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 3);
  for (const name of [f.auth.cookieNames.session, f.auth.cookieNames.csrf]) {
    const raw = cookies.find(value => value.startsWith(`${name}=`));
    assert.match(raw, /; HttpOnly;/); assert.match(raw, /; SameSite=Lax;/); assert.match(raw, /; Path=\//);
    assert.match(raw.split(';')[0].split('=')[1], /^[a-zA-Z0-9_-]{43}$/);
    assert.ok(!raw.includes('eyJ'), 'No JWT is exposed in browser cookies');
  }
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await mutate(f, '/api/v1/documents', document, session.csrfToken)).status, 201);
  const read = await f.jar.fetch(`${f.app.origin}/api/v1/documents/${document.id}`);
  assert.equal(read.status, 200); assert.equal((await read.json()).content, document.content);
  assert.ok(f.provider.requests.some(item => item.method === 'POST' && item.path === '/token'));
  assert.ok(f.provider.requests.some(item => item.method === 'GET' && item.path === '/jwks'));
  assert.ok(f.lookups.every(input => input.subject === 'synthetic-editor' && input.activeTenantId === 'team-a'));
});

test('client_secret_post and public PKCE clients both use standard provider flows', async t => {
  for (const method of ['client_secret_post', 'none']) await t.test(method, async t => {
    const f = await fixture(t, { method }); assert.equal((await login(f)).session.principalId, 'mapped-editor');
  });
});

test('login initiation rejects absent/foreign origin, simple content types, client tenant fields and missing intent header', async t => {
  const f = await fixture(t);
  for (const change of [ { origin: undefined }, { origin: 'https://foreign.example.test' }, { 'content-type': 'text/plain' }, { 'x-opendoc-login': undefined } ]) {
    const headers = { origin: f.app.origin, 'content-type': 'application/json', 'x-opendoc-login': '1', ...change };
    for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
    await denied(await f.jar.fetch(`${f.app.origin}/auth/login`, { method: 'POST', headers, body: '{}' }));
  }
  await denied(await f.jar.fetch(`${f.app.origin}/auth/login`, { method: 'POST', headers: { origin: f.app.origin, 'content-type': 'application/json', 'x-opendoc-login': '1' }, body: '{"tenantId":"other","returnTo":"https://evil.example.test"}' }));
  assert.equal(f.auth.stats().transactions, 0);
});

test('authenticated REST and auth mutations enforce exact origin, header-and-cookie CSRF and JSON', async t => {
  const f = await fixture(t); const { session } = await login(f);
  for (const path of ['/api/v1/documents', '/auth/logout', '/auth/collaboration-ticket']) {
    const body = path === '/api/v1/documents' ? document : path.endsWith('ticket') ? { roomId: 'room' } : {};
    await denied(await mutate(f, path, body));
    await denied(await mutate(f, path, body, 'wrong-csrf'));
    await denied(await mutate(f, path, body, session.csrfToken, { headers: { origin: 'https://foreign.example.test' } }));
    await denied(await mutate(f, path, body, session.csrfToken, { headers: { 'content-type': 'text/plain' } }));
    const cookie = f.jar.header(f.app.origin).split('; ').filter(value => !value.startsWith(`${f.auth.cookieNames.csrf}=`)).join('; ');
    await denied(await mutate(f, path, body, session.csrfToken, { headers: { cookie } }));
  }
  assert.deepEqual(await f.store.list('team-a'), []);
  assert.equal((await f.jar.fetch(`${f.app.origin}/auth/session`)).status, 200, 'Failed CSRF must not log the real user out');
});

test('viewer and commenter sessions can read but cannot mutate, and client role claims grant nothing', async t => {
  const f = await fixture(t); await f.store.create('team-a', document);
  for (const subject of ['synthetic-viewer', 'synthetic-commenter']) {
    const jar = new NetworkCookieJar(); const { session } = await login(f, { jar, subject });
    assert.equal((await jar.fetch(`${f.app.origin}/api/v1/documents/${document.id}`)).status, 200);
    assert.equal((await mutate(f, '/api/v1/documents', { ...document, id: 'denied' }, session.csrfToken, { jar })).status, 403);
    assert.equal((await jar.fetch(`${f.app.origin}/api/v1/documents/${document.id}`, { method: 'PUT', headers: { origin: f.app.origin, 'content-type': 'application/json', 'x-opendoc-csrf': session.csrfToken, 'if-match': '"1"' }, body: '{"title":"denied","content":"denied"}' })).status, 403);
  }
  assert.equal((await f.store.get('team-a', document.id)).revision, 1);
});

test('unmapped subject, wrong active tenant and unknown roles fail closed after genuine identity verification', async t => {
  const f = await fixture(t);
  assert.equal((await complete(f, { subject: 'synthetic-unmapped' })).response.status, 403);
  for (const identity of [{ principalId: 'mapped-editor', tenantId: 'team-b', role: 'owner' }, { principalId: 'mapped-editor', tenantId: 'team-a', role: 'admin' }]) {
    f.memberships.set('synthetic-editor', identity);
    assert.equal((await complete(f, { jar: new NetworkCookieJar() })).response.status, 403);
  }
  assert.equal(f.auth.stats().sessions, 0);
});

test('callback replay, wrong state, provider cancellation and missing transaction cookie cannot establish a session', async t => {
  const f = await fixture(t);
  const { callback, transactionCookie } = await login(f);
  await denied(await f.jar.fetch(callback, { headers: { cookie: transactionCookie } }));
  const cancelled = await complete(f, { jar: new NetworkCookieJar(), cancel: true });
  await denied(cancelled.response);
  for (const mode of ['state', 'missing-cookie', 'issuer']) {
    const jar = new NetworkCookieJar(); const started = await begin(f, jar);
    const raw = await authorizeAtProvider({ provider: f.provider, jar, authorizationUrl: started.authorizationUrl });
    const url = new URL(raw);
    if (mode === 'state') url.searchParams.set('state', 'wrong-state');
    if (mode === 'issuer') url.searchParams.set('iss', 'https://foreign.example.test');
    await denied(await jar.fetch(url, mode === 'missing-cookie' ? { headers: { cookie: '' } } : {}));
    assert.equal((await jar.fetch(`${f.app.origin}/auth/session`)).status, 401);
  }
});

test('provider-issued ID token nonce mismatch and PKCE mismatch fail without tokens or local sessions', async t => {
  const f = await fixture(t);
  for (const key of ['nonce', 'code_challenge']) {
    const jar = new NetworkCookieJar(); const started = await begin(f, jar); const url = new URL(started.authorizationUrl);
    url.searchParams.set(key, randomBytes(32).toString('base64url'));
    const result = await complete(f, { jar, authorizationUrl: url.href });
    await denied(result.response);
    const body = await result.response.text();
    assert.ok(!body.includes('eyJ') && !body.includes('invalid_grant') && !body.includes('nonce'));
    assert.equal((await jar.fetch(`${f.app.origin}/auth/session`)).status, 401);
  }
  assert.equal(f.auth.stats().sessions, 0);
});

test('ID tokens signed by keys absent from the pinned real JWKS never create a browser session', async t => {
  const f = await fixture(t);
  const unrelated = await startSyntheticProvider({ redirectUri: `${f.app.origin}/auth/callback` });
  const mismatched = createBrowserOidc({ ...f.provider, jwksUri: unrelated.jwksUri,
    redirectUri: `${f.app.origin}/auth/callback`, activeTenantId: 'team-a', allowInsecureLoopback: true,
    resolveMembership: async () => ({ principalId: 'must-not-authenticate', tenantId: 'team-a', role: 'owner' }) });
  t.after(async () => { mismatched.close(); await unrelated.close(); });
  f.app.setHandler(mismatched.createHandler({ store: f.store }));
  const result = await complete(f); await denied(result.response);
  assert.equal((await f.jar.fetch(`${f.app.origin}/auth/session`)).status, 401);
  assert.equal(mismatched.stats().sessions, 0);
  assert.ok(f.provider.requests.some(value => value.path === '/token'));
  assert.ok(unrelated.requests.some(value => value.path === '/jwks'));
});

test('logout revokes replayed cookies; a new login rotates the session and CSRF token', async t => {
  const f = await fixture(t); const first = await login(f); const oldCookies = f.jar.header(f.app.origin);
  const second = await login(f);
  assert.notEqual(first.session.csrfToken, second.session.csrfToken);
  assert.equal((await f.jar.fetch(`${f.app.origin}/auth/session`, { headers: { cookie: oldCookies } })).status, 401);
  const currentCookies = f.jar.header(f.app.origin);
  assert.equal((await mutate(f, '/auth/logout', {}, second.session.csrfToken)).status, 204);
  assert.equal((await f.jar.fetch(`${f.app.origin}/auth/session`)).status, 401);
  assert.equal((await f.jar.fetch(`${f.app.origin}/auth/session`, { headers: { cookie: currentCookies } })).status, 401);
  assert.equal(f.auth.stats().sessions, 0);
});

test('current membership revocation and role downgrade apply to an already-issued session', async t => {
  const f = await fixture(t); const { session } = await login(f);
  f.memberships.set('synthetic-editor', { principalId: 'mapped-editor', tenantId: 'team-a', role: 'viewer' });
  assert.equal((await mutate(f, '/api/v1/documents', document, session.csrfToken)).status, 403);
  assert.equal((await (await f.jar.fetch(`${f.app.origin}/auth/session`)).json()).role, 'viewer');
  f.memberships.delete('synthetic-editor');
  assert.equal((await f.jar.fetch(`${f.app.origin}/auth/session`)).status, 401);
  assert.deepEqual(await f.store.list('team-a'), []);
});

test('expired transactions and sessions reject even replayed still-present cookie values', async t => {
  await t.test('transaction expiry', async t => {
    const f = await fixture(t, { limits: { transactionTtlMs: 1200 } }); const started = await begin(f);
    const callback = await authorizeAtProvider({ provider: f.provider, jar: f.jar, authorizationUrl: started.authorizationUrl });
    const cookie = f.jar.header(callback); await delay(1250);
    assert.equal((await f.jar.fetch(callback, { headers: { cookie } })).status, 401);
  });
  await t.test('session expiry', async t => {
    const f = await fixture(t, { limits: { sessionTtlMs: 1200 } }); await login(f); const cookie = f.jar.header(f.app.origin);
    await delay(1250); assert.equal((await f.jar.fetch(`${f.app.origin}/auth/session`, { headers: { cookie } })).status, 401);
  });
});

function collaborationStore() {
  const records = new Map();
  return { async get(tenant, room) { return records.get(JSON.stringify([tenant, room])) ?? null; },
    async applyUpdate(tenant, room, update) {
      const key = JSON.stringify([tenant, room]), old = records.get(key), doc = new Y.Doc();
      try { if (old) Y.applyUpdate(doc, old.state); Y.applyUpdate(doc, update); const value = { state: Y.encodeStateAsUpdate(doc), revision: (old?.revision ?? 0) + 1 }; records.set(key, value); return value; }
      finally { doc.destroy(); }
    } };
}
async function socket(t, f, room, ticket) {
  const ws = new WebSocket(`${f.app.origin.replace('http:', 'ws:')}/api/v1/collaboration/${room}`, { origin: f.app.origin });
  const frames = [], waiters = [];
  ws.on('message', (data, binary) => { const value = binary ? decodeStateFrame(data) : JSON.parse(data.toString()); if (waiters.length) waiters.shift()(value); else frames.push(value); });
  ws.on('error', () => {});
  const closed = new Promise(resolve => ws.once('close', code => resolve(code)));
  t.after(() => ws.terminate()); await once(ws, 'open');
  const next = () => new Promise((resolve, reject) => { if (frames.length) return resolve(frames.shift()); const timer = setTimeout(() => reject(new Error('No WebSocket frame')), 3000); waiters.push(value => { clearTimeout(timer); resolve(value); }); });
  ws.send(JSON.stringify({ type: 'authenticate', token: ticket }));
  return { ws, closed, next, frames };
}

test('real WebSockets use room-bound one-use tickets, stable server connection IDs, revalidation and logout', async t => {
  const f = await fixture(t); const { session } = await login(f); const contexts = [];
  const transport = attachCollaborationServer({ server: f.app.server, store: collaborationStore(), allowedOrigins: [f.app.origin], limits: { revalidationIntervalMs: 30 },
    authenticate(request, context) { contexts.push(context); assert.ok(Object.isFrozen(context)); return f.auth.authenticateCollaboration(request, context); } });
  t.after(() => transport.close());
  const ticket = await (await mutate(f, '/auth/collaboration-ticket', { roomId: 'room-a' }, session.csrfToken)).json();
  assert.match(ticket.ticket, /^[a-zA-Z0-9_-]{43}$/);
  const wrongRoom = await socket(t, f, 'room-b', ticket.ticket); assert.equal(await wrongRoom.closed, 1008); assert.equal(wrongRoom.frames.length, 0);
  const first = await socket(t, f, 'room-a', ticket.ticket); assert.equal((await first.next()).type, 'ready'); assert.equal((await first.next()).revision, 0);
  const replay = await socket(t, f, 'room-a', ticket.ticket); assert.equal(await replay.closed, 1008); assert.equal(replay.frames.length, 0);
  first.ws.send('{"type":"sync"}'); assert.equal((await first.next()).revision, 0);
  const doc = new Y.Doc(); doc.getText('body').insert(0, 'Synthetic collaboration'); first.ws.send(encodeUpdateFrame(Y.encodeStateAsUpdate(doc))); doc.destroy();
  assert.equal((await first.next()).revision, 1);
  assert.ok(contexts.length >= 5);
  assert.ok(contexts.filter(value => value.connectionId === contexts[1].connectionId).length >= 2, 'Same socket is revalidated with the same server-owned ID');
  assert.equal(new Set(contexts.map(value => value.connectionId)).size, 3, 'Three sockets have distinct IDs');
  assert.equal((await mutate(f, '/auth/logout', {}, session.csrfToken)).status, 204);
  assert.equal(await first.closed, 1008);
  const afterLogout = await socket(t, f, 'room-a', ticket.ticket); assert.equal(await afterLogout.closed, 1008);
});

test('short-lived tickets expire and current membership removal terminates an authenticated socket', async t => {
  const f = await fixture(t, { limits: { ticketTtlMs: 200 } }); const { session } = await login(f);
  const transport = attachCollaborationServer({ server: f.app.server, store: collaborationStore(), authenticate: f.auth.authenticateCollaboration,
    allowedOrigins: [f.app.origin], limits: { revalidationIntervalMs: 30 } });
  t.after(() => transport.close());
  const expired = await (await mutate(f, '/auth/collaboration-ticket', { roomId: 'room' }, session.csrfToken)).json();
  await delay(220); const denied = await socket(t, f, 'room', expired.ticket); assert.equal(await denied.closed, 1008);
  const valid = await (await mutate(f, '/auth/collaboration-ticket', { roomId: 'room' }, session.csrfToken)).json();
  const peer = await socket(t, f, 'room', valid.ticket); assert.equal((await peer.next()).type, 'ready'); await peer.next();
  f.memberships.delete('synthetic-editor'); assert.equal(await peer.closed, 1008);
});
