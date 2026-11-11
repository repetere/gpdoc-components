import { createOpenDocHandler } from './api.mjs';
import { MemoryDocumentStore } from './memory-store.mjs';
import { createDevelopmentAuthenticator, startLocalServer } from './node-adapter.mjs';

const portText = process.env.PORT ?? '8787';
if (!/^\d+$/.test(portText)) throw new TypeError('PORT must be an integer');
const development = createDevelopmentAuthenticator();
const handle = createOpenDocHandler({ store: new MemoryDocumentStore(), authenticate: development.authenticate });
const server = await startLocalServer({ handle, port: Number(portText) });
console.log(`OpenDoc local reference: ${server.url}`);
console.log('Development only. Documents and token disappear when this process exits. No enterprise login.');
console.log(`Set TOKEN in a second terminal to this temporary local bearer token: ${development.token}`);
console.log(`Try: curl -H "Authorization: Bearer $TOKEN" ${server.url}/api/v1/session`);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (closing) return;
  closing = true;
  await server.close();
  process.exitCode = 0;
});
