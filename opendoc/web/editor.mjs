import { createEditorController } from './controller.mjs';
const $ = id => document.getElementById(id);
let current;
let listSignature = '';
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
  $('new-document').disabled = !state.writable || waiting || writing;
  $('welcome-new').disabled = !state.writable || waiting || writing;
  $('document-list').setAttribute('aria-busy', String(state.busy.includes('list')));
  const signature = JSON.stringify([state.documents, state.active?.id, waiting, writing]);
  if (signature !== listSignature) {
    listSignature = signature;
    $('document-list').replaceChildren(...state.documents.map(doc => {
      const li = document.createElement('li'), button = document.createElement('button');
      button.className = 'document-link'; button.disabled = waiting || writing;
      button.setAttribute('aria-current', String(doc.id === state.active?.id));
      const name = document.createElement('span'), detail = document.createElement('span');
      name.className = 'doc-name'; name.textContent = doc.title || 'Untitled document';
      detail.className = 'doc-detail'; detail.textContent = `Revision ${doc.revision}`;
      button.append(name, detail); button.addEventListener('click', async () => { if (await controller.openDocument(doc.id)) $('document-title').focus(); }); li.append(button); return li;
    }));
  }
  text('list-error', state.listError); show('list-empty', state.documents.length === 0);
  text('list-empty', state.busy.includes('list') ? 'Loading documents…' : signedIn ? 'No documents here yet.' : 'Sign in to see your documents.');
  for (const id of ['error', 'notice']) { text(id, state[id]); show(id, Boolean(state[id])); }
  show('welcome', !state.active); show('document-panel', Boolean(state.active));
  show('welcome-sign-in', !signedIn); show('welcome-new', signedIn && state.writable);
  text('welcome-copy', signedIn ? state.writable ? 'Choose a document from the library, or start a fresh page. Your next idea begins here.' : 'Choose a document from the library. Your role has read-only access to this editor.' : 'Sign in to your workspace to write, revise, and keep your documents in one place.');
  if (!state.active) return;
  const readOnly = !state.writable || waiting || state.loading;
  value('document-title', state.active.title); value('document-content', state.active.content);
  $('document-title').readOnly = readOnly; $('document-content').readOnly = readOnly;
  $('document-panel').setAttribute('aria-busy', String(state.loading));
  show('read-only', !state.writable);
  text('save-state', state.loading ? 'Opening document…' : writing ? 'Saving…' : state.conflict ? 'Review needed' : state.dirty ? 'Unsaved changes' : 'All changes saved');
  text('revision', state.active.revision ? `Revision ${state.active.revision}` : 'New draft');
  $('save').disabled = !state.writable || !state.dirty || writing || waiting || state.loading || Boolean(state.conflict);
  text('save', writing ? 'Saving…' : state.baseline ? 'Save changes' : 'Create document');
  const words = state.active.content.trim().split(/\s+/u).filter(Boolean).length;
  text('word-count', `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`);
  show('conflict', Boolean(state.conflict));
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
  confirmDiscard: message => window.confirm(message), navigate: url => window.location.assign(url) });
for (const id of ['sign-in', 'welcome-sign-in']) $(id).addEventListener('click', () => controller.login());
for (const id of ['new-document', 'welcome-new']) $(id).addEventListener('click', async () => { if (await controller.newDocument()) $('document-title').focus(); });
$('sign-out').addEventListener('click', () => controller.logout());
$('check-session').addEventListener('click', () => controller.checkSession());
$('refresh').addEventListener('click', () => controller.refreshDocuments());
$('save').addEventListener('click', () => controller.save());
$('document-title').addEventListener('input', event => controller.edit({ title: event.target.value }));
$('document-content').addEventListener('input', event => controller.edit({ content: event.target.value }));
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
