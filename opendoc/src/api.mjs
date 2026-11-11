// Original OpenDoc reference implementation. No cloud SDK, fetch, or renderer.
import { StoreError } from './memory-store.mjs';
import { LIVE_DOCUMENT_LIMITS } from './collaboration-state.mjs';
import { liveDocumentProjection } from './live-document-store.mjs';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const ROLES = new Set(['owner', 'editor', 'viewer', 'commenter']);
const WRITE_ROLES = new Set(['owner', 'editor']);
const MAX_CONTENT_BYTES = 1024 * 1024;
// Escaping can expand JSON transport size without expanding decoded content.
const MAX_BODY_BYTES = 6 * MAX_CONTENT_BYTES + 4096;
const encoder = new TextEncoder();
const ERRORS = {
  BAD_REQUEST: [400, 'Invalid request.'], UNAUTHENTICATED: [401, 'Authentication required.'],
  FORBIDDEN: [403, 'Access denied.'], NOT_FOUND: [404, 'Not found.'],
  METHOD_NOT_ALLOWED: [405, 'Method not allowed.'], CONFLICT: [409, 'Document already exists.'],
  PRECONDITION_FAILED: [412, 'Read the current revision before writing.'], TOO_LARGE: [413, 'Payload exceeds the reference limit.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'Use application/json.'], PRECONDITION_REQUIRED: [428, 'If-Match is required.'],
  CAPACITY_EXCEEDED: [429, 'Reference store capacity exceeded.'], DEPENDENCY_UNAVAILABLE: [503, 'Service dependency unavailable.']
};
class RequestError extends Error { constructor(code) { super(code); this.code = code; } }
function fail(code) { throw new RequestError(code); }
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function validPrincipal(p) {
  return plainObject(p) && typeof p.principalId === 'string' && ID.test(p.principalId) && typeof p.tenantId === 'string' && TENANT_ID.test(p.tenantId) && ROLES.has(p.role);
}
function routeFor(path, liveEnabled) {
  if (path === '/healthz') return { type: 'health', methods: ['GET'] };
  if (path === '/api/v1/capabilities') return { type: 'capabilities', methods: ['GET'] };
  if (path === '/api/v1/session') return { type: 'session', methods: ['GET'] };
  if (path === '/api/v1/documents') return { type: 'collection', methods: ['GET', 'POST'] };
  if (liveEnabled && path === '/api/v1/live-documents') return { type: 'live-collection', methods: ['GET', 'POST'] };
  if (liveEnabled) {
    const live = /^\/api\/v1\/live-documents\/([^/]+)$/.exec(path);
    if (live) {
      let id; try { id = decodeURIComponent(live[1]); } catch { fail('BAD_REQUEST'); }
      if (!ID.test(id)) fail('BAD_REQUEST');
      return { type: 'live-document', methods: ['GET'], id };
    }
  }
  const match = /^\/api\/v1\/documents\/([^/]+)$/.exec(path);
  if (!match) return null;
  let id;
  try { id = decodeURIComponent(match[1]); } catch { fail('BAD_REQUEST'); }
  if (!ID.test(id)) fail('BAD_REQUEST');
  return { type: 'document', methods: ['GET', 'PUT'], id };
}
async function readDocument(request, creating, live = false) {
  const maxContent = live ? LIVE_DOCUMENT_LIMITS.maxContentBytes : MAX_CONTENT_BYTES;
  const maxBody = live ? 6 * maxContent + 4096 : MAX_BODY_BYTES;
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) fail('UNSUPPORTED_MEDIA_TYPE');
  if (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity') fail('UNSUPPORTED_MEDIA_TYPE');
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBody)) fail('TOO_LARGE');
  if (!request.body) fail('BAD_REQUEST');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBody) { await reader.cancel(); fail('TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('BAD_REQUEST'); }
  const fields = creating ? ['id', 'title', 'content'] : ['title', 'content'];
  if (!plainObject(input) || Object.keys(input).length !== fields.length || !fields.every(k => Object.hasOwn(input, k))) fail('BAD_REQUEST');
  if (creating && (typeof input.id !== 'string' || !ID.test(input.id))) fail('BAD_REQUEST');
  if (typeof input.title !== 'string' || input.title.length > 200 || typeof input.content !== 'string') fail('BAD_REQUEST');
  if (encoder.encode(input.content).byteLength > maxContent) fail('TOO_LARGE');
  return input;
}

/**
 * Standard Request -> Response API. The authenticator is a trusted server adapter,
 * not a client profile. It must verify credentials and resolve tenant membership.
 * Store methods must enforce isolation and atomic revision checks themselves.
 */
export function createOpenDocHandler({ store, liveStore, authenticate, allowedOrigins = [] }) {
  if (!store || !['list', 'get', 'create', 'replace'].every(k => typeof store[k] === 'function') || typeof authenticate !== 'function') throw new TypeError('Store and authenticator adapters required');
  if (liveStore !== undefined && (!liveStore || !['list', 'get', 'create', 'applyUpdate'].every(key => typeof liveStore[key] === 'function'))) throw new TypeError('Invalid live-document store');
  if (!Array.isArray(allowedOrigins)) throw new TypeError('Origin allowlist required');
  const origins = new Set(allowedOrigins.map(origin => {
    let u;
    try { u = new URL(origin); } catch { throw new TypeError('Invalid allowed origin'); }
    const loopback = u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.origin !== origin || u.username || u.password || !(u.protocol === 'https:' || loopback)) throw new TypeError('Use an exact HTTPS or loopback origin');
    return origin;
  }));

  return async function handle(request) {
    const origin = request.headers.get('origin');
    const headers = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Origin' });
    const respond = (body, status = 200, extra = {}) => {
      const h = new Headers(headers);
      for (const [k, v] of Object.entries(extra)) h.set(k, v);
      if (body !== null) h.set('content-type', 'application/json; charset=utf-8');
      return new Response(body === null ? null : JSON.stringify(body), { status, headers: h });
    };
    try {
      if (origin !== null && !origins.has(origin)) fail('FORBIDDEN');
      if (origin !== null) {
        headers.set('access-control-allow-origin', origin);
        headers.set('access-control-expose-headers', 'ETag, Location');
      }
      const url = new URL(request.url);
      if (url.search || url.hash || url.username || url.password) fail('BAD_REQUEST');
      const route = routeFor(url.pathname, Boolean(liveStore));
      if (!route) fail('NOT_FOUND');
      if (request.method === 'OPTIONS') {
        const method = request.headers.get('access-control-request-method');
        const requested = (request.headers.get('access-control-request-headers') ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
        if (!origin || !route.methods.includes(method) || !requested.every(h => ['authorization', 'content-type', 'if-match'].includes(h))) fail('FORBIDDEN');
        return respond(null, 204, { 'access-control-allow-methods': route.methods.join(', '), 'access-control-allow-headers': 'Authorization, Content-Type, If-Match', vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers' });
      }
      if (!route.methods.includes(request.method)) {
        headers.set('allow', route.methods.join(', ')); fail('METHOD_NOT_ALLOWED');
      }
      if (route.type === 'health') return respond({ status: 'ok' });
      if (route.type === 'capabilities') return respond({
        apiVersion: '1', implementation: 'opendoc-reference', storage: store.kind ?? 'custom-adapter', authorization: 'tenant-roles',
        limits: { contentBytes: MAX_CONTENT_BYTES, titleCodeUnits: 200, idCharacters: 64, ...(liveStore ? { liveContentBytes: LIVE_DOCUMENT_LIMITS.maxContentBytes } : {}) },
        ...(liveStore ? { liveDocuments: { authority: 'yjs', collection: '/api/v1/live-documents', protocol: 'opendoc-yjs-2', requiresWebSocketHost: true, storage: liveStore.kind ?? 'custom-adapter' } } : {}),
        features: { conditionalWrites: true, signedProfiles: true, liveCollaboration: false, documentSharing: false, enterpriseLogin: false, airgapVerified: false }
      });
      const identity = await authenticate(request);
      if (!validPrincipal(identity)) { headers.set('www-authenticate', 'Bearer'); fail('UNAUTHENTICATED'); }
      // Copy the narrow verified claims. Client inputs never set these values.
      const { principalId, tenantId, role } = identity;
      if (route.type === 'session') return respond({ principalId, tenantId, role });
      if (['POST', 'PUT'].includes(request.method) && !WRITE_ROLES.has(role)) fail('FORBIDDEN');
      if (route.type === 'live-collection') {
        if (request.method === 'GET') return respond({ documents: await liveStore.list(tenantId) });
        const doc = await liveStore.create(tenantId, await readDocument(request, true, true));
        return respond(liveDocumentProjection(doc), 201, { location: `/api/v1/live-documents/${encodeURIComponent(doc.id)}` });
      }
      if (route.type === 'live-document') {
        const doc = await liveStore.get(tenantId, route.id);
        if (!doc) fail('NOT_FOUND');
        return respond(liveDocumentProjection(doc));
      }
      if (route.type === 'collection') {
        if (request.method === 'GET') return respond({ documents: await store.list(tenantId) });
        const doc = await store.create(tenantId, await readDocument(request, true));
        return respond(doc, 201, { etag: `"${doc.revision}"`, location: `/api/v1/documents/${encodeURIComponent(doc.id)}` });
      }
      if (request.method === 'GET') {
        const doc = await store.get(tenantId, route.id);
        if (!doc) fail('NOT_FOUND');
        return respond(doc, 200, { etag: `"${doc.revision}"` });
      }
      const ifMatch = request.headers.get('if-match');
      if (!ifMatch) fail('PRECONDITION_REQUIRED');
      if (!/^"[1-9]\d{0,15}"$/.test(ifMatch) || !Number.isSafeInteger(Number(ifMatch.slice(1, -1)))) fail('PRECONDITION_FAILED');
      const input = await readDocument(request, false);
      const doc = await store.replace(tenantId, route.id, Number(ifMatch.slice(1, -1)), input);
      return respond(doc, 200, { etag: `"${doc.revision}"` });
    } catch (error) {
      const code = (error instanceof RequestError || error instanceof StoreError) && Object.hasOwn(ERRORS, error.code) ? error.code : 'DEPENDENCY_UNAVAILABLE';
      const [status, message] = ERRORS[code];
      return respond({ error: { code, message } }, status);
    }
  };
}
