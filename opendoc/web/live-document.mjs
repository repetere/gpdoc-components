// Original plain-text Yjs editor binding. MIT. All retained work stays in memory.
import * as Y from 'yjs';
import { connectLiveCollaboration } from '../src/live-collaboration-client.mjs';
const MAX_STATE = 1024 * 1024, MAX_CONTENT = 256 * 1024;
const WRITERS = new Set(['owner', 'editor']);
const LOCAL = Object.freeze({ editor: 'opendoc' });
const RETRY_DELAYS = [500, 1500, 3000];
const STABLE_MS = 15000;
// Ticket lifetimes remain server-owned. Never renew a sub-250ms ticket in a loop.
const MIN_TICKET_MS = 250;
function difference(before, after) {
  let start = 0, end = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  if (start > 0 && /[\uD800-\uDBFF]/.test(before[start - 1])) start--;
  while (end < before.length - start && end < after.length - start && before[before.length - end - 1] === after[after.length - end - 1]) end++;
  if (end > 0 && /[\uDC00-\uDFFF]/.test(before[before.length - end])) end--;
  return { start, removed: before.length - start - end, inserted: after.slice(start, after.length - end) };
}
function apply(doc, changes) {
  doc.transact(() => { for (const [key, value] of Object.entries(changes)) {
    const text = doc.getText(key), delta = difference(text.toString(), value);
    if (delta.removed) text.delete(delta.start, delta.removed);
    if (delta.inserted) text.insert(delta.start, delta.inserted);
  } }, LOCAL);
}
export function createLiveDocument({ onChange = () => {}, onError = () => {}, getSelection = () => null,
  connect = connectLiveCollaboration, WebSocketImpl } = {}) {
  const doc = new Y.Doc();
  let transport = null, abort = null, generation = 0, stopped = false, initialized = false;
  let retained = null, authorize = null, retryTimer = null, renewalTimer = null, stableTimer = null;
  let retries = 0, retryAt = null;
  let status = 'disconnected', pending = false, role = null, revision = 0, selection = null, composing = null;
  const current = () => ({ title: retained?.title ?? doc.getText('title').toString(), content: retained?.content ?? doc.getText('content').toString(), blocked: Boolean(retained),
    status, pending: pending || Boolean(composing), role, revision, initialized, selection, retries, retryAt });
  const emit = () => { if (!stopped) onChange(current()); };
  doc.on('beforeTransaction', transaction => {
    selection = null;
    if (transaction.origin === LOCAL || composing) return;
    const selected = getSelection();
    if (selected && ['title', 'content'].includes(selected.field)) {
      const text = doc.getText(selected.field);
      selection = { field: selected.field, start: Y.createRelativePositionFromTypeIndex(text, Math.min(selected.start, text.length)),
        end: Y.createRelativePositionFromTypeIndex(text, Math.min(selected.end, text.length)) };
    }
  });
  doc.on('afterTransaction', transaction => {
    if (selection) {
      const start = Y.createAbsolutePositionFromRelativePosition(selection.start, doc), end = Y.createAbsolutePositionFromRelativePosition(selection.end, doc);
      selection = start && end ? { field: selection.field, start: start.index, end: end.index } : null;
    }
    if (transaction.origin === LOCAL && transaction.changed.size) pending = true;
    emit();
  });
  function cancelAttempt() {
    generation++; clearTimeout(retryTimer); clearTimeout(renewalTimer); clearTimeout(stableTimer);
    retryTimer = renewalTimer = stableTimer = null; retryAt = null;
    abort?.abort(); abort = null; transport?.close(); transport = null;
  }
  function disconnect(reason = 'disconnected') {
    cancelAttempt(); authorize = null; status = reason; emit();
  }
  function failed(error, own) {
    if (stopped || own !== generation) return;
    cancelAttempt();
    if (error?.code === 'auth-lost' || [401, 403, 404].includes(error?.status)) {
      authorize = null; status = 'auth-lost';
    } else if (authorize && error?.retryable !== false && retries < RETRY_DELAYS.length) {
      const delay = RETRY_DELAYS[retries++]; status = 'retrying'; retryAt = Date.now() + delay;
      const expected = generation;
      retryTimer = setTimeout(() => { if (!stopped && expected === generation) void attempt('retrying'); }, delay); retryTimer.unref?.();
    } else { authorize = null; status = error?.retryable === false ? 'stopped' : 'disconnected'; }
    const failedGeneration = generation; emit();
    if (!stopped && failedGeneration === generation) onError(error);
  }
  async function attempt(mode, credential) {
    cancelAttempt(); const own = generation; abort = new AbortController(); status = mode; emit();
    if (stopped || own !== generation) return false;
    try {
      const ticket = credential ?? await authorize({ signal: abort.signal });
      if (stopped || own !== generation) return false;
      let remaining;
      if (authorize) {
        remaining = ticket?.expiresAt - Date.now();
        if (!Number.isFinite(remaining) || remaining < MIN_TICKET_MS || remaining > 60000) {
          const error = new Error('Live ticket expiry is invalid or too short. Check your session before reconnecting.'); error.retryable = false; throw error;
        }
      }
      const next = await connect({ ...ticket, doc, replay: pending, signal: abort.signal, WebSocketImpl,
        onState(value) {
          if (stopped || own !== generation) return;
          if (['owner', 'editor', 'viewer', 'commenter'].includes(value.role)) role = value.role;
          if (value.revision >= 1) revision = value.revision; pending = value.pending;
          if (value.connected) status = 'connected'; initialized ||= value.connected; emit();
        },
        onError(error) { failed(error, own); }
      });
      if (stopped || own !== generation) { next.close(); return false; }
      transport = next; initialized = true; role = next.role; revision = next.revision; pending = next.pending; status = 'connected'; emit();
      if (stopped || own !== generation) return false;
      if (authorize) {
        // Fixed delays are bounded, and only a genuinely stable connection resets
        // the failure budget. Short open/close cycles cannot create an endless loop.
        stableTimer = setTimeout(() => { if (own === generation) { retries = 0; emit(); } }, STABLE_MS); stableTimer.unref?.();
        const delay = Math.max(0, ticket.expiresAt - Date.now() - Math.min(5000, remaining * 0.2));
        renewalTimer = setTimeout(() => { if (!stopped && own === generation) void attempt('renewing'); }, delay); renewalTimer.unref?.();
      }
      return true;
    } catch (error) { failed(error, own); return false; }
  }
  async function reconnect(options) {
    if (stopped || retained) return false;
    const expected = generation + 1; disconnect();
    if (stopped || retained || expected !== generation) return false;
    retries = 0;
    authorize = typeof options.authorize === 'function' ? options.authorize : null;
    return attempt('connecting', authorize ? undefined : options);
  }
  function validate(changes) {
    if (!initialized || !WRITERS.has(role) || stopped) return false;
    for (const [key, value] of Object.entries(changes)) if (!['title', 'content'].includes(key) || typeof value !== 'string' || !value.isWellFormed() ||
      key === 'title' && value.length > 200 || key === 'content' && new TextEncoder().encode(value).length > MAX_CONTENT) return false;
    const trial = new Y.Doc();
    try { Y.applyUpdate(trial, Y.encodeStateAsUpdate(doc)); apply(trial, changes); return Y.encodeStateAsUpdate(trial).byteLength <= MAX_STATE; }
    finally { trial.destroy(); }
  }
  function edit(changes, preserveComposition = false) {
    if (!validate(changes)) {
      // Preserve rejected pasted/typed text for download, without sending invalid CRDT state.
      // The DOM bounds input to 262144 code units (at most 1 MiB UTF-8).
      if (!stopped && initialized && (WRITERS.has(role) || preserveComposition) && Object.entries(changes).every(([key, value]) => ['title', 'content'].includes(key) && typeof value === 'string' && value.length <= 262144)) {
        retained = { title: doc.getText('title').toString(), content: doc.getText('content').toString(), ...changes }; pending = true; disconnect('stopped'); emit();
      }
      onError(new Error('Live limit or invalid text reached. Your text is retained in this tab for download; it was not sent. Open a new document after downloading.')); return false;
    }
    apply(doc, changes); return true;
  }
  function beginComposition(field) {
    if (composing || stopped || !initialized || !WRITERS.has(role) || !['title', 'content'].includes(field)) return false;
    const base = new Y.Doc(); Y.applyUpdate(base, Y.encodeStateAsUpdate(doc)); composing = { field, base }; emit(); return true;
  }
  function endComposition(value) {
    if (!composing) return false;
    const { field, base } = composing; composing = null;
    try {
      const source = base.getText(field), delta = difference(source.toString(), value);
      const a = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromTypeIndex(source, delta.start), doc);
      const b = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromTypeIndex(source, delta.start + delta.removed), doc);
      if (!a || !b) return false;
      const target = doc.getText(field).toString();
      // Keep remote insertions inside an IME replacement range rather than deleting them.
      // Only original characters selected by the composition are removed using their IDs.
      const removals = [];
      for (let i = delta.start; i < delta.start + delta.removed; i++) {
        const position = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromTypeIndex(source, i), doc);
        const end = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromTypeIndex(source, i + 1, -1), doc);
        if (position && end && end.index > position.index) removals.push([position.index, end.index - position.index]);
      }
      let next = target;
      for (const [start, count] of removals.reverse()) next = next.slice(0, start) + next.slice(start + count);
      next = next.slice(0, a.index) + delta.inserted + next.slice(a.index);
      return edit({ [field]: next }, true);
    } finally { base.destroy(); }
  }
  return { getState: current, reconnect, disconnect, edit, beginComposition, endComposition,
    destroy() { disconnect(); stopped = true; composing?.base.destroy(); composing = null; doc.destroy(); } };
}
