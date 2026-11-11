import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { StoreError } from '../src/memory-store.mjs';
import { COLLABORATION_LIMITS, MAX_COLLABORATION_UPDATE_BYTES, MAX_COLLABORATION_STATE_BYTES, mergeCollaborationState } from '../src/collaboration-state.mjs';

function rejects(code) { return e => e instanceof StoreError && e.code === code && e.message === code && e.cause === undefined; }
function update(text = 'Synthetic', id = 1) {
  const doc = new Y.Doc();
  doc.clientID = id;
  doc.getText('body').insert(0, text);
  const result = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return result;
}
function view(bytes) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  const result = doc.getText('body').toString();
  doc.destroy();
  return result;
}
function uint(number) {
  const bytes = [];
  while (number >= 128) { bytes.push(number % 128 + 128); number = Math.floor(number / 128); }
  bytes.push(number);
  return bytes;
}

// @spec OD-COLLAB-002, OD-COLLAB-004
test('Yjs v1 merges concurrent clients, replay is idempotent, and output bytes are detached', async () => {
  const initial = await mergeCollaborationState(null, update('A'));
  assert.equal(initial.changed, true);
  const doc = new Y.Doc();
  const other = new Y.Doc();
  doc.clientID = 2; other.clientID = 3;
  Y.applyUpdate(doc, initial.state); Y.applyUpdate(other, initial.state);
  const vector = Y.encodeStateVector(doc);
  doc.getText('body').insert(1, 'B');
  other.getText('body').insert(1, 'C');
  const first = Y.encodeStateAsUpdate(doc, vector);
  const second = Y.encodeStateAsUpdate(other, vector);
  const left = await mergeCollaborationState(initial.state, first);
  const final = await mergeCollaborationState(left.state, second);
  const right = await mergeCollaborationState(initial.state, second);
  const reverse = await mergeCollaborationState(right.state, first);
  assert.equal(view(final.state), view(reverse.state));
  assert.equal(view(final.state), 'ABC');
  assert.equal((await mergeCollaborationState(final.state, first)).changed, false);
  const replay = await mergeCollaborationState(final.state, final.state);
  assert.deepEqual(replay.state, final.state);
  assert.equal(replay.changed, false);
  replay.state.fill(0);
  assert.equal(view(final.state), 'ABC');
  doc.destroy(); other.destroy();
});

// @spec OD-COLLAB-004
test('out-of-order edits and deletes remain in the snapshot until missing dependencies arrive', async () => {
  const doc = new Y.Doc(); doc.clientID = 11;
  const emitted = [];
  doc.on('update', bytes => emitted.push(bytes));
  doc.getText('body').insert(0, 'A');
  doc.getText('body').insert(1, 'B');
  doc.getText('body').delete(0, 1);
  const pendingEdit = await mergeCollaborationState(null, emitted[1]);
  assert.equal(view(pendingEdit.state), '');
  assert.equal((await mergeCollaborationState(pendingEdit.state, emitted[1])).changed, false);
  const pendingBoth = await mergeCollaborationState(pendingEdit.state, emitted[2]);
  const resolved = await mergeCollaborationState(pendingBoth.state, emitted[0]);
  assert.equal(view(resolved.state), 'B');
  const reopened = new Y.Doc(); Y.applyUpdate(reopened, resolved.state);
  assert.equal(reopened.store.pendingStructs, null);
  assert.equal(reopened.store.pendingDs, null);
  reopened.destroy(); doc.destroy();
});

// @spec OD-COLLAB-002, OD-COLLAB-006
test('legitimate maps, arrays, nested XML, formatting, and opaque strings survive the merge', async () => {
  const doc = new Y.Doc(); doc.clientID = 12;
  doc.getText('body').insert(0, 'A\u0000🌿', { bold: true });
  doc.getMap('metadata').set('value', { list: [1, null, true, 'text'], bytes: new Uint8Array([1, 2]) });
  const array = doc.getArray('items'); array.push(['one', 2]);
  const element = new Y.XmlElement('paragraph');
  const text = new Y.XmlText(); text.insert(0, 'Content');
  element.insert(0, [text]); doc.getXmlFragment('rich').insert(0, [element]);
  const merged = await mergeCollaborationState(null, Y.encodeStateAsUpdate(doc));
  const restored = new Y.Doc(); Y.applyUpdate(restored, merged.state);
  assert.equal(restored.getText('body').toString(), 'A\u0000🌿');
  assert.deepEqual(restored.getArray('items').toArray(), ['one', 2]);
  assert.deepEqual(restored.getMap('metadata').get('value'), doc.getMap('metadata').get('value'));
  assert.equal(restored.getXmlFragment('rich').toString(), '<paragraph>Content</paragraph>');
  assert.equal((await mergeCollaborationState(merged.state, new Uint8Array([0, 0]))).changed, false);
  doc.destroy(); restored.destroy();
});

// @spec OD-COLLAB-006
test('malformed, truncated, trailing, empty, subdocument and oversized inputs are rejected without leaked errors', async () => {
  for (const bytes of [null, [], new Uint8Array(), new Uint8Array([0]), new Uint8Array([255, 255]),
    new Uint8Array([0, 0]), new Uint8Array([...update(), 0]), update().slice(0, -1)]) {
    await assert.rejects(mergeCollaborationState(null, bytes), rejects('BAD_REQUEST'));
  }
  await assert.rejects(mergeCollaborationState(null, new Uint8Array(MAX_COLLABORATION_UPDATE_BYTES + 1)), rejects('TOO_LARGE'));
  await assert.rejects(mergeCollaborationState(new Uint8Array(MAX_COLLABORATION_STATE_BYTES + 1), update()), rejects('DEPENDENCY_UNAVAILABLE'));
  await assert.rejects(mergeCollaborationState(new Uint8Array([255, 255]), update()), rejects('DEPENDENCY_UNAVAILABLE'));
  await assert.rejects(mergeCollaborationState(null, new Uint8Array(new SharedArrayBuffer(2))), rejects('BAD_REQUEST'));
  const doc = new Y.Doc(); doc.getMap('docs').set('nested', new Y.Doc());
  await assert.rejects(mergeCollaborationState(null, Y.encodeStateAsUpdate(doc)), rejects('BAD_REQUEST'));
  doc.destroy();
});

// @spec OD-COLLAB-006
test('structure, client, clock, root-type, nested-type and value-depth bounds reject compact amplification', async () => {
  const clientHeavy = new Y.Doc();
  for (let i = 0; i <= COLLABORATION_LIMITS.maxClients; i++) Y.applyUpdate(clientHeavy, update('x', i + 1));
  await assert.rejects(mergeCollaborationState(null, Y.encodeStateAsUpdate(clientHeavy)), rejects('TOO_LARGE'));
  clientHeavy.destroy();
  // One GC span can encode enormous logical history in very few bytes.
  const largeClock = Uint8Array.from([1, 1, 1, 0, 0, ...uint(COLLABORATION_LIMITS.maxClock + 1), 0]);
  await assert.rejects(mergeCollaborationState(null, largeClock), rejects('TOO_LARGE'));
  const structs = Uint8Array.from([1, ...uint(COLLABORATION_LIMITS.maxStructs + 1), 1, 0,
    ...Array.from({ length: COLLABORATION_LIMITS.maxStructs + 1 }, () => [0, 1]).flat(), 0]);
  assert.ok(structs.length < MAX_COLLABORATION_UPDATE_BYTES);
  await assert.rejects(mergeCollaborationState(null, structs), rejects('TOO_LARGE'));
  const roots = new Y.Doc();
  for (let i = 0; i <= COLLABORATION_LIMITS.maxSharedTypes; i++) roots.getText(`root${i}`).insert(0, 'x');
  await assert.rejects(mergeCollaborationState(null, Y.encodeStateAsUpdate(roots)), rejects('TOO_LARGE'));
  roots.destroy();
  const nested = new Y.Doc(); let array = nested.getArray('root');
  for (let i = 0; i <= COLLABORATION_LIMITS.maxTypeDepth; i++) { const child = new Y.Array(); array.push([child]); array = child; }
  await assert.rejects(mergeCollaborationState(null, Y.encodeStateAsUpdate(nested)), rejects('TOO_LARGE'));
  nested.destroy();
  const values = new Y.Doc(); let value = {};
  for (let i = 0; i <= COLLABORATION_LIMITS.maxValueDepth; i++) value = { child: value };
  values.getMap('root').set('nested', value);
  await assert.rejects(mergeCollaborationState(null, Y.encodeStateAsUpdate(values)), rejects('TOO_LARGE'));
  values.destroy();
});

// @spec OD-COLLAB-006
test('pending causal data is preserved only inside its combined fixed byte budget', async () => {
  const incomplete = id => {
    const doc = new Y.Doc(); doc.clientID = id;
    doc.getText('body').insert(0, 'a');
    const vector = Y.encodeStateVector(doc);
    doc.getText('body').insert(1, 'x'.repeat(40000));
    const result = Y.encodeStateAsUpdate(doc, vector); doc.destroy(); return result;
  };
  const first = await mergeCollaborationState(null, incomplete(22));
  assert.equal(view(first.state), '');
  await assert.rejects(mergeCollaborationState(first.state, incomplete(23)), rejects('TOO_LARGE'));
  assert.equal(view(first.state), '');
});

// @spec OD-COLLAB-006
test('worker admission is bounded without an unbounded request queue, and caller input is snapshotted', async () => {
  const bytes = update('original');
  const work = Array.from({ length: COLLABORATION_LIMITS.maxWorkers }, () => mergeCollaborationState(null, bytes));
  const refused = mergeCollaborationState(null, bytes);
  bytes.fill(0);
  await assert.rejects(refused, rejects('CAPACITY_EXCEEDED'));
  const results = await Promise.all(work);
  assert.ok(results.every(result => view(result.state) === 'original'));
  assert.equal(view((await mergeCollaborationState(null, update('next'))).state), 'next');
});

// @spec OD-COLLAB-006
test('merged snapshots cannot exceed one MiB even with few binary-content structs', async () => {
  const doc = new Y.Doc(); doc.clientID = 31;
  const items = doc.getArray('binary');
  for (let i = 0; i < 17; i++) items.push([new Uint8Array(61000)]);
  const previous = Y.encodeStateAsUpdate(doc);
  assert.ok(previous.byteLength < MAX_COLLABORATION_STATE_BYTES);
  const vector = Y.encodeStateVector(doc);
  items.push([new Uint8Array(61000)]);
  const delta = Y.encodeStateAsUpdate(doc, vector);
  assert.ok(delta.byteLength < MAX_COLLABORATION_UPDATE_BYTES);
  await assert.rejects(mergeCollaborationState(previous, delta), rejects('TOO_LARGE'));
  doc.destroy();
});
