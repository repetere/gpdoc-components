// @spec OD-COLLAB-004 OD-COLLAB-008
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { connectCollaboration, encodeUpdateFrame, decodeStateFrame } from '../src/collaboration-client.mjs';
import { startLocalCollaborationServer } from '../src/collaboration-server.mjs';

const ORIGIN = 'https://editor.example.test';
class BrowserSocket extends WebSocket { constructor(url) { super(url, { origin: ORIGIN }); } }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { const deadline = Date.now() + 3000; while (!predicate()) { if (Date.now() >= deadline) throw new Error('Timed out waiting for sync'); await delay(5); } }
async function fixture(t) {
  let value = null;
  const store = {
    async get() { return value; },
    async applyUpdate(_tenant, _room, update) {
      const doc = new Y.Doc();
      try {
        if (value) Y.applyUpdate(doc, value.state);
        Y.applyUpdate(doc, update);
        const state = Y.encodeStateAsUpdate(doc);
        if (!value || !Buffer.from(value.state).equals(Buffer.from(state))) value = { state, revision: (value?.revision ?? 0) + 1 };
        return value;
      } finally { doc.destroy(); }
    }
  };
  const server = await startLocalCollaborationServer({ store, allowedOrigins: [ORIGIN], authenticate: request => {
    const token = request.headers.get('authorization');
    return ['Bearer edit', 'Bearer view'].includes(token) ? { principalId: 'test-user', tenantId: 'one', role: token === 'Bearer edit' ? 'editor' : 'viewer' } : null;
  } });
  t.after(() => server.close());
  const connect = (doc, token = 'edit', rest = {}) => connectCollaboration({ url: `${server.url}/api/v1/collaboration/room`, token, doc, WebSocketImpl: BrowserSocket, ...rest });
  return { server, connect, store };
}

test('client helper synchronizes two docs and reconnects with concurrent offline edits', async t => {
  const f = await fixture(t); const a = new Y.Doc(); const b = new Y.Doc();
  t.after(() => { a.destroy(); b.destroy(); });
  const one = await f.connect(a); const two = await f.connect(b);
  t.after(() => { one.close(); two.close(); });
  a.getText('body').insert(0, 'start');
  await until(() => b.getText('body').toString() === 'start');
  assert.ok(one.revision >= 1); assert.ok(two.revision >= 1);
  one.close();
  a.getText('body').insert(5, '-offline');
  b.getText('body').insert(5, '-online');
  await until(() => two.revision >= 2);
  const reconnect = await f.connect(a); t.after(() => reconnect.close());
  await until(() => a.getText('body').toString() === b.getText('body').toString() && b.getText('body').toString().includes('-offline'));
  assert.ok(a.getText('body').toString().includes('-online'));
  assert.ok(reconnect.revision >= 3);
});

test('initial local edits replay, reader never sends local changes and receives remote updates', async t => {
  const f = await fixture(t); const a = new Y.Doc(); const b = new Y.Doc();
  a.getText('body').insert(0, 'initial');
  const one = await f.connect(a); t.after(() => one.close()); await until(() => one.revision >= 1);
  const two = await f.connect(b, 'view'); t.after(() => two.close()); assert.equal(two.role, 'viewer');
  b.getText('body').insert(0, 'local-view-only'); await delay(20); assert.equal((await f.store.get()).revision, 1);
  a.getText('body').insert(7, '-remote'); await until(() => b.getText('body').toString().includes('-remote'));
  assert.ok(!a.getText('body').toString().includes('local-view-only'));
  a.destroy(); b.destroy();
});

test('failed auth rejects initial connection and close reports only sanitized callback errors', async t => {
  const f = await fixture(t); const doc = new Y.Doc();
  await assert.rejects(f.connect(doc, 'secret-invalid'), /closed before sync/);
  const errors = [];
  const session = await f.connect(doc, 'edit', { onError: error => errors.push(error.message) });
  await f.server.close(); await until(() => errors.length === 1);
  assert.equal(errors[0], 'Collaboration connection closed.'); assert.equal(session.connected, false);
  doc.destroy();
});

test('client rejects oversized offline replay instead of silently truncating retained edits', async t => {
  const f = await fixture(t); const doc = new Y.Doc(); doc.getText('body').insert(0, 'x'.repeat(65536));
  await assert.rejects(f.connect(doc), /replay exceeds limits/);
  assert.equal(doc.getText('body').length, 65536); assert.equal(await f.store.get(), null); doc.destroy();
});

test('frame helpers enforce exact type, bounds and safe revision', () => {
  assert.deepEqual([...encodeUpdateFrame(new Uint8Array([0, 0]))], [1, 0, 0]);
  assert.throws(() => encodeUpdateFrame(new Uint8Array(65537)), /oversized/);
  assert.throws(() => decodeStateFrame(new Uint8Array([2])), /Invalid/);
  const frame = new Uint8Array(11); frame[0] = 2; new DataView(frame.buffer).setBigUint64(1, 9007199254740992n);
  assert.throws(() => decodeStateFrame(frame), /revision/);
  frame[0] = 1; assert.throws(() => decodeStateFrame(frame), /Invalid/);
  for (const url of ['ws://public.example/api/v1/collaboration/room', 'wss://user:secret@example.test/api/v1/collaboration/room', 'wss://example.test/api/v1/collaboration/room?token=secret', 'wss://example.test/api/v1/collaboration/room#secret']) {
    assert.throws(() => connectCollaboration({ url }), /secure exact/);
  }
});
