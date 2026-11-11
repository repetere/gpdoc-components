import { createEditorController } from './controller.mjs';
import { createLiveDocument } from './live-document.mjs';
const $ = id => document.getElementById(id);
let current;
let listSignature = '';
let composing = null;
function text(id, value) { const node = $(id); if (node.textContent !== value) node.textContent = value; }
function show(id, visible) { $(id).hidden = !visible; }
function value(id, next) { if ($(id).value !== next) $(id).value = next; }
function render(state) {
  current = state;
  const signedIn = state.phase === 'ready';
  const waiting = state.busy.some(key => ['session', 'login', 'logout'].includes(key));
  const writing = state.busy.includes('save');
  text('identity', state.identity ? `${state.identity.principalId} · ${state.identity.role}` : state.phase === 'checking' ? 'Checking session…' : state.phase === 'expired' ? 'Session ended' : 'Not signed in');
  text('workspace-label', state.identity ? `WORKSPACE · ${state.identity.tenantId}` : 'Your writing, together in one place.');
  show('sign-in', !signedIn); show('sign-out', signedIn);
  for (const id of ['sign-in', 'welcome-sign-in', 'sign-out', 'check-session']) $(id).disabled = waiting || writing;
  text('sign-in', state.busy.includes('login') ? 'Opening sign-in…' : 'Sign in');
  $('refresh').disabled = !signedIn || state.busy.includes('list') || waiting;
  $('new-document').disabled = !state.canCreate || waiting || writing;
  $('welcome-new').disabled = !state.canCreate || waiting || writing;
  $('document-list').setAttribute('aria-busy', String(state.busy.includes('list')));
  const documents = [...state.liveDocuments, ...state.documents];
  const signature = JSON.stringify([documents, state.active?.id, state.active?.authority, waiting, writing]);
  if (signature !== listSignature) {
    listSignature = signature;
    $('document-list').replaceChildren(...documents.map(doc => {
      const li = document.createElement('li'), button = document.createElement('button');
      button.className = 'document-link'; button.disabled = waiting || writing;
      button.setAttribute('aria-current', String(doc.id === state.active?.id && doc.authority === state.active?.authority));
      const name = document.createElement('span'), detail = document.createElement('span');
      name.className = 'doc-name'; name.textContent = doc.title || 'Untitled document';
      detail.className = 'doc-detail'; detail.textContent = `${doc.authority === 'yjs' ? 'Live' : 'Revision'} · ${doc.revision}`;
      button.append(name, detail); button.addEventListener('click', async () => { if (await (doc.authority === 'yjs' ? controller.openLiveDocument(doc.id) : controller.openDocument(doc.id))) $('document-title').focus(); }); li.append(button); return li;
    }));
  }
  text('list-error', [state.listError, state.liveListError].filter(Boolean).join(' ')); show('list-empty', documents.length === 0);
  $('new-live-document').disabled = !state.canCreate || waiting || writing;
  text('list-empty', state.busy.includes('list') ? 'Loading documents…' : signedIn ? 'No documents here yet.' : 'Sign in to see your documents.');
  for (const id of ['error', 'notice']) { text(id, state[id]); show(id, Boolean(state[id])); }
  show('welcome', !state.active); show('document-panel', Boolean(state.active));
  show('welcome-sign-in', !signedIn); show('welcome-new', signedIn && state.writable);
  text('welcome-copy', signedIn ? state.writable ? 'Choose a document from the library, or start a fresh page. Your next idea begins here.' : 'Choose a document from the library. Your role has read-only access to this editor.' : 'Sign in to your workspace to write, revise, and keep your documents in one place.');
  if (!state.active) return;
  const live = state.active.authority === 'yjs';
  $('document-content').maxLength = live ? 262144 : 1048576;
  const readOnly = !state.writable || waiting || state.loading || live && writing;
  if (composing !== 'title') value('document-title', state.active.title);
  if (composing !== 'content') value('document-content', state.active.content);
  if (!composing && state.live?.selection && document.activeElement === $(`document-${state.live.selection.field}`)) {
    const selected = state.live.selection; $(`document-${selected.field}`).setSelectionRange(selected.start, selected.end);
  }
  $('document-title').readOnly = readOnly; $('document-content').readOnly = readOnly;
  $('document-panel').setAttribute('aria-busy', String(state.loading));
  show('read-only', !state.writable);
  text('read-only', live && state.active.revision && !state.live && signedIn ? 'Connect to start live editing. Your document has been created.' : 'Editing is unavailable for this session. You can read and download your text, but cannot send changes.');
  text('save-state', live ? state.loading ? 'Opening live document…' : writing ? 'Creating live document…' : state.live?.status === 'connecting' ? 'Connecting…' : state.live?.status === 'connected' ? state.dirty ? 'Pending server confirmation' : 'Persisted on server' : state.live ? state.dirty ? 'Disconnected · changes in this tab only' : 'Disconnected · last changes persisted' : state.active.revision ? 'Created · connect to edit' : 'New live draft' : state.loading ? 'Opening document…' : writing ? 'Saving…' : state.conflict ? 'Review needed' : state.dirty ? 'Unsaved changes' : 'All changes saved');
  text('revision', state.active.revision ? `${live ? 'Live revision' : 'Revision'} ${state.active.revision}` : 'New draft');
  show('live-help', live);
  text('live-help', 'Live changes are sent while connected. Pending changes exist only in this tab until confirmed by the server. Download before closing or signing in again.');
  $('save').disabled = live && state.active.revision ? waiting || writing || state.loading || state.busy.includes('connect') || state.live?.status === 'connected' : !state.writable || !state.dirty || writing || waiting || state.loading || Boolean(state.conflict);
  text('save', live ? writing ? 'Creating…' : state.active.revision ? state.live ? 'Reconnect' : 'Connect' : 'Create live document' : writing ? 'Saving…' : state.baseline ? 'Save changes' : 'Create document');
  const words = state.active.content.trim().split(/\s+/u).filter(Boolean).length;
  text('word-count', `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`);
  show('conflict', Boolean(state.conflict));
  show('conflict-actions', !live);
  show('conflict-help', !live);
  if (state.conflict) {
    text('conflict-message', state.conflict.message);
    const remote = state.conflict.remote;
    show('remote-version', Boolean(remote));
    if (remote) { value('remote-title', remote.title); value('remote-content', remote.content); text('remote-revision', `Latest saved revision: ${remote.revision}`); }
    $('keep-draft').disabled = !remote || !state.writable || writing || state.busy.includes('review');
    $('use-remote').disabled = !remote || writing || state.busy.includes('review');
    $('review-conflict').disabled = state.busy.includes('review') || writing || !signedIn;
  }
}
const controller = createEditorController({ onChange: render,
  liveFactory: options => createLiveDocument({ ...options, getSelection: () => {
    const active = document.activeElement;
    if (active === $('document-title') || active === $('document-content')) return { field: active.id.slice(9), start: active.selectionStart, end: active.selectionEnd };
    return null;
  } }),
  confirmDiscard: message => window.confirm(message), navigate: url => window.location.assign(url) });
for (const id of ['sign-in', 'welcome-sign-in']) $(id).addEventListener('click', () => controller.login());
for (const id of ['new-document', 'welcome-new']) $(id).addEventListener('click', async () => { if (await controller.newDocument()) $('document-title').focus(); });
$('new-live-document').addEventListener('click', async () => { if (await controller.newLiveDocument()) $('document-title').focus(); });
$('sign-out').addEventListener('click', () => controller.logout());
$('check-session').addEventListener('click', () => controller.checkSession());
$('refresh').addEventListener('click', () => controller.refreshDocuments());
$('save').addEventListener('click', () => controller.save());
for (const field of ['title', 'content']) {
  const element = $(`document-${field}`);
  element.addEventListener('input', event => { if (composing !== field) { controller.edit({ [field]: event.target.value }); render(controller.getState()); } });
  element.addEventListener('compositionstart', () => { if (current.active?.authority === 'yjs' && controller.beginComposition(field)) composing = field; });
  element.addEventListener('compositionend', () => { if (composing === field) { const value = element.value; composing = null; controller.endComposition(value); render(controller.getState()); } });
}
$('review-conflict').addEventListener('click', () => controller.reviewConflict());
$('keep-draft').addEventListener('click', () => controller.keepDraft());
$('use-remote').addEventListener('click', () => controller.useSavedVersion());
$('download').addEventListener('click', () => {
  if (!current.active) return;
  const url = URL.createObjectURL(new Blob([current.active.content], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url;
  link.download = `${(current.active.title || current.active.id).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 80) || 'document'}.md`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('beforeunload', event => { if (current?.dirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void controller.save(); }
});
render(controller.getState());
void controller.checkSession();
