import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorController } from '../web/controller.mjs';
const identity = { principalId: 'alice', tenantId: 'team', role: 'editor', csrfToken: 'synthetic-csrf', expiresAt: Date.now() + 60000 };
const document = (id = 'one', content = 'Original', revision = 1) => ({ id, title: `Document ${id}`, content, revision });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function setup({ responder, confirmDiscard = async () => true, role = 'editor', navigate } = {}) {
  const calls = [], changes = [];
  const fetcher = async (path, init) => {
    calls.push({ path, ...init });
    const supplied = await responder?.(path, init, calls.length);
    if (supplied !== undefined) return supplied;
    if (path === '/auth/session') return json({ ...identity, role });
    if (path === '/api/v1/documents' && init.method === 'GET') return json({ documents: [document()] });
    if (path.startsWith('/api/v1/documents/') && init.method === 'GET') return json(document(path.split('/').at(-1)));
    if (path === '/auth/logout') return json({ ok: true });
    throw new Error(`Unexpected ${init.method} ${path}`);
  };
  const controller = createEditorController({ fetch: fetcher, confirmDiscard, newId: () => 'new-doc', navigate,
    onChange: state => changes.push(state) });
  return { controller, calls, changes };
}
async function opened(options) { const harness = setup(options); await harness.controller.checkSession(); await harness.controller.openDocument('one'); return harness; }

test('initial session and lists use same-origin cookies; public state excludes CSRF', async () => {
  const { controller, calls, changes } = setup(); await controller.checkSession();
  assert.equal(controller.getState().phase, 'ready'); assert.equal(controller.getState().documents.length, 1);
  for (const call of calls) { assert.equal(call.credentials, 'same-origin'); assert.equal(call.cache, 'no-store'); assert.equal(call.redirect, 'error'); }
  assert.ok(!JSON.stringify(changes).includes(identity.csrfToken));
});
test('new draft POST and existing save PUT send exact JSON and revision guard', async () => {
  const { controller, calls } = setup({ responder: (path, init) => {
    if (init.method === 'POST' && path === '/api/v1/documents') return json({ ...JSON.parse(init.body), revision: 1 });
    if (init.method === 'PUT') return json({ id: 'new-doc', ...JSON.parse(init.body), revision: 2 });
  } });
  await controller.checkSession(); await controller.newDocument(); controller.edit({ title: 'Notes', content: '<script>plain text</script>' });
  assert.equal(await controller.save(), true); assert.equal(controller.getState().dirty, false);
  controller.edit({ content: 'Revised' }); assert.equal(await controller.save(), true);
  const posts = calls.filter(call => call.method === 'POST'); assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].body), { title: 'Notes', content: '<script>plain text</script>', id: 'new-doc' });
  assert.equal(posts[0].headers['X-OpenDoc-CSRF'], identity.csrfToken);
  const put = calls.find(call => call.method === 'PUT'); assert.equal(put.headers['If-Match'], '"1"');
  assert.deepEqual(JSON.parse(put.body), { title: 'Notes', content: 'Revised' });
  assert.equal(controller.getState().baseline.revision, 2);
});
test('edits during save stay dirty and repeated save emits one write', async () => {
  const pending = deferred();
  const { controller, calls } = await opened({ responder: (_path, init) => init.method === 'PUT' ? pending.promise : undefined });
  controller.edit({ content: 'Submitted' }); const saving = controller.save();
  assert.equal(await controller.save(), false); controller.edit({ content: 'Newer unsaved words' });
  assert.equal(await controller.newDocument(), false); assert.equal(await controller.logout(), false);
  pending.resolve(json(document('one', 'Submitted', 2))); await saving;
  assert.equal(controller.getState().active.content, 'Newer unsaved words'); assert.equal(controller.getState().dirty, true);
  assert.equal(controller.getState().baseline.content, 'Submitted'); assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
});
test('412 preserves draft, reviews remote, and only explicitly reuses the latest revision', async () => {
  let writes = 0, remote = document();
  const { controller, calls } = await opened({ responder: (path, init) => {
    if (init.method === 'PUT') { writes++; if (writes === 1) { remote = document('one', 'Another editor', 2); return json({}, 412); } return json({ ...document('one', 'My draft', 3), ...JSON.parse(init.body) }); }
    if (path === '/api/v1/documents/one') return json(remote);
  } });
  controller.edit({ content: 'My draft' }); assert.equal(await controller.save(), false);
  assert.equal(controller.getState().active.content, 'My draft'); assert.equal(controller.getState().baseline.revision, 1);
  assert.equal(controller.getState().conflict.remote.content, 'Another editor');
  assert.equal(await controller.save(), false); assert.equal(controller.keepDraft(), true);
  assert.equal(controller.getState().dirty, true); assert.equal(await controller.save(), true);
  assert.equal(calls.filter(call => call.method === 'PUT')[1].headers['If-Match'], '"2"');
});
test('uncertain save checks server once and never blindly retries a write', async () => {
  const { controller, calls } = await opened({ responder: (_path, init) => { if (init.method === 'PUT') throw new TypeError('Network failed'); } });
  controller.edit({ content: 'Keep me' }); await controller.save();
  assert.equal(controller.getState().active.content, 'Keep me'); assert.ok(controller.getState().conflict.remote);
  assert.equal(await controller.save(), false); assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
});
test('new document duplicate ID is reviewed without erasing the new draft', async () => {
  const { controller } = setup({ responder: (path, init) => path === '/api/v1/documents' && init.method === 'POST' ? json({}, 409) : undefined });
  await controller.checkSession(); await controller.newDocument(); controller.edit({ content: 'Mine' }); await controller.save();
  assert.equal(controller.getState().active.content, 'Mine'); assert.equal(controller.getState().baseline, null); assert.ok(controller.getState().conflict.remote);
});
test('dirty navigation cancel, discard, sign-out and use-remote require explicit consent', async () => {
  let allow = false, prompts = 0;
  const { controller, calls } = await opened({ confirmDiscard: async () => { prompts++; return allow; } });
  controller.edit({ content: 'Unsaved' });
  assert.equal(await controller.openDocument('two'), false); assert.equal(await controller.newDocument(), false); assert.equal(await controller.logout(), false);
  assert.equal(controller.getState().active.content, 'Unsaved'); assert.equal(calls.filter(call => call.path.endsWith('/two')).length, 0);
  allow = true; assert.equal(await controller.openDocument('two'), true); assert.equal(controller.getState().dirty, false); assert.equal(prompts, 4);
});
test('newer navigation fences older fetch results, including ignored aborts', async () => {
  const pending = deferred();
  const { controller } = setup({ responder: path => path.endsWith('/one') ? pending.promise : undefined });
  await controller.checkSession(); const one = controller.openDocument('one'); await Promise.resolve(); await Promise.resolve();
  await controller.openDocument('two'); pending.resolve(json(document('one', 'Stale'))); await one;
  assert.equal(controller.getState().active.id, 'two'); assert.equal(controller.getState().loading, false);
});
test('logout fences a pending document response', async () => {
  const pending = deferred();
  const { controller } = setup({ responder: path => path.endsWith('/one') ? pending.promise : undefined });
  await controller.checkSession(); const loading = controller.openDocument('one'); await Promise.resolve(); await Promise.resolve();
  await controller.logout(); pending.resolve(json(document())); await loading;
  assert.equal(controller.getState().phase, 'signed-out'); assert.equal(controller.getState().active, null);
});
test('simultaneous login clicks launch one POST and successful redirect remains locked', async () => {
  const pending = deferred(), navigations = [];
  const { controller, calls } = setup({ responder: path => path === '/auth/login' ? pending.promise : undefined, navigate: url => navigations.push(url) });
  const first = controller.login(), second = controller.login(); await Promise.resolve(); await Promise.resolve();
  pending.resolve(json({ authorizationUrl: 'https://id.example.test/authorize?state=synthetic' }));
  await Promise.all([first, second]); await controller.login();
  assert.equal(calls.filter(call => call.path === '/auth/login').length, 1); assert.equal(navigations.length, 1);
  assert.equal(calls.find(call => call.path === '/auth/login').headers['X-OpenDoc-Login'], '1');
});
test('simultaneous logout clicks emit one POST', async () => {
  const pending = deferred();
  const { controller, calls } = setup({ responder: path => path === '/auth/logout' ? pending.promise : undefined });
  await controller.checkSession(); const first = controller.logout(), second = controller.logout(); await Promise.resolve(); await Promise.resolve();
  pending.resolve(json({ ok: true })); await Promise.all([first, second]);
  assert.equal(calls.filter(call => call.path === '/auth/logout').length, 1); assert.equal(controller.getState().phase, 'signed-out');
});
test('viewer and commenter cannot create/edit/save, while still loading documents', async () => {
  for (const role of ['viewer', 'commenter']) {
    const { controller, calls } = await opened({ role });
    assert.equal(controller.edit({ content: 'Forbidden' }), false); assert.equal(await controller.newDocument(), false); assert.equal(await controller.save(), false);
    assert.equal(controller.getState().active.content, 'Original'); assert.equal(calls.filter(call => call.method !== 'GET').length, 0);
  }
});
test('role downgrade and 401 preserve unsaved text read-only', async () => {
  let result = identity;
  const { controller } = await opened({ responder: path => path === '/auth/session' ? json(result, result ? 200 : 401) : undefined });
  controller.edit({ content: 'Private unsaved text' }); result = { ...identity, role: 'viewer' }; await controller.checkSession();
  assert.equal(controller.getState().dirty, true); assert.equal(controller.getState().writable, false);
  result = null; await controller.checkSession(); assert.equal(controller.getState().phase, 'expired');
  assert.equal(controller.getState().active.content, 'Private unsaved text');
});
test('draft ownership survives expiry and prevents cross-account or cross-tenant saves', async () => {
  for (const changed of [{ ...identity, principalId: 'bob' }, { ...identity, tenantId: 'other' }]) {
    for (const fresh of [false, true]) {
      let result = identity;
      const { controller, calls } = await opened({ responder: path => path === '/auth/session' ? json(result, result ? 200 : 401) : undefined });
      if (fresh) await controller.newDocument(); controller.edit({ content: 'Alice private draft' });
      result = null; await controller.checkSession(); result = changed; await controller.checkSession();
      assert.equal(controller.getState().phase, 'expired'); assert.equal(controller.getState().writable, false);
      assert.equal(controller.getState().active.content, 'Alice private draft'); assert.equal(await controller.save(), false);
      assert.equal(calls.filter(call => ['POST', 'PUT'].includes(call.method)).length, 0);
    }
  }
});
test('failed and forbidden writes preserve text, and oversized text is rejected before sending', async () => {
  const { controller, calls } = await opened({ responder: (_path, init) => init.method === 'PUT' ? json({}, 403) : undefined });
  controller.edit({ content: 'Keep' }); await controller.save(); assert.equal(controller.getState().active.content, 'Keep');
  assert.match(controller.getState().error, /permission/); assert.equal(controller.getState().writable, false);
  assert.equal(await controller.save(), false); await controller.checkSession(); assert.equal(controller.getState().writable, true);
  controller.edit({ content: 'x'.repeat(1024 * 1024 + 1) }); await controller.save();
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1); assert.match(controller.getState().error, /1 MiB/);
});
test('destroyed controller ignores late results', async () => {
  const pending = deferred(); const { controller, changes } = setup({ responder: path => path === '/auth/session' ? pending.promise : undefined });
  const checking = controller.checkSession(); controller.destroy(); const count = changes.length;
  pending.resolve(json(identity)); await checking; assert.equal(changes.length, count); assert.equal(controller.getState().identity, null);
});

test('use saved version preserves local work on Cancel and replaces it only after consent', async () => {
  let allow = false, remote = document();
  const { controller } = await opened({ confirmDiscard: async () => allow, responder: (path, init) => {
    if (init.method === 'PUT') { remote = document('one', 'Saved elsewhere', 2); return json({}, 412); }
    if (path.endsWith('/one')) return json(remote);
  } });
  controller.edit({ content: 'My unsaved text' }); await controller.save();
  assert.equal(await controller.useSavedVersion(), false); assert.equal(controller.getState().active.content, 'My unsaved text');
  allow = true; assert.equal(await controller.useSavedVersion(), true);
  assert.equal(controller.getState().active.content, 'Saved elsewhere'); assert.equal(controller.getState().dirty, false); assert.equal(controller.getState().conflict, null);
});
test('a delayed discard dialog cannot erase edits made while it is open', async () => {
  const decision = deferred();
  const { controller } = await opened({ confirmDiscard: () => decision.promise });
  controller.edit({ content: 'First draft' }); const navigation = controller.openDocument('two');
  controller.edit({ content: 'Newer draft' }); decision.resolve(true);
  assert.equal(await navigation, false); assert.equal(controller.getState().active.content, 'Newer draft');
});
test('session check cancels a pending load even when the session endpoint fails', async () => {
  let sessionReads = 0; const pending = deferred();
  const { controller } = await opened({ responder: path => {
    if (path === '/auth/session') { sessionReads++; return sessionReads > 1 ? json({}, 503) : undefined; }
    if (path.endsWith('/two')) return pending.promise;
  } });
  const loading = controller.openDocument('two'); await Promise.resolve(); await Promise.resolve();
  await controller.checkSession(); pending.resolve(json(document('two'))); await loading;
  assert.equal(controller.getState().active.id, 'one'); assert.equal(controller.getState().loading, false);
  assert.equal(controller.edit({ content: 'Still available' }), true);
});
test('latest list refresh wins over an older result', async () => {
  let lists = 0; const pending = deferred();
  const { controller } = setup({ responder: (path, init) => {
    if (path === '/api/v1/documents' && init.method === 'GET') { lists++; return lists === 2 ? pending.promise : lists === 3 ? json({ documents: [document('latest')] }) : undefined; }
  } });
  await controller.checkSession(); const older = controller.refreshDocuments(); await controller.refreshDocuments();
  pending.resolve(json({ documents: [document('stale')] })); await older;
  assert.equal(controller.getState().documents[0].id, 'latest'); assert.equal(controller.getState().busy.includes('list'), false);
});
