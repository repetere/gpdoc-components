// Original experimental OpenDoc transport. MIT. Not y-websocket compatible.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { MAX_COLLABORATION_UPDATE_BYTES, MAX_COLLABORATION_STATE_BYTES, LIVE_DOCUMENT_LIMITS } from './collaboration-state.mjs';

const ROUTE = /^\/api\/v1\/collaboration\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})$/;
const LIVE_ROUTE = /^\/api\/v1\/live-documents\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\/collaboration$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const TENANT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const ROLES = new Set(['owner', 'editor', 'viewer', 'commenter']);
const WRITERS = new Set(['owner', 'editor']);
const EMPTY_STATE = new Uint8Array([0, 0]);
const DEFAULTS = Object.freeze({
  maxConnections: 128, maxConnectionsPerRoom: 32, maxRooms: 128,
  maxPendingPerConnection: 8, maxPendingOperations: 128, maxDependencyOperations: 128,
  maxBufferedBytes: 2 * 1024 * 1024, maxTokenBytes: 8192,
  authenticationTimeoutMs: 5000, operationTimeoutMs: 5000,
  revalidationIntervalMs: 30000, closeTimeoutMs: 500
});
export const COLLABORATION_TRANSPORT_LIMITS = DEFAULTS;

class TransportError extends Error { constructor(code) { super(code); this.code = code; } }
function validIdentity(value) {
  return value && typeof value.principalId === 'string' && ID.test(value.principalId) &&
    typeof value.tenantId === 'string' && TENANT.test(value.tenantId) && ROLES.has(value.role);
}
function parseOrigins(allowedOrigins) {
  if (!Array.isArray(allowedOrigins)) throw new TypeError('An explicit origin allowlist is required');
  return new Set(allowedOrigins.map(origin => {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new TypeError('Use exact HTTPS or loopback origins');
    }
    return origin;
  }));
}
function stateFrame(value, allowMissing = true) {
  const missing = value === null && allowMissing;
  const revision = missing ? 0 : value?.revision;
  const state = missing ? EMPTY_STATE : value?.state;
  if (!Number.isSafeInteger(revision) || revision < (missing ? 0 : 1) || !(state instanceof Uint8Array) ||
    state.byteLength < 2 || state.byteLength > MAX_COLLABORATION_STATE_BYTES) {
    throw new TransportError('DEPENDENCY_UNAVAILABLE');
  }
  const frame = Buffer.allocUnsafe(9 + state.byteLength);
  frame[0] = 2;
  frame.writeBigUInt64BE(BigInt(revision), 1);
  frame.set(state, 9);
  return frame;
}

/**
 * Attach ONLY to an explicitly provided HTTP(S) server. The caller owns TLS,
 * proxy trust, durable storage, room membership policy and HTTP request handling.
 * authenticate receives a clean Request with only the first-frame Bearer token,
 * plus frozen {connectionId}: a stable, random server-owned ID for this socket.
 * It MUST verify credentials and consult current trusted tenant membership on
 * every call. A verified tenant role grants all rooms in that tenant in v1.
 * sharedLiveSync opts live v2 rooms into bounded periodic reads from ONE fixed
 * PostgreSQL primary/schema. The trusted store kind is not authority discovery
 * or failover protection. Default behavior and standalone v1 stay process-local.
 */
export function attachCollaborationServer({ server, store, liveStore, authenticate, allowedOrigins, allowMissingOrigin = false, limits = {}, sharedLiveSync } = {}) {
  if (!server || typeof server.on !== 'function' || (!store && !liveStore) ||
      [store, liveStore].filter(Boolean).some(value => typeof value.get !== 'function' || typeof value.applyUpdate !== 'function') || typeof authenticate !== 'function') {
    throw new TypeError('Explicit HTTP server, collaboration store and authenticator required');
  }
  if (typeof allowMissingOrigin !== 'boolean') throw new TypeError('Invalid allowMissingOrigin');
  let syncInterval;
  if (sharedLiveSync !== undefined) {
    if (!sharedLiveSync || Object.getPrototypeOf(sharedLiveSync) !== Object.prototype ||
      Object.keys(sharedLiveSync).some(key => key !== 'intervalMs') ||
      liveStore?.kind !== 'postgresql-live-documents' || typeof liveStore.getIfChanged !== 'function') {
      throw new TypeError('sharedLiveSync requires a PostgreSQL live store and explicit options');
    }
    syncInterval = Object.hasOwn(sharedLiveSync, 'intervalMs') ? sharedLiveSync.intervalMs : 1000;
    if (!Number.isSafeInteger(syncInterval) || syncInterval < 50 || syncInterval > 30000) throw new TypeError('Invalid sharedLiveSync intervalMs');
  }
  const origins = parseOrigins(allowedOrigins);
  if (!limits || typeof limits !== 'object' || Array.isArray(limits) || Object.keys(limits).some(key => !Object.hasOwn(DEFAULTS, key))) throw new TypeError('Unknown transport limit');
  const config = { ...DEFAULTS, ...limits };
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULTS[key]) throw new TypeError(`Invalid ${key}; limits may only be tightened`);
  }
  const wss = new WebSocketServer({ noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload: liveStore ? LIVE_DOCUMENT_LIMITS.maxUpdateBytes + 5 : MAX_COLLABORATION_UPDATE_BYTES + 1 });
  const clients = new Set();
  const rooms = new Map();
  let stopped = false;
  let pending = 0;
  let dependencies = 0;
  let syncTimer;

  function stop(client, code = 1008, reason = 'Access denied.') {
    if (client.closed) return;
    client.closed = true;
    clearTimeout(client.authenticationTimer);
    clearInterval(client.revalidationTimer);
    client.token = null;
    if (client.ws.readyState === WebSocket.OPEN) client.ws.close(code, reason);
    else client.ws.terminate();
    client.closeTimer = setTimeout(() => client.ws.terminate(), config.closeTimeoutMs);
    client.closeTimer.unref();
  }
  function failClient(client, error) {
    const code = error?.code;
    if (code === 'BAD_REQUEST') stop(client, 1008, 'Invalid message.');
    else if (code === 'TOO_LARGE') stop(client, 1009, 'Message too large.');
    else if (code === 'CAPACITY_EXCEEDED') stop(client, 1013, 'Capacity exceeded.');
    else if (code === 'UNAUTHENTICATED' || code === 'FORBIDDEN' || code === 'NOT_FOUND') stop(client);
    else stop(client, 1011, 'Service unavailable.');
  }
  // A timed-out dependency keeps its admission slot until it really settles.
  // An uncooperative adapter cannot accumulate unlimited abandoned promises.
  async function dependency(operation, { fence = false, onTimeout = () => {} } = {}) {
    if (stopped) throw new TransportError('DEPENDENCY_UNAVAILABLE');
    if (dependencies >= config.maxDependencyOperations) throw new TransportError('CAPACITY_EXCEEDED');
    dependencies++;
    let timer;
    let timedOut = false;
    const work = Promise.resolve().then(operation).finally(() => { dependencies--; });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true; onTimeout(); reject(new TransportError('DEPENDENCY_UNAVAILABLE'));
      }, config.operationTimeoutMs);
      timer.unref();
    });
    try { return await Promise.race([work, timeout]); } catch (error) {
      // A mutation with uncertain outcome fences this room until the actual
      // commit/rollback settles. New readers cannot overtake a timed-out edit.
      if (timedOut && fence) await work.catch(() => {});
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function authorize(client, writing = false) {
    if (client.closed || !client.token) throw new TransportError('UNAUTHENTICATED');
    const request = new Request(`http://opendoc.invalid${client.path}`, {
      headers: { authorization: `Bearer ${client.token}`, ...(client.origin ? { origin: client.origin } : {}) }
    });
    const identity = await dependency(() => authenticate(request, client.authContext));
    if (client.closed || !validIdentity(identity) || (client.identity &&
      (identity.tenantId !== client.identity.tenantId || identity.principalId !== client.identity.principalId))) throw new TransportError('UNAUTHENTICATED');
    client.identity = { principalId: identity.principalId, tenantId: identity.tenantId, role: identity.role };
    if (writing && !WRITERS.has(identity.role)) throw new TransportError('FORBIDDEN');
    return client.identity;
  }
  function send(client, data) {
    if (stopped || client.closed || client.ws.readyState !== WebSocket.OPEN) return false;
    const size = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    if (client.ws.bufferedAmount + size > config.maxBufferedBytes) { stop(client, 1013, 'Slow consumer.'); return false; }
    client.ws.send(data, error => { if (error) stop(client, 1011, 'Connection unavailable.'); });
    return true;
  }
  function requireResync(room) {
    for (const receiver of room.clients) stop(receiver, 1011, 'Room resync required.');
  }
  function roomFrame(room, value, allowMissing = true) {
    try {
      const frame = stateFrame(value, allowMissing);
      if (room.shared) {
        const revision = value?.revision;
        const digest = createHash('sha256').update(frame.subarray(9)).digest('hex');
        if (revision < room.revision || revision === room.revision && digest !== room.digest) {
          throw new TransportError('DEPENDENCY_UNAVAILABLE');
        }
        room.revision = revision; room.digest = digest;
      }
      return frame;
    } catch (error) { if (room.shared) requireResync(room); throw error; }
  }
  function sendState(client, frame, force = false) {
    if (client.room?.shared) {
      const revision = Number(frame.readBigUInt64BE(1));
      if (revision < client.revision) { requireResync(client.room); throw new TransportError('DEPENDENCY_UNAVAILABLE'); }
      if (revision === client.revision && !force) return;
      if (send(client, frame)) client.revision = revision;
    } else send(client, frame);
  }
  async function fanout(room, frame) {
    // Reauthorization is independent for every receiver, including on a no-op
    // mutation; an unchanged state is never confused with a persistence ACK.
    await Promise.all([...room.clients].map(async receiver => {
      try { await authorize(receiver); sendState(receiver, frame); } catch (error) { failClient(receiver, error); }
    }));
  }
  function retireRoom(room) {
    if (room.clients.size === 0 && room.pending === 0) rooms.delete(room.key);
  }
  async function roomOperation(room, action) {
    room.pending++;
    const operation = room.tail.then(async () => { if (!stopped) await action(room); });
    room.tail = operation.catch(() => {});
    try { await operation; } finally { room.pending--; retireRoom(room); }
  }
  async function inRoom(client, action) {
    const key = JSON.stringify([client.live ? 'live' : 'standalone', client.identity.tenantId, client.roomId]);
    let room = rooms.get(key);
    if (!room) {
      if (rooms.size >= config.maxRooms) throw new TransportError('CAPACITY_EXCEEDED');
      room = { key, clients: new Set(), pending: 0, tail: Promise.resolve(),
        shared: Boolean(client.live && syncInterval), tenantId: client.identity.tenantId,
        documentId: client.roomId, store: client.store, revision: 0, digest: null };
      rooms.set(key, room);
    }
    await roomOperation(room, async () => { if (!client.closed) await action(room); });
  }
  function enqueue(client, action) {
    if (client.closed) return;
    if (client.pending >= config.maxPendingPerConnection || pending >= config.maxPendingOperations) { stop(client, 1013, 'Capacity exceeded.'); return; }
    client.pending++; pending++;
    client.tail = client.tail.then(async () => { if (!client.closed) await action(); })
      .catch(error => failClient(client, error)).finally(() => { client.pending--; pending--; });
  }
  async function snapshot(client, room) {
    await authorize(client);
    const value = await dependency(() => client.store.get(client.identity.tenantId, client.roomId));
    if (client.live && value === null) throw new TransportError('NOT_FOUND');
    const frame = roomFrame(room, value, !client.live);
    // Membership may have been revoked while the storage read was pending.
    await authorize(client);
    sendState(client, frame, true);
  }
  function scheduleSync() {
    if (stopped || syncInterval === undefined) return;
    syncTimer = setTimeout(pollRooms, syncInterval); syncTimer.unref();
  }
  async function pollRooms() {
    // Snapshot the bounded room set once. One sweep and at most one queued or
    // active poll exist, regardless of slow storage, auth, or missed intervals.
    for (const room of [...rooms.values()]) {
      if (stopped) break;
      // Never queue behind a room's unresolved mutation fence: an adapter that
      // never settles must not prevent healthy, unrelated rooms from polling.
      // No await separates this admission check from roomOperation below.
      if (!room.shared || room.clients.size === 0 || room.pending !== 0) continue;
      if (pending >= config.maxPendingOperations) break;
      pending++;
      try {
        await roomOperation(room, async () => {
          const receivers = [...room.clients].filter(client => !client.closed);
          if (!receivers.length) return;
          // A join or explicit sync may observe a newer revision before idle
          // room members do. Poll from the oldest delivered revision, while
          // validating every result against the maximum observed room floor.
          const revision = Math.min(...receivers.map(client => client.revision));
          const value = await dependency(() => room.store.getIfChanged(room.tenantId, room.documentId, revision));
          if (stopped) return;
          if (value === null) {
            if (revision !== room.revision) throw new TransportError('DEPENDENCY_UNAVAILABLE');
            return;
          }
          const frame = roomFrame(room, value, false);
          await fanout(room, frame);
        });
      } catch { requireResync(room); }
      finally { pending--; }
    }
    scheduleSync();
  }
  async function processMessage(client, bytes, binary) {
    if (!client.authenticated) {
      if (binary || bytes.byteLength > config.maxTokenBytes + 64) throw new TransportError('BAD_REQUEST');
      let auth;
      try { auth = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new TransportError('BAD_REQUEST'); }
      if (!auth || typeof auth !== 'object' || Array.isArray(auth) || Object.keys(auth).length !== 2 || auth.type !== 'authenticate' ||
        typeof auth.token !== 'string' || !/^[\x21-\x7e]+$/.test(auth.token) || Buffer.byteLength(auth.token) > config.maxTokenBytes) throw new TransportError('BAD_REQUEST');
      client.token = auth.token;
      await authorize(client);
      await inRoom(client, async room => {
        if (room.clients.size >= config.maxConnectionsPerRoom) throw new TransportError('CAPACITY_EXCEEDED');
        // Join and first snapshot share the same queue as committed writes.
        await authorize(client);
        const value = await dependency(() => client.store.get(client.identity.tenantId, client.roomId));
        if (client.live && value === null) throw new TransportError('NOT_FOUND');
        const frame = roomFrame(room, value, !client.live);
        await authorize(client);
        room.clients.add(client); client.room = room;
        client.authenticated = true;
        clearTimeout(client.authenticationTimer);
        send(client, JSON.stringify({ type: 'ready', protocol: client.live ? 'opendoc-yjs-2' : 'opendoc-yjs-1', role: client.identity.role }));
        sendState(client, frame, true);
      });
      return;
    }
    if (!binary) {
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new TransportError('BAD_REQUEST'); }
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || value.type !== 'sync') throw new TransportError('BAD_REQUEST');
      await inRoom(client, room => snapshot(client, room));
      return;
    }
    const offset = client.live ? 5 : 1;
    const maxUpdate = client.live ? LIVE_DOCUMENT_LIMITS.maxUpdateBytes : MAX_COLLABORATION_UPDATE_BYTES;
    if (bytes.byteLength < offset + 2 || bytes[0] !== (client.live ? 3 : 1)) throw new TransportError('BAD_REQUEST');
    if (bytes.byteLength > maxUpdate + offset) throw new TransportError('TOO_LARGE');
    let sequence;
    if (client.live) {
      sequence = bytes.readUInt32BE(1);
      if (sequence === 0 || sequence !== client.sequence + 1) throw new TransportError('BAD_REQUEST');
      client.sequence = sequence;
    }
    await inRoom(client, async room => {
      const identity = await authorize(client, true);
      const actor = client.live ? Object.freeze({ principalId: identity.principalId, tenantId: identity.tenantId }) : undefined;
      const resync = () => {
        // A late/ambiguous commit must not leave connected readers silently stale.
        requireResync(room);
      };
      let frame, result;
      try {
        result = await dependency(() => client.live
          ? client.store.applyUpdate(identity.tenantId, client.roomId, new Uint8Array(bytes.subarray(offset)), actor)
          : client.store.applyUpdate(identity.tenantId, client.roomId, new Uint8Array(bytes.subarray(offset))), {
          fence: true, onTimeout: resync
        });
        // An invalid result may follow a successful commit too.
        frame = roomFrame(room, result, false);
      } catch (error) {
        // These narrow store outcomes guarantee rejection/rollback. All other
        // failures (including a lost COMMIT response) have an uncertain outcome.
        if (!['BAD_REQUEST', 'TOO_LARGE', 'CAPACITY_EXCEEDED', 'NOT_FOUND'].includes(error?.code) &&
            !(client.live && error?.code === 'FORBIDDEN')) resync();
        throw error;
      }
      // Never send an uncommitted update. Every receiver is independently
      // revalidated, including idle viewers and the original editor.
      await fanout(room, frame);
      if (client.live) {
        await authorize(client);
        send(client, JSON.stringify({ type: 'ack', sequence, revision: result.revision }));
      }
    });
  }
  function accept(ws, request, roomId, origin, live) {
    const client = { authContext: Object.freeze({ connectionId: randomBytes(32).toString('base64url') }), ws, roomId, origin, live, store: live ? liveStore : store, path: request.url, sequence: 0, revision: 0, token: null, identity: null, authenticated: false, closed: false, pending: 0, tail: Promise.resolve(), room: null };
    clients.add(client);
    client.authenticationTimer = setTimeout(() => stop(client, 1008, 'Authentication required.'), config.authenticationTimeoutMs);
    client.authenticationTimer.unref();
    client.revalidationTimer = setInterval(() => {
      if (client.authenticated && client.pending === 0) enqueue(client, () => authorize(client));
    }, config.revalidationIntervalMs);
    client.revalidationTimer.unref();
    ws.on('message', (bytes, binary) => {
      // Prevent retaining very large unauthenticated/control frames in queues.
      if ((!client.authenticated && bytes.byteLength > config.maxTokenBytes + 64) || (!binary && bytes.byteLength > config.maxTokenBytes + 64)) {
        stop(client, 1009, 'Message too large.'); return;
      }
      enqueue(client, () => processMessage(client, bytes, binary));
    });
    ws.on('error', () => stop(client, 1008, 'Invalid connection.'));
    ws.on('close', () => {
      client.closed = true; client.token = null;
      clearTimeout(client.authenticationTimer); clearInterval(client.revalidationTimer); clearTimeout(client.closeTimer);
      clients.delete(client);
      if (client.room) { client.room.clients.delete(client); retireRoom(client.room); }
    });
  }
  function reject(socket, status) {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`);
    const timer = setTimeout(() => socket.destroy(), config.closeTimeoutMs); timer.unref();
    socket.once('close', () => clearTimeout(timer));
  }
  function upgrade(request, socket, head) {
    const liveMatch = liveStore ? LIVE_ROUTE.exec(request.url ?? '') : null;
    const match = liveMatch ?? (store ? ROUTE.exec(request.url ?? '') : null);
    // Raw target match rejects query tokens, fragments, percent aliases,
    // dot segments, proxy absolute targets and malformed room identifiers.
    if (request.method !== 'GET' || !match) { reject(socket, '400 Bad Request'); return; }
    const origin = request.headers.origin;
    const originCount = request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'origin').length;
    if (originCount > 1 || (origin === undefined ? !allowMissingOrigin : !origins.has(origin))) { reject(socket, '403 Forbidden'); return; }
    if (request.headers.authorization || request.headers['sec-websocket-protocol']) { reject(socket, '400 Bad Request'); return; }
    if (stopped || clients.size >= config.maxConnections) { reject(socket, '503 Service Unavailable'); return; }
    wss.handleUpgrade(request, socket, head, ws => accept(ws, request, match[1], origin, Boolean(liveMatch)));
  }
  server.on('upgrade', upgrade);
  scheduleSync();
  return {
    stats: () => Object.freeze({ connections: clients.size, rooms: rooms.size, pendingOperations: pending, dependencyOperations: dependencies }),
    async close() {
      if (stopped) return;
      stopped = true;
      clearTimeout(syncTimer);
      server.off('upgrade', upgrade);
      for (const client of clients) { stop(client, 1001, 'Server stopping.'); client.ws.terminate(); }
      await new Promise(resolve => wss.close(resolve));
    }
  };
}

/** Local-only convenience helper. No public bind option, no implicit auth. */
export async function startLocalCollaborationServer({ port = 0, host = '127.0.0.1', ...options } = {}) {
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Only a valid IPv4 loopback address/port is allowed');
  const server = createServer({ maxHeaderSize: 16384, headersTimeout: 10000, requestTimeout: 30000 }, (_request, response) => {
    response.writeHead(404, { 'cache-control': 'no-store' }); response.end();
  });
  const transport = attachCollaborationServer({ ...options, server });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { await transport.close(); throw error; }
  let closing;
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    stats: transport.stats,
    close() {
      closing ??= (async () => {
        await transport.close();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      })();
      return closing;
    }
  };
}
