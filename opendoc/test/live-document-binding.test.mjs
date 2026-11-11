import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { createLiveDocument } from '../web/live-document.mjs';
async function fixture(content) {
  let captured, opens = 0;
  const server = new Y.Doc(); server.getText('content').insert(0, content); server.getText('title').insert(0, 'Title');
  const binding = createLiveDocument({ connect: async options => {
    opens++; captured = options; Y.applyUpdate(options.doc, Y.encodeStateAsUpdate(server));
    options.onState({ connected: true, pending: options.replay, role: 'editor', revision: 1 });
    return { role: 'editor', revision: 1, pending: options.replay, close() {} };
  } });
  await binding.reconnect({ url: 'unused', token: 'unused' });
  return { binding, server, doc: captured.doc, opens: () => opens, close() { binding.destroy(); server.destroy(); } };
}
test('Unicode edits retain exact text across full-state persistence and do not split surrogate pairs', async () => {
  for (const [before, after] of [['😀', '😁'], ['x😀y', 'x😁y'], ['😀', ''], ['a', '😀a'], ['😀x😁', '😁x😀']]) {
    const f = await fixture(before); assert.equal(f.binding.edit({ content: after }), true);
    assert.equal(f.binding.getState().content, after); const reopened = new Y.Doc(); Y.applyUpdate(reopened, Y.encodeStateAsUpdate(f.doc));
    assert.equal(reopened.getText('content').toString(), after); reopened.destroy(); f.close();
  }
});
test('rejected live content remains available for download without poisoning Yjs or reconnecting', async () => {
  for (const text of ['\ud800', '😀'.repeat(70000)]) {
    const f = await fixture('original'); assert.equal(f.binding.edit({ content: text }), false);
    assert.equal(f.binding.getState().content, text); assert.equal(f.binding.getState().pending, true); assert.equal(f.binding.getState().blocked, true);
    assert.equal(f.doc.getText('content').toString(), 'original'); assert.equal(await f.binding.reconnect({ url: 'unused', token: 'unused' }), false);
    assert.equal(f.opens(), 1); f.close();
  }
});
test('destroyed bindings cannot open another socket', async () => {
  const f = await fixture('keep'); f.binding.destroy(); assert.equal(await f.binding.reconnect({ url: 'unused', token: 'unused' }), false); assert.equal(f.opens(), 1); f.server.destroy();
});
test('composition merges a concurrent insertion instead of replacing the textarea snapshot', async () => {
  const f = await fixture('abc'); Y.applyUpdate(f.server, Y.encodeStateAsUpdate(f.doc));
  f.binding.beginComposition('content'); f.server.getText('content').insert(1, 'REMOTE'); Y.applyUpdate(f.doc, Y.encodeStateAsUpdate(f.server));
  assert.equal(f.binding.endComposition('a漢bc'), true); assert.equal(f.binding.getState().content, 'aREMOTE漢bc'); f.close();
});
test('composition replacement preserves concurrent characters within its selection', async () => {
  const f = await fixture('abc'); Y.applyUpdate(f.server, Y.encodeStateAsUpdate(f.doc));
  f.binding.beginComposition('content'); f.server.getText('content').insert(2, 'REMOTE'); Y.applyUpdate(f.doc, Y.encodeStateAsUpdate(f.server));
  assert.equal(f.binding.endComposition('a漢'), true); assert.equal(f.binding.getState().content, 'a漢REMOTE'); f.close();
});

test('an unfinished IME composition counts as pending for navigation and unload guards', async () => {
  const f = await fixture('abc'); assert.equal(f.binding.getState().pending, false);
  assert.equal(f.binding.beginComposition('content'), true); assert.equal(f.binding.getState().pending, true);
  f.binding.disconnect(); assert.equal(f.binding.getState().pending, true);
  assert.equal(f.binding.endComposition('a漢bc'), true); assert.equal(f.binding.getState().content, 'a漢bc');
  assert.equal(f.binding.getState().pending, true); f.close();
});
