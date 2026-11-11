// Original OpenDoc live document protocol client. MIT. Memory only; no retry loop.
import * as Y from 'yjs';
import { decodeStateFrame } from './collaboration-client.mjs';
const MAX_STATE = 1024 * 1024;
const WRITERS = new Set(['owner', 'editor']);
const READERS = new Set([...WRITERS, 'viewer', 'commenter']);
export function encodeLiveUpdateFrame(update, sequence) {
  if (!(update instanceof Uint8Array) || update.byteLength < 2 || update.byteLength > MAX_STATE ||
    !Number.isInteger(sequence) || sequence < 1 || sequence > 0xffffffff) throw new TypeError('Invalid live update');
  const frame = new Uint8Array(update.byteLength + 5); frame[0] = 3;
  new DataView(frame.buffer).setUint32(1, sequence, false); frame.set(update, 5); return frame;
}
/** One outstanding write; subsequent edits coalesce in the bounded Y.Doc.
 * A state frame is NEVER a save acknowledgement, including delete-only edits.
 * replay=true resubmits retained state after an interrupted/uncertain write.
 */
export function connectLiveCollaboration({ url, token, doc, replay = false, WebSocketImpl = globalThis.WebSocket,
  onState = () => {}, onError = () => {}, timeoutMs = 10000, signal } = {}) {
  const target = new URL(url);
  if (!(target.protocol === 'wss:' || target.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) ||
    target.username || target.password || target.search || target.hash ||
    !/^\/api\/v1\/live-documents\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/collaboration$/.test(target.pathname) ||
    typeof token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(token) || !(doc instanceof Y.Doc) ||
    typeof WebSocketImpl !== 'function' || typeof onState !== 'function' || typeof onError !== 'function' ||
    signal !== undefined && !(signal instanceof AbortSignal) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('Invalid live connection');
  if (signal?.aborted) return Promise.reject(new Error('Live connection cancelled.'));
  return new Promise((resolve, reject) => {
    let credential = token; token = null;
    const ws = new WebSocketImpl(url); ws.binaryType = 'arraybuffer';
    const remote = Object.freeze({ transport: 'opendoc-yjs-2' });
    let closed = false, ready = false, settled = false, role = null, revision = 0;
    let changed = replay ? 1 : 0, acknowledged = 0, sequence = 0, inFlight = null;
    let timer = setTimeout(() => fail(new Error('Live connection timed out.')), timeoutMs); timer.unref?.();
    const state = () => ({ connected: ready && !closed, pending: changed !== acknowledged || Boolean(inFlight), role, revision });
    const emit = () => { try { onState(state()); } catch { /* UI failures do not change persistence. */ } };
    const session = { get connected() { return state().connected; }, get pending() { return state().pending; },
      get role() { return role; }, get revision() { return revision; },
      close() { stop(); ws.close(1000, 'Client closing.'); if (!settled) { settled = true; reject(new Error('Live connection cancelled.')); } },
      sync() { if (!ready || closed) throw new Error('Not connected.'); ws.send('{"type":"sync"}'); } };
    function stop() { closed = true; credential = null; clearTimeout(timer); doc.off('update', local); signal?.removeEventListener('abort', abort); }
    function fail(error) {
      if (closed) return; stop(); ws.close(1000, 'Client stopped.');
      if (!settled) { settled = true; reject(error); }
      else { try { onError(error); } catch { /* UI hook. */ } }
    }
    function abort() { session.close(); }
    function send() {
      if (!ready || closed || inFlight || changed === acknowledged) return;
      if (!WRITERS.has(role)) { fail(new Error('Write access changed. Retained text was not submitted.')); return; }
      if (ws.bufferedAmount > 2 * MAX_STATE || sequence === 0xffffffff) throw new Error('Live connection limit reached.');
      const update = Y.encodeStateAsUpdate(doc);
      inFlight = { sequence: ++sequence, changed };
      ws.send(encodeLiveUpdateFrame(update, sequence));
      clearTimeout(timer); timer = setTimeout(() => fail(new Error('Persistence acknowledgement timed out.')), timeoutMs); timer.unref?.();
    }
    function local(_update, origin) {
      if (closed || origin === remote) return;
      changed++; emit();
      try { send(); } catch { fail(new Error('Live update could not be sent. Your text is retained.')); }
    }
    doc.on('update', local); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    ws.addEventListener('open', () => { if (!closed) { try { ws.send(JSON.stringify({ type: 'authenticate', token: credential })); credential = null; } catch { fail(new Error('Live authentication could not be sent.')); } } });
    ws.addEventListener('message', event => {
      if (closed) return;
      try {
        if (typeof event.data === 'string') {
          const message = JSON.parse(event.data);
          if (role === null) {
            if (!message || Object.keys(message).length !== 3 || message.type !== 'ready' || message.protocol !== 'opendoc-yjs-2' || !READERS.has(message.role)) throw new Error('Invalid handshake.');
            role = message.role;
            if (replay && !WRITERS.has(role)) throw new Error('Write access changed.');
            return;
          }
          if (!ready || !message || Object.keys(message).length !== 3 || message.type !== 'ack' || !inFlight ||
            message.sequence !== inFlight.sequence || !Number.isSafeInteger(message.revision) || message.revision < 1 || message.revision > revision) throw new Error('Invalid acknowledgement.');
          acknowledged = inFlight.changed; inFlight = null; clearTimeout(timer); send(); emit(); return;
        }
        if (role === null) throw new Error('Missing handshake.');
        const snapshot = decodeStateFrame(event.data);
        if (snapshot.revision < revision || snapshot.revision < 1) throw new Error('Invalid revision.');
        Y.applyUpdate(doc, snapshot.state, remote); revision = snapshot.revision;
        if (Y.encodeStateAsUpdate(doc).byteLength > MAX_STATE) throw new Error('Retained document exceeds the live state limit.');
        if (!ready) { ready = true; clearTimeout(timer); send(); settled = true; resolve(session); }
        emit();
      } catch { fail(new Error('Live sync was not confirmed. Retained text is unchanged by any REST snapshot.')); }
    });
    ws.addEventListener('error', () => fail(new Error('Live connection failed.')));
    ws.addEventListener('close', () => fail(new Error('Live connection closed. Check your session and reconnect.')));
  });
}
