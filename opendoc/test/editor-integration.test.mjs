// Local HTTP, real synthetic OIDC, real REST store and actual browser controller.
// This is not browser cookie/SameSite/CSP verification; Chromium QA is separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startSyntheticEditorDemo } from './fixtures/editor-demo.mjs';
import { NetworkCookieJar, authorizeAtProvider } from './fixtures/oidc-provider.mjs';
import { createEditorController } from '../web/controller.mjs';

async function fixture(t) {
  const previous = process.env.OPENDOC_SYNTHETIC_EDITOR;
  process.env.OPENDOC_SYNTHETIC_EDITOR = '1';
  let app;
  try { app = await startSyntheticEditorDemo(); }
  finally { if (previous === undefined) delete process.env.OPENDOC_SYNTHETIC_EDITOR; else process.env.OPENDOC_SYNTHETIC_EDITOR = previous; }
  t.after(() => app.close()); return app;
}
async function login(app, subject = 'synthetic-editor') {
  const jar = new NetworkCookieJar();
  const result = await jar.fetch(`${app.origin}/auth/login`, { method: 'POST', headers: { origin: app.origin, 'content-type': 'application/json', 'x-opendoc-login': '1' }, body: '{}' });
  assert.equal(result.status, 200);
  const callback = await authorizeAtProvider({ provider: app.provider, jar, authorizationUrl: (await result.json()).authorizationUrl, subject });
  assert.equal((await jar.fetch(callback)).status, 303);
  return jar;
}
function client(app, jar, id) {
  return createEditorController({ newId: () => id, confirmDiscard: async () => true,
    fetch: (path, init) => jar.fetch(`${app.origin}${path}`, { ...init, headers: { ...init.headers, ...(['POST', 'PUT'].includes(init.method) ? { origin: app.origin } : {}) } }) });
}

test('synthetic editor fixture requires explicit opt-in', async () => {
  const previous = process.env.OPENDOC_SYNTHETIC_EDITOR; delete process.env.OPENDOC_SYNTHETIC_EDITOR;
  try { await assert.rejects(startSyntheticEditorDemo(), /Explicit/); }
  finally { if (previous !== undefined) process.env.OPENDOC_SYNTHETIC_EDITOR = previous; }
});
test('real OIDC + REST editor create/read/save/two-client conflict/logout', async t => {
  const app = await fixture(t), jar = await login(app);
  const first = client(app, jar, 'integration-draft'), second = client(app, jar, 'second');
  t.after(() => { first.destroy(); second.destroy(); });
  assert.equal(await first.checkSession(), true); assert.equal(await second.checkSession(), true);
  assert.equal(first.getState().documents.length, 2);
  await first.newDocument(); first.edit({ title: 'Integration notes', content: 'First draft' }); assert.equal(await first.save(), true);
  await second.openDocument('integration-draft'); first.edit({ content: 'First client saved' }); assert.equal(await first.save(), true);
  second.edit({ content: 'Second client unsaved' }); assert.equal(await second.save(), false);
  assert.equal(second.getState().active.content, 'Second client unsaved'); assert.equal(second.getState().conflict.remote.content, 'First client saved');
  second.keepDraft(); assert.equal(await second.save(), true);
  await first.openDocument('integration-draft'); assert.equal(first.getState().active.content, 'Second client unsaved'); assert.equal(first.getState().active.revision, 3);
  assert.equal(await first.logout(), true); await second.checkSession(); assert.equal(second.getState().phase, 'expired');
  assert.equal(second.getState().active.content, 'Second client unsaved'); assert.equal(second.getState().writable, false);
});
test('real synthetic viewer can read but cannot create or edit', async t => {
  const app = await fixture(t), jar = await login(app, 'synthetic-viewer'); const editor = client(app, jar, 'viewer-draft');
  t.after(() => editor.destroy()); await editor.checkSession(); assert.equal(editor.getState().identity.role, 'viewer');
  await editor.openDocument('welcome'); assert.ok(editor.getState().active.content.includes('Welcome to OpenDoc'));
  assert.equal(await editor.newDocument(), false); assert.equal(editor.edit({ content: 'Rejected' }), false); assert.equal(await editor.save(), false);
});
