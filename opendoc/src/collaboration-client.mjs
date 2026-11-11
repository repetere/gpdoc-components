// Original browser/Node helper for the experimental OpenDoc Yjs v1 protocol.
// MIT. Reconnect explicitly with the same Y.Doc to replay retained local edits.
import * as Y from 'yjs';

const MAX_UPDATE = 64 * 1024;
const MAX_STATE = 1024 * 1024;
const READ_ROLES = new Set(['owner', 'editor', 'viewer', 'commenter']);
const WRITE_ROLES = new Set(['owner', 'editor']);

export function encodeUpdateFrame(update) {
  if (!(update instanceof Uint8Array) || update.byteLength < 2 || update.byteLength > MAX_UPDATE) throw new TypeError('Invalid or oversized Yjs update');
  const frame = new Uint8Array(1 + update.byteLength);
  frame[0] = 1; frame.set(update, 1); return frame;
}
export function decodeStateFrame(data) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 11 || bytes.byteLength > MAX_STATE + 9 || bytes[0] !== 2) throw new TypeError('Invalid state frame');
  const revision = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(1, false);
  if (revision > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('Invalid state revision');
  return { revision: Number(revision), state: bytes.subarray(9) };
}

/**
 * Resolve after authenticated initial sync. This small helper does not retry,
 * refresh tokens, retain a disk queue, support awareness, or change editor UI.
 * Call again with a fresh token and the SAME doc for reconnect/offline replay.
 * Node tests can pass a WebSocket subclass adding the allowlisted Origin header.
 */
export function connectCollaboration({ url, token, doc, WebSocketImpl = globalThis.WebSocket, onState = () => {}, onError = () => {}, timeoutMs = 10000 } = {}) {
  const target = new URL(url);
  const loopback = target.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (!(target.protocol === 'wss:' || loopback) || target.username || target.password || target.search || target.hash ||
    !/^\/api\/v1\/collaboration\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(target.pathname)) throw new TypeError('Use a secure exact collaboration URL (or loopback)');
  if (typeof token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(token) || !(doc instanceof Y.Doc) || typeof WebSocketImpl !== 'function' ||
    typeof onState !== 'function' || typeof onError !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('Invalid collaboration client options');
  return new Promise((resolve, reject) => {
    let credential = token;
    token = null;
    const ws = new WebSocketImpl(url);
    ws.binaryType = 'arraybuffer';
    const remoteOrigin = Object.freeze({ transport: 'opendoc-yjs-1' });
    let ready = false;
    let settled = false;
    let closed = false;
    let role = null;
    let revision = 0;
    const timer = setTimeout(() => fail(new Error('Collaboration handshake timed out.')), timeoutMs);
    timer.unref?.();
    const session = {
      get role() { return role; }, get revision() { return revision; },
      get connected() { return !closed && ws.readyState === 1; },
      close() { cleanup(); ws.close(1000, 'Client closing.'); },
      sync() { if (!ready || closed) throw new Error('Not connected.'); ws.send('{"type":"sync"}'); }
    };
    function cleanup() { closed = true; credential = null; clearTimeout(timer); doc.off('update', localUpdate); }
    function fail(error) {
      if (closed) return;
      cleanup(); ws.close(1000, 'Client stopped.');
      if (!settled) { settled = true; reject(error); }
      else { try { onError(error); } catch { /* Application callback errors are not transport errors. */ } }
    }
    function sendUpdate(update) {
      if (ws.bufferedAmount > 2 * MAX_STATE) throw new Error('Collaboration send buffer exceeded.');
      ws.send(encodeUpdateFrame(update));
    }
    function localUpdate(update, origin) {
      if (!ready || closed || origin === remoteOrigin || !WRITE_ROLES.has(role)) return;
      try { sendUpdate(update); } catch { fail(new Error('Local update exceeds transport limits.')); }
    }
    doc.on('update', localUpdate);
    ws.addEventListener('open', () => {
      if (closed) return;
      ws.send(JSON.stringify({ type: 'authenticate', token: credential }));
      credential = null;
    });
    ws.addEventListener('message', event => {
      if (closed) return;
      try {
        if (typeof event.data === 'string') {
          const message = JSON.parse(event.data);
          if (role !== null || !message || Object.keys(message).length !== 3 || message.type !== 'ready' || message.protocol !== 'opendoc-yjs-1' || !READ_ROLES.has(message.role)) throw new Error('Invalid server handshake.');
          role = message.role; return;
        }
        if (role === null) throw new Error('Missing server handshake.');
        const snapshot = decodeStateFrame(event.data);
        if (snapshot.revision < revision) throw new Error('Server revision moved backwards.');
        let serverVector;
        if (!ready && WRITE_ROLES.has(role)) {
          const serverDoc = new Y.Doc();
          try { Y.applyUpdate(serverDoc, snapshot.state); serverVector = Y.encodeStateVector(serverDoc); } finally { serverDoc.destroy(); }
        }
        Y.applyUpdate(doc, snapshot.state, remoteOrigin);
        revision = snapshot.revision;
        if (!ready) {
          ready = true;
          if (serverVector) {
            const replay = Y.encodeStateAsUpdate(doc, serverVector);
            if (replay.byteLength !== 2 || replay[0] !== 0 || replay[1] !== 0) sendUpdate(replay);
          }
          clearTimeout(timer); settled = true; resolve(session);
        }
        try { onState({ revision }); } catch { /* Keep application hooks isolated. */ }
      } catch { fail(new Error('Invalid collaboration state or replay exceeds limits.')); }
    });
    ws.addEventListener('error', () => fail(new Error('Collaboration connection failed.')));
    ws.addEventListener('close', () => {
      if (closed) return;
      cleanup();
      if (!settled) { settled = true; reject(new Error('Collaboration connection closed before sync.')); }
      else { try { onError(new Error('Collaboration connection closed.')); } catch { /* Application hook. */ } }
    });
  });
}
