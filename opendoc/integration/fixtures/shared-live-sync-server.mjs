// Real child-process WebSocket server for synthetic PostgreSQL integration only.
// IPC fault injection is test-only and is never exposed over the network.
import { Pool } from 'pg';
import { PostgresAccountStore } from '../../src/account-store.mjs';
import { PostgresLiveDocumentStore } from '../../src/live-document-store.mjs';
import { StoreError } from '../../src/memory-store.mjs';
import { startLocalCollaborationServer } from '../../src/collaboration-server.mjs';
import { testDatabaseConfig, verifyTestDatabase, TEST_ISSUER, TEST_ORIGIN } from './shared-live-sync-common.mjs';
if (process.env.OPENDOC_PG_INTEGRATION !== '1' || !process.send) throw new Error('Explicit synthetic integration child required');
const [schema, accountSchema] = process.argv.slice(2);
if (!/^opendoc_shared_live_test_[a-f0-9]{24}$/.test(schema) || !/^opendoc_shared_acct_test_[a-f0-9]{24}$/.test(accountSchema)) throw new Error('Invalid integration schema');
const pool = new Pool(testDatabaseConfig(process.env.DATABASE_URL));
const identity = await verifyTestDatabase(pool, process.env.OPENDOC_PG_EXPECTED_SERVER_ADDRESS);
const accounts = new PostgresAccountStore({ pool, schema: accountSchema });
let loseCommit = false, holdNextCommit = false, failPolls = false, snapshotOverride = null, holdPolls = false, holdChangedOnly = false;
let held = [], heldCommits = [], pollCalls = 0, inFlightPolls = 0, maximumInFlightPolls = 0, lostCommits = 0;
const observedPool = { async connect() {
  const client = await pool.connect(); let mutation = false;
  return { async query(sql, args) {
    if (/^UPDATE .*live_documents\b/.test(sql.trim())) mutation = true;
    const result = await client.query(sql, args);
    if (sql === 'COMMIT' && mutation && holdNextCommit) { holdNextCommit = false; await new Promise(resolve => heldCommits.push(resolve)); }
    if (sql === 'COMMIT' && mutation && loseCommit) { loseCommit = false; lostCommits++; throw new Error('Synthetic lost COMMIT response'); }
    return result;
  }, release(discard) { client.release(discard); } };
} };
const store = new PostgresLiveDocumentStore({ pool: observedPool, schema });
const originalGetIfChanged = store.getIfChanged?.bind(store);
if (!originalGetIfChanged) throw new Error('Shared live synchronization store API is not installed');
store.getIfChanged = async (...args) => {
  pollCalls++; inFlightPolls++; maximumInFlightPolls = Math.max(maximumInFlightPolls, inFlightPolls);
  try {
    if (failPolls) throw new StoreError('DEPENDENCY_UNAVAILABLE');
    const result = snapshotOverride ?? await originalGetIfChanged(...args);
    if (holdPolls && (!holdChangedOnly || result !== null)) await new Promise(resolve => held.push(resolve));
    return result;
  } finally { inFlightPolls--; }
};
const options = JSON.parse(process.env.OPENDOC_CHILD_OPTIONS || '{}');
const server = await startLocalCollaborationServer({ liveStore: store, allowedOrigins: [TEST_ORIGIN],
  sharedLiveSync: { intervalMs: 50 }, limits: { operationTimeoutMs: 1500, ...options.limits },
  authenticate: async request => {
    const token = request.headers.get('authorization')?.slice(7);
    const match = /^(edit-a|edit-b|view|comment|other)$/.exec(token ?? '');
    if (!match) return null;
    return accounts.resolveMembership({ issuer: TEST_ISSUER, subject: token, activeTenantId: token === 'other' ? 'tenant-b' : 'tenant-a' });
  }
});
let closing = false;
async function close() {
  if (closing) return; closing = true;
  holdPolls = false; for (const release of held.splice(0)) release();
  holdNextCommit = false; for (const release of heldCommits.splice(0)) release();
  await server.close(); await pool.end();
}
process.on('message', async message => {
  try {
    let value = null;
    if (message.command === 'stats') value = { ...server.stats(), pollCalls, inFlightPolls, maximumInFlightPolls, heldPolls: held.length, heldCommits: heldCommits.length, lostCommits };
    else if (message.command === 'fail-polls') failPolls = Boolean(message.value);
    else if (message.command === 'hold-polls') { holdPolls = Boolean(message.value); holdChangedOnly = false; }
    else if (message.command === 'hold-changed-polls') { holdPolls = true; holdChangedOnly = true; }
    else if (message.command === 'release-polls') { holdPolls = false; for (const release of held.splice(0)) release(); }
    else if (message.command === 'snapshot') snapshotOverride = message.value === null ? null : { ...message.value, state: Uint8Array.from(message.value.state) };
    else if (message.command === 'lose-commit') loseCommit = true;
    else if (message.command === 'hold-commit') holdNextCommit = true;
    else if (message.command === 'release-commits') { holdNextCommit = false; for (const release of heldCommits.splice(0)) release(); }
    else if (message.command === 'close') await close();
    else throw new Error('Unknown fixture command');
    process.send({ id: message.id, value }, () => { if (closing) process.disconnect(); });
  } catch (error) { process.send({ id: message.id, error: error.message }); }
});
process.on('disconnect', () => { close().finally(() => process.exit(0)); });
process.send({ ready: true, url: server.url, pid: process.pid, backendPid: identity.pid });
