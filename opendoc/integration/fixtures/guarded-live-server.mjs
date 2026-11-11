// Synthetic loopback integration server. All fault controls are private IPC only.
import { Pool } from 'pg';
import { PostgresAccountStore } from '../../src/account-store.mjs';
import { PostgresLiveDocumentStore } from '../../src/live-document-store.mjs';
import { MemoryDocumentStore } from '../../src/memory-store.mjs';
import { createOpenDocHandler } from '../../src/api.mjs';
import { startLocalServer } from '../../src/node-adapter.mjs';
import { startLocalCollaborationServer } from '../../src/collaboration-server.mjs';
import { testDatabaseConfig, verifyTestDatabase, TEST_ISSUER, TEST_ORIGIN } from './shared-live-sync-common.mjs';

if (process.env.OPENDOC_PG_INTEGRATION !== '1' || !process.send) throw new Error('Explicit synthetic integration child required');
const [schema, accountSchema] = process.argv.slice(2);
if (!/^opendoc_guard_live_test_[a-f0-9]{24}$/.test(schema) || !/^opendoc_guard_acct_test_[a-f0-9]{24}$/.test(accountSchema)) throw new Error('Invalid integration schema');
const options = JSON.parse(process.env.OPENDOC_CHILD_OPTIONS || '{}');
const pool = new Pool(testDatabaseConfig(process.env.DATABASE_URL));
const identity = await verifyTestDatabase(pool, process.env.OPENDOC_PG_EXPECTED_SERVER_ADDRESS);
const accounts = new PostgresAccountStore({ pool, schema: accountSchema });
let loseCommit = false, holdCommitReply = false, holdChangedPoll = false, closing = false;
let heldCommits = [], heldPolls = [], lostCommits = 0, authenticated = 0, actors = [];
const observedPool = { async connect() {
  const client = await pool.connect(); let mutation = false;
  return { async query(sql, values) {
    if (/^(?:UPDATE|INSERT INTO) .*\.live_documents\b/.test(sql.trim())) mutation = true;
    const result = await client.query(sql, values);
    if (sql === 'COMMIT' && mutation && holdCommitReply) {
      holdCommitReply = false; await new Promise(resolve => heldCommits.push(resolve));
    }
    if (sql === 'COMMIT' && mutation && loseCommit) {
      loseCommit = false; lostCommits++; throw new Error('Synthetic lost COMMIT response');
    }
    return result;
  }, release(discard) { client.release(discard); } };
} };
const store = new PostgresLiveDocumentStore({ pool: observedPool, schema, accountSchema, ...options.store });
for (const method of ['create', 'applyUpdate']) {
  const original = store[method].bind(store);
  store[method] = (...args) => {
    const actor = args.at(-1);
    actors.push({ method, actor, keys: Reflect.ownKeys(actor ?? {}).map(String), frozen: Object.isFrozen(actor) });
    return original(...args);
  };
}
const originalPoll = store.getIfChanged.bind(store);
store.getIfChanged = async (...args) => {
  const result = await originalPoll(...args);
  if (holdChangedPoll && result !== null) await new Promise(resolve => heldPolls.push(resolve));
  return result;
};
const authenticate = async request => {
  const token = request.headers.get('authorization')?.slice(7);
  if (!/^(?:edit-a|edit-b|view)$/.test(token ?? '')) return null;
  const result = await accounts.resolveMembership({ issuer: TEST_ISSUER, subject: token, activeTenantId: 'tenant-a' });
  authenticated++;
  return result ? { ...result, token: 'synthetic-secret-not-an-actor', extraClaim: true } : null;
};
const http = await startLocalServer({ port: 0, handle: createOpenDocHandler({ store: new MemoryDocumentStore(), liveStore: store, authenticate, allowedOrigins: [TEST_ORIGIN] }) });
const socket = await startLocalCollaborationServer({ liveStore: store, authenticate, allowedOrigins: [TEST_ORIGIN],
  sharedLiveSync: { intervalMs: 50 }, limits: { operationTimeoutMs: 1800, ...options.limits } });
async function close() {
  if (closing) return; closing = true;
  holdCommitReply = false; holdChangedPoll = false;
  for (const release of [...heldCommits.splice(0), ...heldPolls.splice(0)]) release();
  await Promise.all([http.close(), socket.close()]); await pool.end();
}
process.on('message', async message => {
  try {
    let value = null;
    switch (message.command) {
      case 'stats': value = { ...socket.stats(), authenticated, actors, lostCommits, heldCommits: heldCommits.length, heldPolls: heldPolls.length }; break;
      case 'lose-commit': loseCommit = true; break;
      case 'hold-commit-reply': holdCommitReply = true; break;
      case 'release-commits': holdCommitReply = false; for (const release of heldCommits.splice(0)) release(); break;
      case 'hold-changed-polls': holdChangedPoll = true; break;
      case 'release-polls': holdChangedPoll = false; for (const release of heldPolls.splice(0)) release(); break;
      case 'get': {
        const result = await store.get('tenant-a', message.value ?? 'live');
        value = result ? { ...result, state: Array.from(result.state) } : null; break;
      }
      case 'poll': {
        const result = await store.getIfChanged('tenant-a', 'live', message.value);
        value = result ? { ...result, state: Array.from(result.state) } : null; break;
      }
      case 'close': await close(); break;
      default: throw new Error('Unknown fixture command');
    }
    process.send({ id: message.id, value }, () => { if (closing) process.disconnect(); });
  } catch (error) { process.send({ id: message.id, error: error.code ?? error.message }); }
});
process.on('disconnect', () => { close().finally(() => process.exit(0)); });
process.send({ ready: true, url: socket.url, httpUrl: http.url, pid: process.pid, backendPid: identity.pid });
