// Test-only standards provider. Synthetic accounts, ephemeral signing keys,
// isolated in-memory state, and IPv4 loopback. Never use for real sign-in.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { Provider } from 'oidc-provider';

export const SYNTHETIC_CLIENT = 'opendoc-synthetic-client';
export const SYNTHETIC_SECRET = 'synthetic-local-test-client-secret-not-for-production';
export const SYNTHETIC_SUBJECTS = ['synthetic-editor', 'synthetic-viewer', 'synthetic-commenter', 'synthetic-unmapped'];

/** A real HTTP listener. Pins request URLs to its configured loopback origin. */
export async function startLoopbackApp(initialHandler) {
  let handle = initialHandler;
  let origin;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const target = incoming.url ?? '';
      if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\')) {
        outgoing.writeHead(400); outgoing.end(); return;
      }
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      const method = incoming.method ?? 'GET';
      const request = new Request(`${origin}${target}`, { method, headers,
        ...(!['GET', 'HEAD'].includes(method) ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}) });
      const result = await handle(request);
      const responseHeaders = Object.fromEntries(result.headers);
      const cookies = result.headers.getSetCookie();
      if (cookies.length) responseHeaders['set-cookie'] = cookies;
      outgoing.writeHead(result.status, responseHeaders);
      outgoing.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(503, { 'content-type': 'application/json' });
      outgoing.end('{"error":"fixture_unavailable"}');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, setHandler(value) { handle = value; },
    close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}

function isolatedAdapter() {
  const records = new Map();
  return class Adapter {
    constructor(name) { this.name = name; }
    key(id) { return `${this.name}:${id}`; }
    async upsert(id, payload, expiresIn) { records.set(this.key(id), { payload, expires: expiresIn ? Date.now() + expiresIn * 1000 : Infinity }); }
    async find(id) { const value = records.get(this.key(id)); if (!value || value.expires <= Date.now()) return undefined; return { ...value.payload }; }
    async findByUid(uid) { for (const [key, value] of records) if (key.startsWith(`${this.name}:`) && value.payload.uid === uid && value.expires > Date.now()) return { ...value.payload }; }
    async findByUserCode(userCode) { for (const [key, value] of records) if (key.startsWith(`${this.name}:`) && value.payload.userCode === userCode && value.expires > Date.now()) return { ...value.payload }; }
    async destroy(id) { records.delete(this.key(id)); }
    async consume(id) { const value = records.get(this.key(id)); if (value) value.payload.consumed = Math.floor(Date.now() / 1000); }
    async revokeByGrantId(grantId) { for (const [key, value] of records) if (value.payload.grantId === grantId) records.delete(key); }
  };
}

export async function startSyntheticProvider({ redirectUri, method = 'client_secret_basic' }) {
  const redirect = new URL(redirectUri);
  assert.equal(redirect.protocol, 'http:'); assert.equal(redirect.hostname, '127.0.0.1');
  assert.equal(redirect.pathname, '/auth/callback'); assert.equal(redirect.search, ''); assert.equal(redirect.hash, '');
  assert.ok(['client_secret_basic', 'client_secret_post', 'none'].includes(method));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = privateKey.export({ format: 'jwk' });
  Object.assign(jwk, { kid: randomBytes(12).toString('hex'), alg: 'RS256', use: 'sig' });
  const requests = [];
  let callback;
  const server = createServer((request, response) => callback(request, response));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const issuer = `http://127.0.0.1:${server.address().port}`;
  const provider = new Provider(issuer, {
    adapter: isolatedAdapter(),
    clients: [{ client_id: SYNTHETIC_CLIENT, ...(method === 'none' ? {} : { client_secret: SYNTHETIC_SECRET }),
      redirect_uris: [redirectUri], response_types: ['code'], grant_types: ['authorization_code'], token_endpoint_auth_method: method }],
    jwks: { keys: [jwk] },
    cookies: { keys: [randomBytes(32).toString('base64url')], long: { secure: false }, short: { secure: false } },
    features: { devInteractions: { enabled: false } },
    ttl: { Interaction: 300, Session: 600, Grant: 600, IdToken: 300, AuthorizationCode: 60, AccessToken: 300 },
    responseTypes: ['code'], scopes: ['openid'], claims: { openid: ['sub'] },
    pkce: { required: () => true },
    issueRefreshToken: () => false,
    interactions: { url: (_ctx, interaction) => `/test/interaction/${interaction.uid}` },
    findAccount: async (_ctx, subject) => SYNTHETIC_SUBJECTS.includes(subject)
      ? { accountId: subject, claims: async () => ({ sub: subject }) } : undefined
  });
  provider.use(async (ctx, next) => {
    requests.push({ method: ctx.method, path: ctx.path });
    if (!/^\/test\/interaction\/[a-zA-Z0-9_-]+$/.test(ctx.path)) return next();
    const interaction = await provider.interactionDetails(ctx.req, ctx.res);
    ctx.set('cache-control', 'no-store');
    if (ctx.method === 'GET') {
      const buttons = SYNTHETIC_SUBJECTS.map(subject => `<button name="subject" value="${subject}">${subject}</button>`).join(' ');
      ctx.type = 'html';
      ctx.body = `<!doctype html><html><head><title>Synthetic OpenDoc identity provider</title></head><body><h1>Synthetic local sign-in</h1><p>Test fixture only. No real accounts or credentials.</p><p>Current step: ${interaction.prompt.name}</p><form method="post">${interaction.prompt.name === 'login' ? buttons : '<button name="decision" value="allow">Approve synthetic OpenDoc access</button>'}<button name="decision" value="cancel">Cancel</button></form></body></html>`;
      return;
    }
    if (ctx.method !== 'POST' || ctx.get('origin') !== issuer || !ctx.get('content-type').startsWith('application/x-www-form-urlencoded')) { ctx.status = 400; return; }
    const chunks = []; let size = 0;
    for await (const chunk of ctx.req) { size += chunk.length; if (size > 2048) { ctx.status = 413; return; } chunks.push(chunk); }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    if (form.get('decision') === 'cancel') {
      await provider.interactionFinished(ctx.req, ctx.res, { error: 'access_denied', error_description: 'Synthetic user cancelled.' }, { mergeWithLastSubmission: false });
      return;
    }
    if (interaction.prompt.name === 'login') {
      const subject = form.get('subject');
      if (!SYNTHETIC_SUBJECTS.includes(subject)) { ctx.status = 400; return; }
      await provider.interactionFinished(ctx.req, ctx.res, { login: { accountId: subject } }, { mergeWithLastSubmission: false });
      return;
    }
    if (interaction.prompt.name === 'consent' && form.get('decision') === 'allow') {
      const grant = interaction.grantId ? await provider.Grant.find(interaction.grantId)
        : new provider.Grant({ accountId: interaction.session.accountId, clientId: interaction.params.client_id });
      const details = interaction.prompt.details;
      if (details.missingOIDCScope) grant.addOIDCScope(details.missingOIDCScope.join(' '));
      if (details.missingOIDCClaims) grant.addOIDCClaims(details.missingOIDCClaims);
      await provider.interactionFinished(ctx.req, ctx.res, { consent: { grantId: await grant.save() } }, { mergeWithLastSubmission: true });
      return;
    }
    ctx.status = 400;
  });
  callback = provider.callback();
  return { issuer, provider, requests, clientId: SYNTHETIC_CLIENT,
    clientAuthentication: { method, ...(method === 'none' ? {} : { clientSecret: SYNTHETIC_SECRET }) },
    authorizationEndpoint: `${issuer}/auth`, tokenEndpoint: `${issuer}/token`, jwksUri: `${issuer}/jwks`,
    close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}

/** Fetch/redirect harness, NOT a browser or SameSite/CORS enforcement test. */
export class NetworkCookieJar {
  cookies = new Map();
  traces = [];
  header(url) {
    const target = new URL(url);
    return [...this.cookies.values()].filter(cookie => cookie.host === target.hostname && cookie.expires > Date.now()
      && (target.pathname === cookie.path || target.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`))
      && (!cookie.secure || target.protocol === 'https:')).sort((a, b) => b.path.length - a.path.length)
      .map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  }
  async fetch(url, init = {}) {
    const target = new URL(url);
    assert.equal(target.hostname, '127.0.0.1', 'Synthetic harness never requests a non-loopback host');
    const headers = new Headers(init.headers);
    if (!headers.has('cookie')) { const value = this.header(url); if (value) headers.set('cookie', value); }
    const result = await fetch(url, { ...init, headers, redirect: 'manual' });
    this.traces.push({ method: init.method ?? 'GET', url: String(url), status: result.status, cookies: result.headers.getSetCookie() });
    for (const raw of result.headers.getSetCookie()) {
      const [pair, ...attributes] = raw.split(';'); const split = pair.indexOf('=');
      const cookie = { name: pair.slice(0, split), value: pair.slice(split + 1), host: target.hostname,
        path: target.pathname.slice(0, target.pathname.lastIndexOf('/') + 1) || '/', expires: Infinity, secure: false, raw };
      for (const attribute of attributes) {
        const [name, ...parts] = attribute.trim().split('='); const value = parts.join('=');
        if (name.toLowerCase() === 'path') cookie.path = value;
        if (name.toLowerCase() === 'max-age') cookie.expires = Date.now() + Number(value) * 1000;
        if (name.toLowerCase() === 'secure') cookie.secure = true;
      }
      const key = `${cookie.host}:${cookie.path}:${cookie.name}`;
      if (cookie.expires <= Date.now() || cookie.value === '') this.cookies.delete(key); else this.cookies.set(key, cookie);
    }
    return result;
  }
}

/** Follow the real provider's login and consent forms, stopping BEFORE the RP callback. */
export async function authorizeAtProvider({ provider, jar, authorizationUrl, subject = 'synthetic-editor', cancel = false }) {
  let current = authorizationUrl;
  for (let step = 0; step < 12; step++) {
    const url = new URL(current);
    if (url.origin !== provider.issuer) return current;
    let response = await jar.fetch(current);
    if (response.status === 200 && url.pathname.startsWith('/test/interaction/')) {
      const html = await response.text();
      assert.ok(html.includes('Synthetic local sign-in'));
      const body = cancel ? 'decision=cancel' : html.includes('Current step: login')
        ? new URLSearchParams({ subject }).toString() : 'decision=allow';
      response = await jar.fetch(current, { method: 'POST', headers: { origin: provider.issuer, 'content-type': 'application/x-www-form-urlencoded' }, body });
    }
    assert.ok([302, 303].includes(response.status), `Expected provider redirect, got ${response.status}: ${await response.text()}`);
    current = new URL(response.headers.get('location'), current).href;
  }
  throw new Error('Provider authorization did not terminate within 12 redirects');
}
