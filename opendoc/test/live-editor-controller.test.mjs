import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { createEditorController } from '../web/controller.mjs';
import { createLiveDocument } from '../web/live-document.mjs';
const identity = { principalId: 'alice', tenantId: 'team', role: 'editor', csrfToken: 'synthetic', expiresAt: Date.now() + 60000 };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function setup(respond = () => {}) {
  const calls = [], opened = [], docs = new Map();
  for (const id of ['one', 'two']) { const doc = new Y.Doc(); doc.getText('title').insert(0, id); doc.getText('content').insert(0, `Authoritative ${id}`); docs.set(id, doc); }
  const controller = createEditorController({ origin: 'https://documents.test', confirmDiscard: async () => true, newId: () => 'new',
    liveFactory: options => createLiveDocument({ ...options, connect: async opts => {
      const id = new URL(opts.url).pathname.split('/')[4]; opened.push(id); Y.applyUpdate(opts.doc, Y.encodeStateAsUpdate(docs.get(id)));
      opts.onState({ connected: true, pending: opts.replay, role: 'editor', revision: 1 });
      return { role: 'editor', revision: 1, pending: opts.replay, close() {} };
    } }),
    fetch: async (path, init) => {
      calls.push({ path, ...init }); const custom = await respond(path, init); if (custom !== undefined) return custom;
      if (path === '/auth/session') return json(identity);
      if (path === '/api/v1/documents') return json({ documents: [] });
      if (path === '/api/v1/live-documents') return json({ documents: [] });
      if (path.startsWith('/api/v1/live-documents/')) return json({ id: path.split('/').at(-1), title: 'Stale title', content: 'Stale projection', revision: 1, authority: 'yjs' });
      if (path === '/auth/collaboration-ticket') { const { documentId } = JSON.parse(init.body); return json({ ticket: 'synthetic', path: `/api/v1/live-documents/${documentId}/collaboration` }); }
      throw new Error('Unexpected request');
    } });
  return { controller, calls, opened, close() { controller.destroy(); for (const doc of docs.values()) doc.destroy(); } };
}
async function until(predicate) { for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); } assert.fail('Expected async stage'); }
test('live open never initializes Yjs from the REST projection', async () => {
  const f = setup(); await f.controller.checkSession(); await f.controller.openLiveDocument('one');
  assert.equal(f.controller.getState().active.content, 'Authoritative one'); assert.equal(f.controller.getState().active.title, 'one'); f.close();
});
test('late reconnect ticket success or failure cannot replay discarded work or disconnect a newer document', async () => {
  for (const status of [200, 403]) {
    const ticket = deferred(); let tickets = 0, held = false;
    const f = setup(path => { if (path === '/auth/collaboration-ticket' && ++tickets === 2) { held = true; return ticket.promise; } });
    await f.controller.checkSession(); await f.controller.openLiveDocument('one'); await f.controller.checkSession(); f.controller.edit({ content: 'Discarded offline draft' });
    const reconnecting = f.controller.reconnectLive(); await until(() => held);
    assert.equal(await f.controller.openLiveDocument('two'), true);
    ticket.resolve(json({ ticket: 'synthetic', path: '/api/v1/live-documents/one/collaboration' }, status));
    assert.equal(await reconnecting, false); assert.deepEqual(f.opened, ['one', 'two']);
    const state = f.controller.getState(); assert.equal(state.active.id, 'two'); assert.equal(state.live.status, 'connected'); assert.equal(state.writable, true); assert.equal(state.error, ''); f.close();
  }
});
test('account/tenant changes retain pending text and issue no replacement ticket', async () => {
  for (const changed of [{ ...identity, principalId: 'bob' }, { ...identity, tenantId: 'other' }]) {
    let session = identity; const f = setup(path => path === '/auth/session' ? json(session) : undefined);
    await f.controller.checkSession(); await f.controller.openLiveDocument('one'); await f.controller.checkSession(); f.controller.edit({ content: 'Alice private words' }); session = changed;
    assert.equal(await f.controller.reconnectLive(), false); assert.equal(f.controller.getState().active.content, 'Alice private words');
    assert.equal(f.controller.getState().phase, 'expired'); assert.equal(f.controller.getState().dirty, true); assert.equal(f.opened.length, 1); f.close();
  }
});
test('failed session check closes live transport and preserves offline text read-only', async () => {
  let failed = false; const f = setup(path => failed && path === '/auth/session' ? json({}, 503) : undefined);
  await f.controller.checkSession(); await f.controller.openLiveDocument('one'); await f.controller.checkSession(); f.controller.edit({ content: 'Retain me' }); failed = true;
  assert.equal(await f.controller.reconnectLive(), false); assert.equal(f.controller.getState().writable, false); assert.equal(f.controller.getState().active.content, 'Retain me'); assert.equal(f.controller.getState().dirty, true); f.close();
});
test('uncertain live creation freezes retry and keeps the exact draft for download', async () => {
  const f = setup((path, init) => { if (path === '/api/v1/live-documents' && init.method === 'POST') throw new Error('Lost response'); });
  await f.controller.checkSession(); await f.controller.newLiveDocument(); f.controller.edit({ title: 'Draft', content: 'Only copy' });
  assert.equal(await f.controller.save(), false); assert.equal(await f.controller.save(), false);
  assert.equal(f.controller.getState().active.content, 'Only copy'); assert.equal(f.controller.getState().dirty, true); assert.ok(f.controller.getState().conflict);
  assert.equal(f.calls.filter(call => call.path === '/api/v1/live-documents' && call.method === 'POST').length, 1); f.close();
});
test('live creation cannot silently lose newer typed text while its response is pending', async () => {
  const pending = deferred(); const f = setup((path, init) => path === '/api/v1/live-documents' && init.method === 'POST' ? pending.promise : undefined);
  await f.controller.checkSession(); await f.controller.newLiveDocument(); f.controller.edit({ title: 'Title', content: 'Submitted' });
  const creating = f.controller.save(); assert.equal(f.controller.edit({ content: 'Newer' }), false);
  pending.resolve(json({ id: 'new', title: 'Title', content: 'Submitted', revision: 1, authority: 'yjs' }));
  assert.equal(await creating, true); assert.equal(f.controller.getState().active.content, 'Submitted'); assert.equal(f.controller.getState().writable, false); f.close();
});
