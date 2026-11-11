// Explicit opt-in local synthetic QA only. Never publish or proxy either listener.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createBrowserOidc } from '../../src/browser-oidc.mjs';
import { MemoryDocumentStore } from '../../src/memory-store.mjs';
import { createWebClientHandler, createWebClientNodeListener } from '../../src/web-client.mjs';
import { startSyntheticProvider } from './oidc-provider.mjs';

export async function startSyntheticEditorDemo() {
  if (process.env.OPENDOC_SYNTHETIC_EDITOR !== '1') throw new Error('Explicit OPENDOC_SYNTHETIC_EDITOR=1 is required. Synthetic local accounts only. Never proxy publicly.');
  let listener = (_request, response) => { response.writeHead(503); response.end(); };
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30000, headersTimeout: 10000 }, (request, response) => listener(request, response));
  server.setTimeout(30000, socket => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const provider = await startSyntheticProvider({ redirectUri: `${origin}/auth/callback` });
  const memberships = new Map(['editor', 'viewer', 'commenter'].map(role => [`synthetic-${role}`, { principalId: `mapped-${role}`, tenantId: 'synthetic-team', role }]));
  const store = new MemoryDocumentStore();
  store.create('synthetic-team', { id: 'welcome', title: 'A place for your next idea', content: '# Welcome to OpenDoc\n\nThis is a synthetic local workspace. No real accounts or credentials.\n\nWrite in plain text or Markdown, then choose Save changes. Every successful save creates a new revision.\n\n## Try a revision conflict\n\nOpen this document in two tabs. Save one tab, then save different changes in the other. Both versions stay available for review.\n\nThis editor uses REST saves. Experimental Yjs collaboration is separate.' });
  store.create('synthetic-team', { id: 'field-notes', title: 'Field notes', content: '# Field notes\n\nA small space for a useful observation.\n\n- What did you notice?\n- What changed your mind?\n- What comes next?\n' });
  const auth = createBrowserOidc({ ...provider, redirectUri: `${origin}/auth/callback`, activeTenantId: 'synthetic-team', allowInsecureLoopback: true,
    resolveMembership: async ({ issuer, subject, activeTenantId }) => issuer === provider.issuer && activeTenantId === 'synthetic-team' ? memberships.get(subject) ?? null : null });
  const handle = await createWebClientHandler({ handle: auth.createHandler({ store }), canonicalOrigin: origin, allowInsecureLoopback: true });
  listener = createWebClientNodeListener({ handle, canonicalOrigin: origin, allowInsecureLoopback: true });
  return { origin, issuer: provider.issuer, auth, store, memberships, provider,
    async close() { await auth.close(); await Promise.all([provider.close(), new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); })]); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const demo = await startSyntheticEditorDemo();
  process.stdout.write(`Synthetic OpenDoc editor: ${demo.origin}\nSynthetic OIDC issuer: ${demo.issuer}\nAccounts: synthetic-editor, synthetic-viewer, synthetic-commenter, synthetic-unmapped (denied).\nDocuments: welcome, field-notes. Open welcome in two tabs for revision conflicts.\nLoopback only. No real credentials. Never proxy publicly. Ctrl+C to stop.\n`);
  const stop = async () => { await demo.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
