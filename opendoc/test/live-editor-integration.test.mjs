// Real local OIDC, browser controller, Yjs client and durable ACK protocol.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startSyntheticEditorDemo } from './fixtures/editor-demo.mjs';
import { NetworkCookieJar, authorizeAtProvider } from './fixtures/oidc-provider.mjs';
import { createEditorController } from '../web/controller.mjs';
import { createLiveDocument } from '../web/live-document.mjs';
async function eventually(predicate, message = 'Expected state') {
  for (let n = 0; n < 200; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(message);
}
async function fixture(t) {
  const before = process.env.OPENDOC_SYNTHETIC_EDITOR; process.env.OPENDOC_SYNTHETIC_EDITOR = '1';
  const app = await startSyntheticEditorDemo();
  if (before === undefined) delete process.env.OPENDOC_SYNTHETIC_EDITOR; else process.env.OPENDOC_SYNTHETIC_EDITOR = before;
  t.after(() => app.close()); return app;
}
async function login(app, subject = 'synthetic-editor') {
  const jar = new NetworkCookieJar();
  const result = await jar.fetch(`${app.origin}/auth/login`, { method: 'POST', headers: { origin: app.origin, 'content-type': 'application/json', 'x-opendoc-login': '1' }, body: '{}' });
  const callback = await authorizeAtProvider({ provider: app.provider, jar, authorizationUrl: (await result.json()).authorizationUrl, subject });
  assert.equal((await jar.fetch(callback)).status, 303); return jar;
}
function client(t, app, jar, id = 'created-live') {
  const calls = [];
  class OriginSocket extends WebSocket { constructor(url) { super(url, { origin: app.origin }); } }
  const controller = createEditorController({ origin: app.origin, newId: () => id, confirmDiscard: async () => true,
    liveFactory: options => createLiveDocument({ ...options, WebSocketImpl: OriginSocket }),
    fetch: (path, init) => { calls.push({ path, method: init.method }); return jar.fetch(`${app.origin}${path}`, { ...init, headers: { ...init.headers,
      ...(['POST', 'PUT'].includes(init.method) ? { origin: app.origin } : {}) } }); } });
  t.after(() => controller.destroy()); return { controller, calls };
}
test('authenticated live create, two-client edits, delete, reconnect, reopen and explicit REST separation', async t => {
  const app = await fixture(t), jar = await login(app);
  const { controller: first, calls } = client(t, app, jar), { controller: second } = client(t, app, jar);
  await first.checkSession(); await second.checkSession();
  assert.equal(first.getState().liveDocuments.length, 1); assert.equal(first.getState().documents.length, 2);
  assert.equal(await first.newLiveDocument(), true); first.edit({ title: 'Shared notes', content: 'Original 😀' });
  assert.equal(await first.save(), true); assert.equal(first.getState().active.authority, 'yjs');
  assert.equal(first.edit({ content: 'Must connect first' }), false);
  assert.equal(await first.reconnectLive(), true); assert.equal(first.getState().active.content, 'Original 😀');
  assert.equal(await second.openLiveDocument('created-live'), true);
  first.edit({ content: 'First Original 😀' }); second.edit({ content: 'Original 😀 Second' });
  await eventually(() => !first.getState().dirty && !second.getState().dirty && first.getState().active.content === second.getState().active.content);
  assert.equal(first.getState().active.content, 'First Original 😀 Second');
  first.edit({ content: 'First Original 😁 Second' });
  await eventually(() => !first.getState().dirty && second.getState().active.content.includes('😁'));
  first.edit({ content: 'First 😁 Second' }); await eventually(() => !first.getState().dirty && second.getState().active.content === 'First 😁 Second');
  await first.checkSession(); assert.equal(first.getState().live.status, 'disconnected');
  first.edit({ content: 'Offline First 😁 Second' }); second.edit({ content: 'First 😁 Second online' });
  await eventually(() => !second.getState().dirty);
  assert.equal(await first.reconnectLive(), true);
  await eventually(() => !first.getState().dirty && first.getState().active.content === second.getState().active.content);
  assert.equal(first.getState().active.content, 'Offline First 😁 Second online');
  assert.equal(await first.openDocument('welcome'), true); assert.equal(first.getState().live, null);
  assert.equal(await first.openLiveDocument('created-live'), true); assert.equal(first.getState().active.content, 'Offline First 😁 Second online');
  assert.equal(calls.filter(call => call.method === 'PUT').length, 0);
  assert.equal(calls.filter(call => call.path === '/api/v1/live-documents' && call.method === 'POST').length, 1);
});
test('viewer and commenter read live state but never create/edit/replay', async t => {
  const app = await fixture(t);
  for (const role of ['viewer', 'commenter']) {
    const { controller, calls } = client(t, app, await login(app, `synthetic-${role}`));
    await controller.checkSession(); assert.equal(await controller.openLiveDocument('live-welcome'), true);
    assert.equal(controller.getState().live.role, role); assert.equal(controller.getState().dirty, false);
    assert.equal(controller.edit({ content: 'Forbidden' }), false); assert.equal(await controller.newLiveDocument(), false);
    assert.equal(calls.filter(call => call.path === '/api/v1/live-documents' && call.method === 'POST').length, 0);
  }
});
test('revoked role and expired authentication retain pending text without replay', async t => {
  const app = await fixture(t), jar = await login(app), { controller } = client(t, app, jar);
  await controller.checkSession(); await controller.openLiveDocument('live-welcome'); await controller.checkSession();
  controller.edit({ content: 'Unsent private work' });
  app.memberships.set('synthetic-editor', { principalId: 'mapped-editor', tenantId: 'synthetic-team', role: 'viewer' });
  assert.equal(await controller.reconnectLive(), false); assert.equal(controller.getState().active.content, 'Unsent private work');
  assert.equal(controller.getState().dirty, true); assert.equal(controller.getState().writable, false);
  app.memberships.delete('synthetic-editor'); await controller.checkSession();
  assert.equal(controller.getState().phase, 'expired'); assert.equal(controller.getState().active.content, 'Unsent private work');
});
test('live and standalone tickets cannot cross route namespaces', async t => {
  const app = await fixture(t), jar = await login(app);
  const session = await (await jar.fetch(`${app.origin}/auth/session`)).json();
  async function ticket(body) {
    const result = await jar.fetch(`${app.origin}/auth/collaboration-ticket`, { method: 'POST', headers: { origin: app.origin, 'content-type': 'application/json', 'x-opendoc-csrf': session.csrfToken }, body: JSON.stringify(body) });
    assert.equal(result.status, 200); return result.json();
  }
  const standalone = await ticket({ roomId: 'live-welcome' }), live = await ticket({ documentId: 'live-welcome' });
  const connectionId = 'a'.repeat(43);
  async function authorized(token, path) { return app.auth.authenticateCollaboration(new Request(app.origin + path, { headers: { origin: app.origin, authorization: `Bearer ${token}` } }), { connectionId }); }
  assert.equal(await authorized(standalone.ticket, '/api/v1/live-documents/live-welcome/collaboration'), null);
  assert.equal(await authorized(live.ticket, '/api/v1/collaboration/live-welcome'), null);
  assert.equal((await authorized(live.ticket, '/api/v1/live-documents/live-welcome/collaboration')).role, 'editor');
});
