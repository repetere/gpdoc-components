// MANUAL BROWSER QA ONLY. Run: OPENDOC_SYNTHETIC_LOGIN=1 node test/fixtures/browser-login-demo.mjs
// Two loopback listeners, ephemeral synthetic OIDC keys/accounts, memory documents.
// No real provider, production secrets, database, cloud resource, or external URL.
import { pathToFileURL } from 'node:url';
import { createBrowserOidc } from '../../src/browser-oidc.mjs';
import { MemoryDocumentStore } from '../../src/memory-store.mjs';
import { startLoopbackApp, startSyntheticProvider } from './oidc-provider.mjs';

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OpenDoc synthetic browser login QA</title><style>
body{font:16px/1.5 system-ui;max-width:850px;margin:50px auto;padding:0 24px;color:#183b32;background:#f6f8f5}h1{line-height:1.2}p{max-width:70ch}button{font:inherit;padding:10px 15px;margin:5px;border:1px solid #326452;border-radius:7px;background:white;cursor:pointer}button:hover{background:#e3efe6}.notice{padding:15px;background:#fff2ca;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:20px;background:white;border:1px solid #cbd7ce;border-radius:8px}small{display:block;margin-top:25px}
</style></head><body><h1>OpenDoc browser login QA</h1><p class="notice"><strong>Development fixture. Synthetic local accounts only.</strong><br>This test page and identity provider bind to 127.0.0.1. Never enter real credentials. State disappears on restart. Never proxy this fixture publicly.</p><p>Use Sign in, choose a synthetic identity at the local provider, approve access, then create a synthetic document. Viewer/commenter accounts can read but cannot write. The unmapped identity must be denied.</p><nav><button id="signin">Sign in</button><button id="refresh">Refresh session</button><button id="create">Create synthetic document</button><button id="logout">Sign out</button></nav><h2>Session</h2><pre id="session" aria-live="polite">Checking…</pre><h2>Result</h2><pre id="result" aria-live="polite">Ready.</pre><small>No provider tokens are sent to this page. The local session and CSRF cookies are HttpOnly. Development HTTP cookies omit Secure; production requires HTTPS and Secure cookies. This fixture does not prove a production deployment is secure.</small><script>
let current = null;
const result = document.getElementById('result');
function show(value) { result.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
async function request(path, body, login = false) {
  const response = await fetch(path, { credentials: 'same-origin', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', ...(login ? { 'X-OpenDoc-Login': '1' } : current ? { 'X-OpenDoc-CSRF': current.csrfToken } : {}) }, body: JSON.stringify(body) }) });
  const text = await response.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}
async function refresh() {
  const response = await request('/auth/session'); current = response.status === 200 ? response.data : null;
  document.getElementById('session').textContent = current ? JSON.stringify({ principalId: current.principalId, tenantId: current.tenantId, role: current.role, expiresAt: new Date(current.expiresAt).toISOString() }, null, 2) : 'Signed out (HTTP ' + response.status + ').';
}
async function run(action) { try { await action(); } catch { show('Request failed. Check the local fixture process.'); } }
document.getElementById('signin').onclick = () => run(async () => { const response = await request('/auth/login', {}, true); if (response.status === 200) location.assign(response.data.authorizationUrl); else show(response); });
document.getElementById('refresh').onclick = () => run(refresh);
document.getElementById('create').onclick = () => run(async () => { if (!current) { show('Sign in before creating a document.'); return; } const id = 'browser-qa-' + Date.now(); show(await request('/api/v1/documents', { id, title: 'Synthetic browser QA', content: '# Synthetic text only' })); });
document.getElementById('logout').onclick = () => run(async () => { if (!current) { show('Already signed out.'); return; } show(await request('/auth/logout', {})); await refresh(); });
run(refresh);
</script></body></html>`;

export async function startSyntheticBrowserDemo() {
  if (process.env.OPENDOC_SYNTHETIC_LOGIN !== '1') throw new Error('Explicit OPENDOC_SYNTHETIC_LOGIN=1 is required for this synthetic-only fixture. Never proxy it publicly.');
  const app = await startLoopbackApp();
  const provider = await startSyntheticProvider({ redirectUri: `${app.origin}/auth/callback` });
  const memberships = new Map([
    ['synthetic-editor', { principalId: 'mapped-editor', tenantId: 'synthetic-team', role: 'editor' }],
    ['synthetic-viewer', { principalId: 'mapped-viewer', tenantId: 'synthetic-team', role: 'viewer' }],
    ['synthetic-commenter', { principalId: 'mapped-commenter', tenantId: 'synthetic-team', role: 'commenter' }]
  ]);
  const auth = createBrowserOidc({ ...provider, redirectUri: `${app.origin}/auth/callback`, activeTenantId: 'synthetic-team', allowInsecureLoopback: true,
    resolveMembership: async ({ issuer, subject, activeTenantId }) => issuer === provider.issuer && activeTenantId === 'synthetic-team' ? memberships.get(subject) ?? null : null });
  const handle = auth.createHandler({ store: new MemoryDocumentStore() });
  app.setHandler(request => new URL(request.url).pathname === '/' && request.method === 'GET'
    ? new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' } }) : handle(request));
  return { origin: app.origin, issuer: provider.issuer, auth,
    async close() { auth.close(); await Promise.all([app.close(), provider.close()]); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const demo = await startSyntheticBrowserDemo();
  process.stdout.write(`Synthetic browser QA page: ${demo.origin}\nSynthetic OIDC issuer: ${demo.issuer}\nLoopback only. No real credentials. Never proxy publicly. Ctrl+C to stop.\n`);
  const stop = async () => { await demo.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
