// Original OpenDoc implementation. MIT, see ../../LICENSE.
// Internal worker entry. Never parse Yjs update bytes in the transport thread.
import { parentPort, workerData } from 'node:worker_threads';
import * as Y from 'yjs';
import { COLLABORATION_LIMITS as limits } from './collaboration-state.mjs';

function fail(code) { throw new Error(code); }
function natural(value, maximum, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail('BAD_REQUEST');
  if (value > maximum) fail('TOO_LARGE');
}
function identifier(id) {
  if (!id) return;
  natural(id.client, 0xffffffff);
  natural(id.clock, limits.maxClock);
}
function valuesWithinLimits(values) {
  const pending = values.map(value => [value, 0]);
  let nodes = 0;
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (++nodes > limits.maxValueNodes || depth > limits.maxValueDepth) fail('TOO_LARGE');
    if (value === null || typeof value !== 'object' || value instanceof Uint8Array) continue;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) fail('BAD_REQUEST');
    const entries = Object.entries(value);
    if (entries.length > limits.maxValueNodes - nodes || pending.length + entries.length > limits.maxValueNodes) fail('TOO_LARGE');
    for (const [key, item] of entries) {
      if (key === '__proto__') fail('BAD_REQUEST');
      pending.push([item, depth + 1]);
    }
  }
}

function checkDecoded(decoded) {
  if (decoded.structs.length > limits.maxStructs || decoded.ds.clients.size > limits.maxClients) fail('TOO_LARGE');
  const clients = new Set();
  let length = 0;
  let typeCount = 0;
  let ranges = 0;
  const values = [];
  for (const struct of decoded.structs) {
    identifier(struct.id);
    natural(struct.length, limits.maxClock, 1);
    natural(struct.id.clock + struct.length, limits.maxClock);
    length += struct.length;
    if (length > limits.maxTotalClockLength) fail('TOO_LARGE');
    clients.add(struct.id.client);
    identifier(struct.origin);
    identifier(struct.rightOrigin);
    if (struct.parent && typeof struct.parent !== 'string') identifier(struct.parent);
    if (struct.content) {
      const ref = struct.content.getRef();
      // This room protocol does not create or load subdocuments.
      if (ref === 9) fail('BAD_REQUEST');
      if (ref === 7 && ++typeCount > limits.maxNestedTypes) fail('TOO_LARGE');
      if (ref === 2 || ref === 8) {
        if (struct.content.arr.length > limits.maxValueNodes - values.length) fail('TOO_LARGE');
        values.push(...struct.content.arr);
      }
      if (ref === 5) values.push(struct.content.embed);
      if (ref === 6) values.push(struct.content.value);
      if (values.length > limits.maxValueNodes) fail('TOO_LARGE');
    }
  }
  for (const [client, deletes] of decoded.ds.clients) {
    natural(client, 0xffffffff);
    clients.add(client);
    ranges += deletes.length;
    if (ranges > limits.maxDeleteRanges) fail('TOO_LARGE');
    for (const deletion of deletes) {
      natural(deletion.clock, limits.maxClock);
      natural(deletion.len, limits.maxClock, 1);
      natural(deletion.clock + deletion.len, limits.maxClock);
    }
  }
  if (clients.size > limits.maxClients) fail('TOO_LARGE');
  valuesWithinLimits(values);
}

function decodeStrict(bytes) {
  let decoder;
  const groups = new Set();
  let structs = 0;
  class BoundedDecoder extends Y.UpdateDecoderV1 {
    constructor(rest) { super(rest); decoder = rest; }
    readClient() {
      const client = super.readClient();
      natural(client, 0xffffffff);
      if (groups.has(client)) fail('BAD_REQUEST');
      groups.add(client);
      if (groups.size > limits.maxClients) fail('TOO_LARGE');
      return client;
    }
    readInfo() {
      if (++structs > limits.maxStructs) fail('TOO_LARGE');
      const info = super.readInfo();
      if (!Number.isInteger(info) || (info !== 10 && ((info & 31) > 9 || (info & 31) === 9))) fail('BAD_REQUEST');
      return info;
    }
    readLen() {
      const n = super.readLen();
      natural(n, limits.maxClock, 1);
      return n;
    }
    readDsClock() {
      const n = super.readDsClock();
      natural(n, limits.maxClock);
      return n;
    }
    readDsLen() {
      const n = super.readDsLen();
      natural(n, limits.maxClock, 1);
      return n;
    }
  }
  const result = Y.decodeUpdateV2(bytes, BoundedDecoder);
  if (decoder.pos !== bytes.byteLength) fail('BAD_REQUEST');
  checkDecoded(result);
  return result;
}

function checkDocument(doc) {
  if (doc.share.size > limits.maxSharedTypes || doc.store.clients.size > limits.maxClients || doc.subdocs.size) fail('TOO_LARGE');
  let structs = 0;
  let types = 0;
  let length = 0;
  for (const items of doc.store.clients.values()) {
    structs += items.length;
    if (structs > limits.maxStructs) fail('TOO_LARGE');
    for (const item of items) {
      length += item.length;
      if (length > limits.maxTotalClockLength) fail('TOO_LARGE');
      if (item.content?.getRef() !== 7) continue;
      if (++types > limits.maxNestedTypes) fail('TOO_LARGE');
      let parent = item.content.type;
      let depth = 0;
      while (parent?._item) {
        if (++depth > limits.maxTypeDepth) fail('TOO_LARGE');
        parent = parent._item.parent;
      }
    }
  }
  // Yjs retains causally incomplete structs/deletes. Bound both and preserve them
  // in the durable snapshot so out-of-order/reconnecting clients do not lose edits.
  const pendingStructs = doc.store.pendingStructs?.update;
  const pendingDeletes = doc.store.pendingDs;
  if ((pendingStructs?.byteLength ?? 0) + (pendingDeletes?.byteLength ?? 0) > limits.maxPendingBytes) fail('TOO_LARGE');
  if (doc.store.pendingStructs?.missing.size > limits.maxClients) fail('TOO_LARGE');
  if (pendingStructs) checkDecoded(Y.decodeUpdateV2(pendingStructs));
  if (pendingDeletes) checkDecoded(Y.decodeUpdateV2(pendingDeletes));
}

let doc;
try {
  doc = new Y.Doc({ gc: true });
  const { previous, update } = workerData;
  if (previous) {
    try {
      decodeStrict(previous);
      Y.applyUpdate(doc, previous);
      checkDocument(doc);
    } catch { fail('DEPENDENCY_UNAVAILABLE'); }
  }
  decodeStrict(update);
  Y.applyUpdate(doc, update);
  checkDocument(doc);
  const state = Y.encodeStateAsUpdate(doc);
  if (state.byteLength > limits.maxStateBytes) fail('TOO_LARGE');
  decodeStrict(state);
  if (!previous && state.byteLength === 2 && state[0] === 0 && state[1] === 0) fail('BAD_REQUEST');
  const changed = !previous || previous.byteLength !== state.byteLength || state.some((byte, index) => byte !== previous[index]);
  parentPort.postMessage({ state, changed }, [state.buffer]);
} catch (error) {
  const code = ['BAD_REQUEST', 'TOO_LARGE', 'DEPENDENCY_UNAVAILABLE'].includes(error?.message) ? error.message : 'BAD_REQUEST';
  parentPort.postMessage({ error: code });
} finally {
  doc?.destroy();
}
