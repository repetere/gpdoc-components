// Original OpenDoc REST and opt-in live editor state machine. No DOM, storage, or provider tokens.
const WRITERS = new Set(['owner', 'editor']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\s\S])/;
const MAX_BYTES = 1024 * 1024;
const sameText = (a, b) => a && b && a.title === b.title && a.content === b.content;
const copy = value => value == null ? value : structuredClone(value);
class ApiError extends Error {
  constructor(status) { super(`HTTP ${status}`); this.status = status; }
}
function validDocument(doc) {
  return doc && ID.test(doc.id) && typeof doc.title === 'string' && doc.title.length <= 200 && typeof doc.content === 'string'
    && Number.isSafeInteger(doc.revision) && doc.revision > 0;
}

/** All credentials and drafts live only in this instance's memory. */
export function createEditorController({ fetch: fetcher = globalThis.fetch, onChange = () => {},
  confirmDiscard = async () => false, navigate = () => {},
  newId = () => `doc-${globalThis.crypto.randomUUID()}`, requestTimeoutMs = 15000,
  liveFactory = null, origin = globalThis.location?.origin } = {}) {
  let session = null;
  let live = null, expiryTimer = null;
  let documentOwner = null;
  let writeSuspended = false;
  let epoch = 0, navigation = 0, listing = 0, guardSequence = 0;
  let stopped = false;
  const requests = new Set();
  const busy = new Set();
  const state = { phase: 'checking', identity: null, documents: [], active: null, baseline: null,
    conflict: null, live: null, liveDocuments: [], liveListError: '', loading: false, error: '', notice: '', listError: '' };
  const isLive = () => state.active?.authority === 'yjs';
  const dirty = () => Boolean(state.active && (isLive() && live ? state.live?.pending : !state.baseline || !sameText(state.active, state.baseline)));
  function closeLive(discard = false) { if (discard) { const old = live; live = null; state.live = null; old?.destroy(); } else live?.disconnect(); }
  const canCreate = () => state.phase === 'ready' && !writeSuspended && WRITERS.has(session?.role);
  const writable = () => Boolean(canCreate()
    && (!isLive() || !live && state.active.revision == null || (state.live?.initialized && WRITERS.has(state.live.role) && !state.live.blocked && state.live.status !== 'connecting')));
  const snapshot = () => ({ ...copy(state), dirty: dirty(), writable: writable(), canCreate: canCreate(), busy: [...busy] });
  const emit = () => { if (!stopped) onChange(snapshot()); };
  function expired() {
    closeLive(); clearTimeout(expiryTimer);
    epoch++; navigation++; listing++; guardSequence++;
    session = null; state.identity = null; state.phase = 'expired'; state.loading = false;
    state.documents = []; state.liveDocuments = []; state.conflict = null;
    state.error = 'Your session ended. Your current text is still here. Download it before signing in again.';
  }
  async function request(path, { method = 'GET', body, revision, login = false } = {}) {
    const controller = new AbortController(); requests.add(controller);
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const headers = { Accept: 'application/json' };
      if (body !== undefined) Object.assign(headers, { 'Content-Type': 'application/json',
        ...(login ? { 'X-OpenDoc-Login': '1' } : { 'X-OpenDoc-CSRF': session?.csrfToken ?? '' }),
        ...(revision ? { 'If-Match': `"${revision}"` } : {}) });
      const response = await fetcher(path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers, signal: controller.signal, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) throw new ApiError(response.status);
      if (response.status === 204) return null;
      return await response.json();
    } finally { clearTimeout(timer); requests.delete(controller); }
  }
  function fail(error, fallback) {
    if (error.status === 403) writeSuspended = true;
    if (error.status === 401) expired();
    else state.error = error.status === 403 ? 'You no longer have permission for this action. Your text is preserved. Check your session or contact your administrator.'
      : error.status === 413 ? 'This document is too large. Keep the body under 1 MiB.'
      : error.status === 429 ? 'The service is at capacity. Your text is preserved. Try again later.'
      : error.status === 404 ? 'This document is no longer available. Your current text is preserved.' : fallback;
  }
  async function allowLeave() {
    if (busy.has('save') || busy.has('logout') || busy.has('login') || busy.has('session')) return false;
    const own = ++guardSequence;
    if (dirty() && !await confirmDiscard('You have unconfirmed changes in this tab. Leave them behind and continue? Some live changes may already have reached the server. Download a copy first to keep your text.')) return false;
    return !stopped && own === guardSequence ? own : false;
  }
  async function refreshDocuments() {
    if (!session || stopped) return false;
    const ownEpoch = epoch, ownList = ++listing;
    busy.add('list'); state.listError = ''; emit();
    try {
      const result = await request('/api/v1/documents');
      if (ownEpoch !== epoch || ownList !== listing || stopped) return false;
      if (!Array.isArray(result?.documents) || !result.documents.every(doc => ID.test(doc.id) && typeof doc.title === 'string' && Number.isSafeInteger(doc.revision))) throw new Error('Invalid list');
      state.documents = result.documents.map(({ id, title, revision, updatedAt }) => ({ id, title, revision, updatedAt }));
      if (liveFactory) {
        try {
          const listingResult = await request('/api/v1/live-documents');
          if (ownEpoch !== epoch || ownList !== listing || stopped) return false;
          if (!Array.isArray(listingResult?.documents) || !listingResult.documents.every(doc => ID.test(doc.id) && typeof doc.title === 'string' && Number.isSafeInteger(doc.revision) && doc.authority === 'yjs')) throw new Error('Invalid live list');
          state.liveDocuments = listingResult.documents; state.liveListError = '';
        } catch (error) { if (ownEpoch === epoch && ownList === listing && !stopped) {
          if (error.status === 401) expired(); else state.liveListError = 'Live documents are unavailable. Your revision documents still work.';
        } }
      }
      return true;
    } catch (error) {
      if (ownEpoch === epoch && ownList === listing && !stopped) {
        if (error.status === 401) expired(); else state.listError = 'Documents could not be loaded. Try Refresh.';
      }
      return false;
    } finally { if (ownList === listing || !session) { busy.delete('list'); emit(); } }
  }
  async function checkSession() {
    if (busy.has('session') || busy.has('save') || busy.has('login') || busy.has('logout') || stopped) return false;
    closeLive();
    const own = ++epoch; navigation++; listing++; guardSequence++;
    state.loading = false; busy.delete('list');
    busy.add('session'); state.error = ''; emit();
    try {
      const result = await request('/auth/session');
      if (own !== epoch || stopped) return false;
      if (!result || !['owner', 'editor', 'viewer', 'commenter'].includes(result.role)
        || typeof result.principalId !== 'string' || typeof result.tenantId !== 'string' || typeof result.csrfToken !== 'string'
        || !Number.isFinite(result.expiresAt)) throw new Error('Invalid session');
      if (state.active && documentOwner && (documentOwner.principalId !== result.principalId || documentOwner.tenantId !== result.tenantId)) {
        expired(); state.error = 'The signed-in account changed. Download your current text, then reload this page to continue safely.'; return false;
      }
      const { principalId, tenantId, role, expiresAt, csrfToken } = result;
      session = { principalId, tenantId, role, expiresAt, csrfToken }; writeSuspended = false;
      state.identity = { principalId, tenantId, role, expiresAt }; state.phase = 'ready';
      clearTimeout(expiryTimer); expiryTimer = setTimeout(() => { expired(); emit(); }, Math.max(0, expiresAt - Date.now())); expiryTimer.unref?.();
      state.loading = false; await refreshDocuments(); return true;
    } catch (error) {
      if (own === epoch && !stopped) {
        if (error.status === 401 && !state.active) { session = null; state.identity = null; state.phase = 'signed-out'; state.documents = []; }
        else if (error.status === 401) expired();
        else { if (isLive()) writeSuspended = true; state.error = 'The session could not be checked. Try again.'; if (!session) state.phase = 'unavailable'; }
      }
      return false;
    } finally { busy.delete('session'); emit(); }
  }
  async function login() {
    const permit = await allowLeave();
    if (!permit || permit !== guardSequence || busy.has('login')) return false;
    let redirected = false;
    closeLive();
    busy.add('login'); state.error = ''; const own = ++epoch; navigation++; listing++; state.loading = false; busy.delete('list'); emit();
    try {
      const result = await request('/auth/login', { method: 'POST', body: {}, login: true });
      if (own !== epoch || stopped) return false;
      const target = new URL(result.authorizationUrl);
      const loopback = target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
      if (!(target.protocol === 'https:' || loopback) || target.username || target.password) throw new Error('Invalid login URL');
      navigate(target.href); redirected = true; return true;
    } catch { if (own === epoch && !stopped) state.error = 'Sign-in could not start. Try again.'; return false; }
    finally { if (!redirected) busy.delete('login'); emit(); }
  }
  async function logout() {
    if (!session) return false;
    const permit = await allowLeave();
    if (!permit || permit !== guardSequence || !session || busy.has('logout')) return false;
    closeLive();
    busy.add('logout'); state.error = ''; const own = ++epoch; navigation++; listing++; state.loading = false; emit();
    try {
      await request('/auth/logout', { method: 'POST', body: {} });
      if (own !== epoch || stopped) return false;
      closeLive(true); clearTimeout(expiryTimer);
      session = null; documentOwner = null; state.identity = null; state.active = null; state.baseline = null; state.documents = []; state.liveDocuments = []; state.conflict = null;
      state.phase = 'signed-out'; state.notice = 'Signed out of OpenDoc. Your identity provider may still be signed in.'; return true;
    } catch (error) {
      if (own === epoch && !stopped) fail(error, 'Sign-out could not be confirmed. Your text is preserved. Try checking your session.'); return false;
    } finally { busy.delete('logout'); busy.delete('list'); emit(); }
  }
  async function openDocument(id) {
    if (!session || !ID.test(id)) return false;
    const permit = await allowLeave();
    if (!permit || permit !== guardSequence || !session) return false;
    const own = ++navigation, ownEpoch = epoch;
    state.loading = true; state.error = ''; state.notice = ''; emit();
    try {
      const doc = await request(`/api/v1/documents/${encodeURIComponent(id)}`);
      if (own !== navigation || ownEpoch !== epoch || stopped) return false;
      if (!validDocument(doc) || doc.id !== id) throw new Error('Invalid document');
      closeLive(true);
      documentOwner = { principalId: session.principalId, tenantId: session.tenantId };
      state.active = copy(doc); state.baseline = copy(doc); state.conflict = null; return true;
    } catch (error) { if (own === navigation && ownEpoch === epoch && !stopped) fail(error, 'The document could not be opened. Try again.'); return false; }
    finally { if (own === navigation) { state.loading = false; emit(); } }
  }
  async function newDocument() {
    if (!canCreate()) return false;
    const permit = await allowLeave();
    if (!permit || permit !== guardSequence || !canCreate()) return false;
    closeLive(true);
    const id = newId(); if (!ID.test(id)) throw new Error('Invalid generated document ID');
    documentOwner = { principalId: session.principalId, tenantId: session.tenantId };
    navigation++; state.loading = false; state.active = { id, title: '', content: '', revision: null };
    state.baseline = null; state.conflict = null; state.error = ''; state.notice = 'New draft. Save to create this document.'; emit(); return true;
  }
  function edit(changes) {
    if (!writable() || !state.active || state.loading || busy.has('logout') || busy.has('login') || busy.has('session') || stopped) return false;
    if (isLive() && busy.has('save')) return false;
    guardSequence++;
    if (isLive() && live) return live.edit(changes);
    for (const key of ['title', 'content']) if (typeof changes[key] === 'string') state.active[key] = changes[key];
    state.notice = ''; emit(); return true;
  }
  async function loadConflict(ownEpoch = epoch, ownNavigation = navigation) {
    if (isLive() || !state.active || !session || busy.has('review')) return false;
    const id = state.active.id; busy.add('review'); emit();
    try {
      const remote = await request(`/api/v1/documents/${encodeURIComponent(id)}`);
      if (ownEpoch !== epoch || ownNavigation !== navigation || stopped) return false;
      if (!validDocument(remote) || remote.id !== id) throw new Error('Invalid document');
      state.conflict = { remote, message: 'Review the latest saved version below. Your text has not been changed.' }; return true;
    } catch (error) {
      if (ownEpoch === epoch && ownNavigation === navigation && !stopped) {
        if (error.status === 404 && !state.baseline) { state.conflict = null; state.error = 'The draft was not found on the server. You may try saving it again with the same ID.'; }
        else { if (error.status === 401) expired(); else state.conflict = { remote: null, message: 'The latest version could not be checked. Your text is preserved. Retry review before saving.' }; }
      }
      return false;
    } finally { busy.delete('review'); emit(); }
  }
  async function save() {
    if (isLive()) return state.active.revision == null ? createLive() : reconnectLive();
    if (!writable() || !state.active || !dirty() || state.loading || state.conflict || ['save', 'logout', 'login', 'session'].some(key => busy.has(key)) || stopped) return false;
    if (state.active.title.length > 200 || new TextEncoder().encode(state.active.content).length > MAX_BYTES) {
      state.error = 'Use a title of at most 200 characters and a body of at most 1 MiB.'; emit(); return false;
    }
    const ownEpoch = epoch, ownNavigation = navigation;
    const submitted = copy(state.active), creating = !state.baseline;
    const body = { title: submitted.title, content: submitted.content, ...(creating ? { id: submitted.id } : {}) };
    guardSequence++; busy.add('save'); state.error = ''; state.notice = ''; emit();
    try {
      const doc = await request(creating ? '/api/v1/documents' : `/api/v1/documents/${encodeURIComponent(submitted.id)}`,
        { method: creating ? 'POST' : 'PUT', body, revision: creating ? undefined : state.baseline.revision });
      if (ownEpoch !== epoch || ownNavigation !== navigation || stopped) return false;
      if (!validDocument(doc) || doc.id !== submitted.id || !sameText(doc, submitted)) throw new Error('Invalid saved document');
      state.baseline = copy(doc); state.active.revision = doc.revision;
      state.notice = dirty() ? 'Saved. Your newer edits are still unsaved.' : 'All changes saved.';
      void refreshDocuments(); return true;
    } catch (error) {
      if (ownEpoch !== epoch || ownNavigation !== navigation || stopped) return false;
      if ([409, 412].includes(error.status) || !error.status || error.status >= 500) {
        state.conflict = { remote: null, message: error.status === 412 || error.status === 409
          ? 'Another version is already saved. Your text is preserved.'
          : 'The save result is uncertain. Your text is preserved. Check the saved version before trying again.' };
        await loadConflict(ownEpoch, ownNavigation);
      } else fail(error, 'The document could not be saved. Your text is preserved.');
      return false;
    } finally { busy.delete('save'); emit(); }
  }
  function keepDraft() {
    if (isLive() || !writable() || !state.conflict?.remote || busy.has('save') || busy.has('review')) return false;
    state.baseline = copy(state.conflict.remote); state.active.revision = state.baseline.revision;
    state.conflict = null; state.error = ''; state.notice = 'Your text is now based on the reviewed revision. Merge any changes you want to keep, then Save.'; emit(); return true;
  }
  async function useSavedVersion() {
    if (isLive() || !state.conflict?.remote || busy.has('save') || busy.has('review')) return false;
    const permit = await allowLeave();
    if (!permit || permit !== guardSequence) return false;
    const remote = state.conflict?.remote; if (!remote) return false;
    state.active = copy(remote); state.baseline = copy(remote); state.conflict = null; state.error = ''; state.notice = 'Loaded the saved version.'; emit(); return true;
  }
  async function newLiveDocument() {
    if (!liveFactory || !await newDocument()) return false;
    state.active.authority = 'yjs'; state.notice = 'New live draft. Create it to begin sharing changes. Revision documents remain separate.'; emit(); return true;
  }
  function makeLive() {
    let candidate;
    candidate = liveFactory({ onChange(value) {
      if (live !== candidate || stopped) return;
      state.live = value;
      if (value.initialized) { state.active.title = value.title; state.active.content = value.content; state.active.revision = value.revision;
        if (!value.pending) state.liveDocuments = state.liveDocuments.map(doc => doc.id === state.active.id ? { ...doc, title: value.title, revision: value.revision } : doc);
      }
      emit();
    }, onError(error) { if (live === candidate && !stopped) { state.error = error.message; emit(); } } });
    return candidate;
  }
  async function connectLive(candidate, id) {
    const own = navigation, ownEpoch = epoch;
    const ticket = await request('/auth/collaboration-ticket', { method: 'POST', body: { documentId: id } });
    if (stopped || own !== navigation || ownEpoch !== epoch) return false;
    const path = `/api/v1/live-documents/${id}/collaboration`;
    if (ticket?.path !== path || typeof ticket.ticket !== 'string') throw new Error('Invalid live ticket');
    const target = new URL(path, origin); target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    return candidate.reconnect({ url: target.href, token: ticket.ticket });
  }
  async function openLiveDocument(id) {
    if (!liveFactory || !session || !ID.test(id)) return false;
    const permit = await allowLeave(); if (!permit || permit !== guardSequence || !session) return false;
    const own = ++navigation, ownEpoch = epoch;
    state.loading = true; state.error = ''; state.notice = ''; emit();
    let candidate;
    try {
      const metadata = await request(`/api/v1/live-documents/${id}`);
      if (own !== navigation || ownEpoch !== epoch || stopped) return false;
      if (!validDocument(metadata) || metadata.id !== id || metadata.authority !== 'yjs') throw new Error('Invalid live document');
      candidate = makeLive();
      if (!await connectLive(candidate, id)) throw new Error('Live connection failed');
      if (own !== navigation || ownEpoch !== epoch || stopped) return false;
      closeLive(true); live = candidate; candidate = null;
      documentOwner = { principalId: session.principalId, tenantId: session.tenantId };
      state.live = live.getState();
      state.active = { id, authority: 'yjs', title: state.live.title, content: state.live.content, revision: state.live.revision };
      state.baseline = copy(state.active); state.conflict = null;
      state.notice = 'Live changes are sent as you type. Persisted appears only after the server confirms them.';
      return true;
    } catch (error) { if (own === navigation && ownEpoch === epoch && !stopped) fail(error, 'The live document could not be opened. Your previous text is preserved.'); return false; }
    finally { candidate?.destroy(); if (own === navigation) { state.loading = false; emit(); } }
  }
  async function createLive() {
    if (!liveFactory || !writable() || !state.active || !isLive() || state.active.revision != null || state.conflict || state.loading || busy.has('save') || stopped) return false;
    const submitted = copy(state.active);
    if (submitted.title.length > 200 || new TextEncoder().encode(submitted.content).length > 256 * 1024) {
      state.error = 'Use a title of at most 200 characters and live content below 256 KiB.'; emit(); return false;
    }
    const own = ++navigation, ownEpoch = epoch; guardSequence++; busy.add('save'); state.error = ''; emit();
    try {
      const result = await request('/api/v1/live-documents', { method: 'POST', body: { id: submitted.id, title: submitted.title, content: submitted.content } });
      if (own !== navigation || ownEpoch !== epoch || stopped) return false;
      if (!validDocument(result) || result.id !== submitted.id || result.authority !== 'yjs' || !sameText(result, submitted)) throw new Error('Uncertain creation');
      state.active.revision = result.revision; state.baseline = copy(state.active);
      state.notice = 'Live document created. Choose Connect to start live editing.';
      void refreshDocuments(); return true;
    } catch (error) {
      if (own === navigation && ownEpoch === epoch && !stopped) {
        if (!error.status || [409, 412].includes(error.status) || error.status >= 500) {
          state.conflict = { remote: null, message: 'Live creation could not be confirmed. Download your draft before opening this ID from the live list. This draft will not be resubmitted automatically.' };
          state.error = 'Creation result uncertain. Your draft is preserved. Refresh the library to check it.';
        } else fail(error, 'The live document could not be created. Your draft is preserved.');
      } return false;
    } finally { busy.delete('save'); emit(); }
  }
  async function reconnectLive() {
    if (!isLive() || !state.active.revision || busy.has('connect') || busy.has('save') || stopped) return false;
    if (live?.getState().status === 'connected') { state.notice = state.live.pending ? 'Waiting for server persistence confirmation.' : 'All live changes are persisted.'; emit(); return !state.live.pending; }
    busy.add('connect'); state.error = ''; emit();
    let reconnectEpoch, reconnectNavigation, candidate;
    try {
      if (!await checkSession() || !session || !WRITERS.has(session.role) && state.live?.pending) return false;
      const own = navigation, ownEpoch = epoch, id = state.active.id;
      reconnectEpoch = ownEpoch; reconnectNavigation = own;
      if (!live) {
        // Freshly created live documents have no editable offline buffer yet.
        // Open through authoritative Yjs state, never seed from the REST projection.
        return await openLiveDocument(id);
      }
      candidate = live;
      const connected = await connectLive(candidate, id);
      if (own !== navigation || ownEpoch !== epoch || stopped) { candidate.disconnect(); return false; }
      if (!connected) state.error = 'Reconnect failed. Retained changes are still here; download a copy before leaving.';
      return connected;
    } catch (error) {
      if (stopped || reconnectEpoch !== epoch || reconnectNavigation !== navigation) return false;
      candidate?.disconnect(); writeSuspended = true; fail(error, 'Reconnect could not be authorized. Your text is preserved. Check your session.'); return false; }
    finally { busy.delete('connect'); emit(); }
  }
  return { getState: snapshot, checkSession, login, logout, refreshDocuments, openDocument, newDocument, openLiveDocument, newLiveDocument, reconnectLive, edit, save,
    beginComposition: field => live?.beginComposition(field), endComposition: value => live?.endComposition(value),
    reviewConflict: () => loadConflict(), keepDraft, useSavedVersion,
    destroy() { stopped = true; closeLive(true); clearTimeout(expiryTimer); epoch++; navigation++; listing++; guardSequence++; session = null; for (const controller of requests) controller.abort(); requests.clear(); } };
}
