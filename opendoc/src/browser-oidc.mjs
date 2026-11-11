// Original OpenDoc browser BFF reference. MIT. Bounded memory or shared durable state.
// Protocol validation and ID-token signature verification use openid-client.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as oidc from 'openid-client';
import { createOpenDocHandler } from './api.mjs';
import { BrowserAuthStateError, MemoryBrowserAuthState } from './browser-auth-state.mjs';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}(?![\s\S])/;
const TENANT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}(?![\s\S])/;
const OPAQUE = /^[a-zA-Z0-9_-]{43}(?![\s\S])/;
const ROLES = new Set(['owner', 'editor', 'viewer', 'commenter']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DEFAULTS = Object.freeze({
  sessionTtlMs: 30 * 60 * 1000, transactionTtlMs: 5 * 60 * 1000,
  ticketTtlMs: 60 * 1000, operationTimeoutMs: 10000, fetchTimeoutMs: 5000,
  maxSessions: 1000, maxTransactions: 1000, maxTickets: 1000,
  maxPendingOperations: 32, maxProviderResponseBytes: 256 * 1024
});
export const BROWSER_OIDC_LIMITS = DEFAULTS;
const ERRORS = {
  BAD_REQUEST: [400, 'Invalid request.'], UNAUTHENTICATED: [401, 'Authentication required.'],
  FORBIDDEN: [403, 'Access denied.'], NOT_FOUND: [404, 'Not found.'],
  METHOD_NOT_ALLOWED: [405, 'Method not allowed.'], CAPACITY_EXCEEDED: [429, 'Reference capacity exceeded.'],
  DEPENDENCY_UNAVAILABLE: [503, 'Service unavailable.']
};
class BrowserError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new BrowserError(code); };
const secret = () => randomBytes(32).toString('base64url');
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const bounded = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u0020\u007f]/.test(value);
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function trustedUrl(value, allowInsecure, name) {
  if (!bounded(value, 2048)) throw new TypeError(`Explicit ${name} required`);
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search || url.href !== value && url.href !== `${value}/` ||
    !(url.protocol === 'https:' || (allowInsecure && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new TypeError(`Invalid trusted ${name}; HTTPS required except explicit loopback development`);
  }
  return url;
}
function cookieValues(request) {
  const raw = request.headers.get('cookie') ?? '';
  if (raw.length > 8192) fail('BAD_REQUEST');
  const result = new Map();
  for (const part of raw.split(';')) {
    if (!part.trim()) continue;
    const at = part.indexOf('=');
    if (at <= 0) fail('BAD_REQUEST');
    const name = part.slice(0, at).trim();
    if (result.has(name)) fail('BAD_REQUEST');
    result.set(name, part.slice(at + 1).trim());
  }
  return result;
}
async function smallJson(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '') ||
    (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity')) fail('BAD_REQUEST');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 1024)) fail('BAD_REQUEST');
  if (!request.body) fail('BAD_REQUEST');
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) { void reader.cancel().catch(() => {}); fail('BAD_REQUEST'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { fail('BAD_REQUEST'); }
  if (!plain(body)) fail('BAD_REQUEST');
  return body;
}
function response(body, status = 200, cookies = [], location) {
  const headers = new Headers({ 'cache-control': 'no-store', pragma: 'no-cache', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
  if (body !== null) headers.set('content-type', 'application/json; charset=utf-8');
  if (location) headers.set('location', location);
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}
function failure(error, cookies = []) {
  const code = error instanceof BrowserError || error instanceof BrowserAuthStateError ? error.code : 'DEPENDENCY_UNAVAILABLE';
  const [status, message] = ERRORS[code];
  return response({ error: { code, message } }, status, cookies);
}

/**
 * Operator configuration only. No discovery, signup, email linking, or refresh.
 * Use createHandler({store}) for browser REST; authenticate also enforces CSRF
 * on unsafe methods, so using it directly cannot accidentally skip the check.
 * The caller owns HTTPS, canonical Request URLs, strict Host validation and
 * request/body deadlines. This module never starts a public listener.
 */
export function createBrowserOidc({
  issuer, clientId, clientAuthentication, redirectUri, authorizationEndpoint,
  tokenEndpoint, jwksUri, activeTenantId, resolveMembership,
  allowInsecureLoopback = false, successPath = '/', limits = {}, authState
} = {}) {
  if (typeof allowInsecureLoopback !== 'boolean') throw new TypeError('Invalid loopback option');
  const issuerUrl = trustedUrl(issuer, allowInsecureLoopback, 'issuer');
  const redirect = trustedUrl(redirectUri, allowInsecureLoopback, 'redirectUri');
  trustedUrl(authorizationEndpoint, allowInsecureLoopback, 'authorizationEndpoint');
  trustedUrl(tokenEndpoint, allowInsecureLoopback, 'tokenEndpoint');
  trustedUrl(jwksUri, allowInsecureLoopback, 'jwksUri');
  if (redirect.pathname !== '/auth/callback') throw new TypeError('redirectUri must have /auth/callback path');
  // Development must be wholly loopback, not a way to downgrade a public app.
  if (allowInsecureLoopback && [issuerUrl, redirect, new URL(authorizationEndpoint), new URL(tokenEndpoint), new URL(jwksUri)]
    .some(url => !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new TypeError('Development configuration must be entirely loopback');
  if (!bounded(clientId, 256) || !plain(clientAuthentication) ||
    Object.keys(clientAuthentication).some(key => !['method', 'clientSecret'].includes(key)) ||
    !['client_secret_basic', 'client_secret_post', 'none'].includes(clientAuthentication.method) ||
    (clientAuthentication.method === 'none' ? clientAuthentication.clientSecret !== undefined : !bounded(clientAuthentication.clientSecret, 4096))) {
    throw new TypeError('Explicit supported clientAuthentication required');
  }
  if (typeof activeTenantId !== 'string' || !TENANT.test(activeTenantId) || typeof resolveMembership !== 'function') throw new TypeError('Trusted tenant and membership resolver required');
  if (typeof successPath !== 'string' || successPath.length > 512 || !successPath.startsWith('/') || successPath.startsWith('//') ||
    /[\\?#%\u0000-\u0020\u007f]/.test(successPath) || new URL(successPath, redirect.origin).pathname !== successPath || successPath.startsWith('/auth/')) throw new TypeError('A fixed local successPath is required');
  if (!plain(limits) || Object.keys(limits).some(key => !Object.hasOwn(DEFAULTS, key))) throw new TypeError('Unknown browser limit');
  const config = { ...DEFAULTS, ...limits };
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULTS[key]) throw new TypeError(`Invalid ${key}; limits may only be tightened`);
  }
  const auth = clientAuthentication.method === 'none' ? oidc.None() :
    clientAuthentication.method === 'client_secret_basic' ? oidc.ClientSecretBasic(clientAuthentication.clientSecret) : oidc.ClientSecretPost(clientAuthentication.clientSecret);
  const client = new oidc.Configuration({
    issuer, authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint, jwks_uri: jwksUri,
    authorization_response_iss_parameter_supported: true,
    response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], id_token_signing_alg_values_supported: ['RS256']
  }, clientId, { id_token_signed_response_alg: 'RS256', [oidc.clockTolerance]: 0 }, auth);
  if (allowInsecureLoopback) oidc.allowInsecureRequests(client);
  client.timeout = config.fetchTimeoutMs / 1000;
  oidc.enableNonRepudiationChecks(client);
  // Only these exact operator-pinned backchannel endpoints may be fetched.
  // Redirects are rejected (including same-host redirects); size includes the
  // decoded body. DNS/IP routing remains an operator egress-policy obligation.
  client[oidc.customFetch] = async (input, options = {}) => {
    const url = String(input);
    const method = (options.method ?? 'GET').toUpperCase();
    if (!((url === tokenEndpoint && method === 'POST') || (url === jwksUri && method === 'GET'))) throw new Error('Untrusted provider request');
    const timeout = AbortSignal.timeout(config.fetchTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const result = await fetch(input, { ...options, signal, redirect: 'error' });
    const length = result.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > config.maxProviderResponseBytes)) {
      void result.body?.cancel().catch(() => {}); throw new Error('Provider response too large');
    }
    const chunks = []; let size = 0;
    const reader = result.body?.getReader();
    if (reader) try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > config.maxProviderResponseBytes) { void reader.cancel().catch(() => {}); throw new Error('Provider response too large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return new Response(Buffer.concat(chunks), { status: result.status, statusText: result.statusText, headers: result.headers });
  };
  const prefix = allowInsecureLoopback ? 'opendoc-dev-' : '__Host-opendoc-';
  const names = Object.freeze({ transaction: `${prefix}transaction`, session: `${prefix}session`, csrf: `${prefix}csrf` });
  const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(age / 1000))}${allowInsecureLoopback ? '' : '; Secure'}`;
  const clearTransaction = () => cookie(names.transaction, '', 0);
  const clearSession = () => [cookie(names.session, '', 0), cookie(names.csrf, '', 0)];
  const ownsState = authState === undefined;
  const state = ownsState ? new MemoryBrowserAuthState() : authState;
  if (!state || typeof state.configure !== 'function' || typeof state.run !== 'function') throw new TypeError('Invalid browser auth state adapter');
  // A namespace cannot silently reinterpret a session under a different trust
  // configuration, tenant or lifetime policy. No client secret is persisted.
  state.configure({ binding: createHash('sha256').update(JSON.stringify({ issuer, clientId,
    clientAuthentication: clientAuthentication.method, redirectUri, authorizationEndpoint,
    tokenEndpoint, jwksUri, activeTenantId, allowInsecureLoopback, successPath, config })).digest('hex'), limits: config });
  let pending = 0, stopped = false;
  async function atomic(context, operation, input = {}) {
    checkContext(context);
    const result = await state.run(operation, input, () => checkContext(context));
    checkContext(context);
    return result;
  }
  // Timed-out work retains its slot until it actually settles. A wedged resolver
  // cannot produce an unbounded chain of detached background promises.
  async function admitted(operation) {
    if (stopped) fail('DEPENDENCY_UNAVAILABLE');
    if (pending >= config.maxPendingOperations) fail('CAPACITY_EXCEEDED');
    pending++;
    const context = { expired: false, deadline: Date.now() + config.operationTimeoutMs };
    let timer;
    const work = Promise.resolve().then(() => operation(context)).finally(() => { pending--; });
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { context.expired = true; reject(new BrowserError('DEPENDENCY_UNAVAILABLE')); }, config.operationTimeoutMs); });
    try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
  }
  function checkContext(context) { if (context.expired || Date.now() >= context.deadline || stopped) fail('DEPENDENCY_UNAVAILABLE'); }
  function requestUrl(request, callback = false) {
    const url = new URL(request.url);
    if (url.origin !== redirect.origin || url.username || url.password || url.hash || url.href.length > 8192 || (!callback && url.search)) fail('BAD_REQUEST');
    return url;
  }
  function checkOrigin(request) {
    if (request.headers.get('origin') !== redirect.origin || request.headers.get('sec-fetch-site') === 'cross-site') fail('FORBIDDEN');
  }
  function checkCsrf(request, session, cookies) {
    checkOrigin(request);
    if (!equal(request.headers.get('x-opendoc-csrf'), session.csrfToken) || !equal(cookies.get(names.csrf), session.csrfToken) ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) fail('FORBIDDEN');
  }
  async function membership(subject) {
    const value = await resolveMembership(Object.freeze({ issuer, subject, activeTenantId }));
    if (!plain(value) || typeof value.principalId !== 'string' || !ID.test(value.principalId) || value.tenantId !== activeTenantId || !ROLES.has(value.role)) return null;
    return { principalId: value.principalId, tenantId: activeTenantId, role: value.role };
  }
  async function sessionIdentity(request, context, mutation = !SAFE_METHODS.has(request.method)) {
    requestUrl(request);
    if (request.headers.has('authorization')) return null; // Never mix credentials.
    const cookies = cookieValues(request);
    const id = cookies.get(names.session);
    const session = OPAQUE.test(id ?? '') ? await atomic(context, 'getSession', { id }) : null;
    if (!session) return null;
    if (mutation) checkCsrf(request, session, cookies);
    const identity = await membership(session.subject);
    checkContext(context);
    if (!identity || identity.principalId !== session.principalId) { await atomic(context, 'removeSession', { id, version: session.version }); return null; }
    if (!await atomic(context, 'checkSession', { id, version: session.version })) return null;
    return { identity, session, id };
  }
  async function authenticate(request) {
    try { return await admitted(async context => (await sessionIdentity(request, context))?.identity ?? null); }
    catch (error) { if (error instanceof BrowserError && ['BAD_REQUEST', 'FORBIDDEN'].includes(error.code)) return null; throw error; }
  }
  async function handleAuth(request) {
    let callbackCleanup = null, initiationCleanup = null;
    try {
      return await admitted(async context => {
        try {
          const raw = new URL(request.url);
          const url = requestUrl(request, raw.pathname === '/auth/callback');
          const methods = { '/auth/login': 'POST', '/auth/callback': 'GET', '/auth/session': 'GET', '/auth/logout': 'POST', '/auth/collaboration-ticket': 'POST' };
          if (!Object.hasOwn(methods, url.pathname)) fail('NOT_FOUND');
          if (request.method !== methods[url.pathname]) fail('METHOD_NOT_ALLOWED');
          if (request.headers.has('authorization')) fail('BAD_REQUEST');
          if (url.pathname === '/auth/login') {
            checkOrigin(request);
            if (request.headers.get('x-opendoc-login') !== '1') fail('FORBIDDEN');
            const cookies = cookieValues(request);
            const old = cookies.get(names.transaction), prior = cookies.get(names.session);
            const intentId = secret();
            initiationCleanup = { intentId };
            // The intent is persisted BEFORE reading the body or calculating PKCE.
            // Logout and newer initiation can therefore fence work on another host.
            await atomic(context, 'beginLogin', { intentId,
              oldTransactionId: OPAQUE.test(old ?? '') ? old : null,
              priorSessionId: OPAQUE.test(prior ?? '') ? prior : null });
            const body = await smallJson(request);
            if (!await atomic(context, 'checkIntent', { intentId })) fail('UNAUTHENTICATED');
            if (Object.keys(body).length) fail('BAD_REQUEST');
            const transactionId = secret(), stateValue = oidc.randomState(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier();
            const challenge = await oidc.calculatePKCECodeChallenge(verifier);
            await atomic(context, 'publishLogin', { intentId, transactionId, transaction: { state: stateValue, nonce, verifier } });
            initiationCleanup = null;
            const authorizationUrl = oidc.buildAuthorizationUrl(client, {
              response_type: 'code', scope: 'openid', redirect_uri: redirectUri,
              state: stateValue, nonce, code_challenge: challenge, code_challenge_method: 'S256'
            });
            return response({ authorizationUrl: authorizationUrl.href }, 200, [cookie(names.transaction, transactionId, config.transactionTtlMs)]);
          }
          if (url.pathname === '/auth/callback') {
            const cookies = cookieValues(request), id = cookies.get(names.transaction);
            const claimId = secret();
            const transaction = OPAQUE.test(id ?? '') ? await atomic(context, 'consumeTransaction', { id, claimId }) : null;
            if (!transaction) fail('UNAUTHENTICATED');
            callbackCleanup = { id, claimId };
            const checkTransaction = async () => {
              if (!await atomic(context, 'checkTransaction', { id, claimId })) fail('UNAUTHENTICATED');
            };
            await checkTransaction();
            const entries = [...url.searchParams.keys()];
            if (new Set(entries).size !== entries.length || entries.some(key => !['code', 'state', 'iss', 'error', 'error_description', 'error_uri', 'session_state'].includes(key)) ||
              !equal(url.searchParams.get('state'), transaction.state) || url.searchParams.get('iss') !== issuer) fail('UNAUTHENTICATED');
            if (url.searchParams.has('error')) fail('UNAUTHENTICATED');
            if (!bounded(url.searchParams.get('code'), 2048)) fail('UNAUTHENTICATED');
            let claims;
            try {
              const tokens = await oidc.authorizationCodeGrant(client, url, {
                pkceCodeVerifier: transaction.verifier, expectedState: transaction.state, expectedNonce: transaction.nonce, idTokenExpected: true
              });
              claims = tokens.claims(); // Access/refresh/ID token strings are never retained.
            } catch { fail('UNAUTHENTICATED'); }
            await checkTransaction();
            const now = Date.now(), seconds = Math.floor(now / 1000);
            if (!claims || !bounded(claims.sub, 512) || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
              claims.iat > seconds || claims.iat < seconds - 300 || claims.exp <= seconds || claims.exp <= claims.iat || claims.exp - claims.iat > 3600) fail('UNAUTHENTICATED');
            const identity = await membership(claims.sub);
            await checkTransaction();
            if (!identity) fail('FORBIDDEN');
            // A successful login always rotates the session and its CSRF secret.
            const previous = cookies.get(names.session);
            const sessionId = secret(), csrfToken = secret();
            const { expiresAt } = await atomic(context, 'finishCallback', { id, claimId,
              previous: OPAQUE.test(previous ?? '') ? previous : null, sessionId, tokenExpiresAt: claims.exp * 1000,
              session: { subject: claims.sub, principalId: identity.principalId, csrfToken, version: secret() } });
            return response(null, 303, [clearTransaction(), cookie(names.session, sessionId, expiresAt - Date.now()), cookie(names.csrf, csrfToken, expiresAt - Date.now())], successPath);
          }
          const current = await sessionIdentity(request, context);
          if (!current) fail('UNAUTHENTICATED');
          if (url.pathname === '/auth/session') return response({ ...current.identity, csrfToken: current.session.csrfToken, expiresAt: current.session.expiresAt });
          const body = await smallJson(request);
          checkContext(context);
          if (!await atomic(context, 'checkSession', { id: current.id, version: current.session.version })) fail('UNAUTHENTICATED');
          if (url.pathname === '/auth/logout') {
            if (Object.keys(body).length) fail('BAD_REQUEST');
            const old = cookieValues(request).get(names.transaction);
            if (!await atomic(context, 'removeSession', { id: current.id, version: current.session.version,
              oldTransactionId: OPAQUE.test(old ?? '') ? old : null })) fail('UNAUTHENTICATED');
            return response(null, 204, [...clearSession(), clearTransaction()]);
          }
          const live = Object.hasOwn(body, 'documentId');
          const id = live ? body.documentId : body.roomId;
          if (Object.keys(body).length !== 1 || typeof id !== 'string' || !ID.test(id)) fail('BAD_REQUEST');
          // Namespace binding prevents a ticket for a standalone room authorizing a live document.
          const roomId = live ? `live:${id}` : id;
          const ticket = secret();
          const { expiresAt } = await atomic(context, 'issueTicket', { ticketId: ticket, sessionId: current.id,
            version: current.session.version, roomId });
          return response({ ticket, expiresAt, ...(live ? { path: `/api/v1/live-documents/${id}/collaboration` } : {}) });
        } catch (error) {
          let cookies = [];
          if (callbackCleanup) {
            // Only the durable claim owner may clear its cookie. Superseded and
            // duplicate callbacks cannot erase a newer browser transaction.
            try { if (await state.run('cancelCallback', callbackCleanup)) cookies = [clearTransaction()]; }
            catch { error = new BrowserError('DEPENDENCY_UNAVAILABLE'); }
          }
          return failure(error, cookies);
        } finally {
          if (initiationCleanup) {
            // Cleanup retains the admission slot and cannot extend the response
            // deadline. Durable expiry bounds an abandoned initiation after crash.
            try { await state.run('abortLogin', initiationCleanup); } catch { /* No unsafe retry. */ }
          }
        }
      });
    } catch (error) { return failure(error); }
  }

  async function authenticateCollaboration(request, { connectionId } = {}) {
    return admitted(async context => {
      const url = new URL(request.url);
      const standalone = /^\/api\/v1\/collaboration\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})(?![\s\S])/.exec(url.pathname)?.[1];
      const live = /^\/api\/v1\/live-documents\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\/collaboration(?![\s\S])/.exec(url.pathname)?.[1];
      const room = live ? `live:${live}` : standalone;
      if (!room || url.search || url.hash || !OPAQUE.test(connectionId ?? '') || request.headers.get('origin') !== redirect.origin) return null;
      const authorization = request.headers.get('authorization');
      const token = /^Bearer ([a-zA-Z0-9_-]{43})(?![\s\S])/.exec(authorization ?? '')?.[1];
      if (!token) return null;
      const bound = await atomic(context, 'bindTicket', { ticketId: token, roomId: room, connectionId });
      if (!bound) return null;
      const { ticket, session } = bound;
      const identity = await membership(session.subject);
      checkContext(context);
      if (!identity || identity.principalId !== session.principalId) {
        await atomic(context, 'removeSession', { id: ticket.sessionId, version: session.version }); return null;
      }
      return await atomic(context, 'checkTicket', { ticketId: token, roomId: room, connectionId,
        sessionId: ticket.sessionId, version: session.version }) ? identity : null;
    });
  }
  function createHandler({ store, liveStore } = {}) {
    const rest = createOpenDocHandler({ store, liveStore, authenticate, allowedOrigins: [redirect.origin] });
    return async request => {
      if (new URL(request.url).pathname.startsWith('/auth/')) return handleAuth(request);
      try {
        requestUrl(request);
        // Return an explicit CSRF rejection before invoking any REST write.
        if (!SAFE_METHODS.has(request.method)) {
          const current = await admitted(context => sessionIdentity(request, context));
          if (!current) fail('UNAUTHENTICATED');
        }
        const result = await rest(request);
        result.headers.set('referrer-policy', 'no-referrer');
        return result;
      } catch (error) { return failure(error); }
    };
  }
  return Object.freeze({
    handleAuth, authenticate, authenticateCollaboration, createHandler,
    cookieNames: names,
    stats: () => {
      const summarize = ({ sessions, transactions, tickets }) => Object.freeze({ sessions, transactions, tickets, pendingOperations: pending });
      const result = state.run('stats');
      return result && typeof result.then === 'function' ? result.then(summarize) : summarize(result);
    },
    close() { stopped = true; if (ownsState) state.clear(); }
  });
}
