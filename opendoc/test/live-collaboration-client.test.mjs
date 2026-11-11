import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { connectLiveCollaboration, encodeLiveUpdateFrame } from '../src/live-collaboration-client.mjs';
function frame(doc, revision = 1) {
  const state = Y.encodeStateAsUpdate(doc), data = new Uint8Array(9 + state.length);
  data[0] = 2; new DataView(data.buffer).setBigUint64(1, BigInt(revision)); data.set(state, 9); return data;
}
class Socket extends EventTarget {
  static instances = [];
  constructor() { super(); this.readyState = 0; this.bufferedAmount = 0; this.sent = []; Socket.instances.push(this); }
  send(data) { this.sent.push(data); }
  emit(type, data) { this.dispatchEvent(type === 'message' ? new MessageEvent(type, { data }) : new Event(type)); }
  open() { this.readyState = 1; this.emit('open'); }
  close() { this.readyState = 3; }
  receive(data) { this.emit('message', data); }
}
function writer(doc, options = {}) {
  const promise = connectLiveCollaboration({ url: 'wss://documents.example.test/api/v1/live-documents/one/collaboration', token: 'synthetic', doc, WebSocketImpl: Socket, ...options });
  const ws = Socket.instances.at(-1); ws.open(); return { promise, ws };
}
function ready(ws, doc, role = 'editor') { ws.receive(JSON.stringify({ type: 'ready', protocol: 'opendoc-yjs-2', role })); ws.receive(frame(doc)); }
function writes(ws) { return ws.sent.filter(value => value instanceof Uint8Array); }
function persist(ws, server, index, revision) {
  const update = writes(ws)[index], sequence = new DataView(update.buffer).getUint32(1);
  Y.applyUpdate(server, update.subarray(5)); ws.receive(frame(server, revision));
  ws.receive(JSON.stringify({ type: 'ack', sequence, revision }));
}
test('state echo cannot acknowledge delete-only work; only matching durable ACK clears pending', async () => {
  const server = new Y.Doc(), doc = new Y.Doc(); server.getText('content').insert(0, 'abc');
  const { promise, ws } = writer(doc); ready(ws, server); const connection = await promise;
  const vector = Y.encodeStateVector(doc); doc.getText('content').delete(1, 1);
  assert.deepEqual(Y.encodeStateVector(doc), vector); assert.equal(connection.pending, true);
  const update = writes(ws)[0]; Y.applyUpdate(server, update.subarray(5)); ws.receive(frame(server, 2));
  assert.equal(connection.pending, true); ws.receive(JSON.stringify({ type: 'ack', sequence: 1, revision: 2 }));
  assert.equal(connection.pending, false); connection.close(); doc.destroy(); server.destroy();
});
test('one in-flight write coalesces rapid typing and ACK only clears the submitted edit generation', async () => {
  const server = new Y.Doc(), doc = new Y.Doc(); const { promise, ws } = writer(doc); ready(ws, server); const connection = await promise;
  for (let n = 0; n < 150; n++) doc.getText('content').insert(doc.getText('content').length, 'x');
  assert.equal(writes(ws).length, 1); persist(ws, server, 0, 2);
  assert.equal(connection.pending, true); assert.equal(writes(ws).length, 2);
  persist(ws, server, 1, 3); assert.equal(connection.pending, false); assert.equal(server.getText('content').length, 150);
  connection.close(); doc.destroy(); server.destroy();
});
test('lost-ACK reconnect replays retained deletions; late old-socket ACK cannot clear new pending', async () => {
  const server = new Y.Doc(), doc = new Y.Doc(); server.getText('content').insert(0, 'abc');
  const first = writer(doc); ready(first.ws, server); const a = await first.promise;
  doc.getText('content').delete(0, 1); Y.applyUpdate(server, writes(first.ws)[0].subarray(5)); a.close();
  const second = writer(doc, { replay: true }); ready(second.ws, server); const b = await second.promise;
  assert.equal(writes(second.ws).length, 1); assert.equal(b.pending, true);
  first.ws.receive(JSON.stringify({ type: 'ack', sequence: 1, revision: 2 })); assert.equal(b.pending, true);
  persist(second.ws, server, 0, 2); assert.equal(b.pending, false); assert.equal(doc.getText('content').toString(), 'bc');
  b.close(); doc.destroy(); server.destroy();
});
test('viewer/commenter never replay retained edits and bad ACKs fail closed', async () => {
  for (const role of ['viewer', 'commenter']) {
    const doc = new Y.Doc(), server = new Y.Doc(); doc.getText('content').insert(0, 'private');
    const { promise, ws } = writer(doc, { replay: true }); ready(ws, server, role);
    await assert.rejects(promise); assert.equal(writes(ws).length, 0); assert.equal(doc.getText('content').toString(), 'private'); doc.destroy(); server.destroy();
  }
  const doc = new Y.Doc(), server = new Y.Doc(), errors = [];
  const { promise, ws } = writer(doc, { onError: error => errors.push(error) }); ready(ws, server); const connection = await promise;
  doc.getText('content').insert(0, 'keep'); ws.receive(JSON.stringify({ type: 'ack', sequence: 99, revision: 1 }));
  assert.equal(connection.pending, true); assert.equal(connection.connected, false); assert.equal(errors.length, 1); doc.destroy(); server.destroy();
});
test('pre-abort creates no socket; bounds and ack deadline retain dirty state', async () => {
  const doc = new Y.Doc(); const abort = new AbortController(); abort.abort(); const before = Socket.instances.length;
  await assert.rejects(connectLiveCollaboration({ url: 'wss://documents.example.test/api/v1/live-documents/one/collaboration', token: 'synthetic', doc, signal: abort.signal, WebSocketImpl: Socket }));
  assert.equal(Socket.instances.length, before);
  assert.equal(encodeLiveUpdateFrame(new Uint8Array(1024 * 1024), 1).length, 1024 * 1024 + 5);
  assert.throws(() => encodeLiveUpdateFrame(new Uint8Array(1024 * 1024 + 1), 1));
  const errors = [], server = new Y.Doc(), { promise, ws } = writer(doc, { timeoutMs: 20, onError: error => errors.push(error) });
  ready(ws, server); const connection = await promise; doc.getText('content').insert(0, 'retained');
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(connection.connected, false); assert.equal(connection.pending, true); assert.equal(errors.length, 1);
  doc.destroy(); server.destroy();
});
