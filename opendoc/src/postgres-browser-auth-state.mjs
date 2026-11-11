// Original OpenDoc bounded shared browser-auth state adapter. MIT.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { AUTH_STATE_KINDS, BrowserAuthStateError, applyAuthState, authStatePolicy, emptyAuthState } from './browser-auth-state.mjs';

export const BROWSER_AUTH_SCHEMA_VERSION = 1;
const fail = () => { throw new BrowserAuthStateError(); };
function sanitized(error) {
  return new BrowserAuthStateError(error instanceof BrowserAuthStateError && ['UNAUTHENTICATED', 'CAPACITY_EXCEEDED'].includes(error.code) ? error.code : 'DEPENDENCY_UNAVAILABLE');
}
function schemaIdentifier(schema) {
  if (typeof schema !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(schema) || /^(?:pg_|public$|information_schema$)/.test(schema)) throw new TypeError('Explicit dedicated non-system PostgreSQL auth schema required');
  return `"${schema}"`;
}
const same = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array && a.byteLength === b.byteLength && timingSafeEqual(a, b);
function integer(value, max = Number.MAX_SAFE_INTEGER) {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) fail();
  return n;
}

/**
 * Caller owns pool, TLS, access controls and pool connection/query timeouts.
 * All operations lock the same namespace row and commit once, with no retry.
 * Provider/membership awaits occur outside this adapter's transactions.
 * The global lock and bounded full read are deliberate evaluation tradeoffs.
 */
export class PostgresBrowserAuthState {
  kind = 'postgresql-browser-auth';
  #pool; #schema; #namespace; #encryptionKey; #indexKey; #policy; #queryTimeoutMs;
  constructor({ pool, schema, encryptionKey, queryTimeoutMs = 2000 } = {}) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('A pg Pool-compatible adapter required');
    this.#schema = schemaIdentifier(schema); this.#namespace = schema; this.#pool = pool;
    if (!(encryptionKey instanceof Uint8Array) || encryptionKey.byteLength !== 32) throw new TypeError('Operator-owned 32-byte encryptionKey required');
    if (!Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 1 || queryTimeoutMs > 10000) throw new TypeError('Invalid auth query timeout');
    this.#queryTimeoutMs = queryTimeoutMs;
    // Domain-separated keys; neither the root key nor bearer tokens are stored.
    this.#encryptionKey = Buffer.from(hkdfSync('sha256', encryptionKey, schema, 'OpenDoc browser-auth encryption v1', 32));
    this.#indexKey = Buffer.from(hkdfSync('sha256', encryptionKey, schema, 'OpenDoc browser-auth indexes v1', 32));
  }
  configure(options) {
    const policy = authStatePolicy(options);
    if (this.#policy && JSON.stringify(this.#policy) !== JSON.stringify(policy)) throw new TypeError('Auth state configuration mismatch');
    this.#policy = policy;
  }
  #index(kind, id) { return createHmac('sha256', this.#indexKey).update(JSON.stringify([kind, id])).digest(); }
  #check() { return this.#index('key-check', this.#policy.binding); }
  #aad(kind, key) { return Buffer.from(JSON.stringify([BROWSER_AUTH_SCHEMA_VERSION, this.#namespace, this.#policy.binding, kind, key.toString('hex')])); }
  #encrypt(kind, key, value) {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#encryptionKey, nonce);
    cipher.setAAD(this.#aad(kind, key));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const payload = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    if (payload.length > 16384) fail();
    return payload;
  }
  #decrypt(kind, key, payload) {
    if (!Buffer.isBuffer(payload) || payload.length < 29 || payload.length > 16384) fail();
    const decipher = createDecipheriv('aes-256-gcm', this.#encryptionKey, payload.subarray(0, 12));
    decipher.setAAD(this.#aad(kind, key)); decipher.setAuthTag(payload.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8'));
  }
  async #connection(work, guard = () => {}) {
    let client, begun = false, discard = false;
    try {
      guard();
      client = await this.#pool.connect();
      guard();
      if (!client || typeof client.query !== 'function' || typeof client.release !== 'function') fail();
      begun = true;
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)", [String(this.#queryTimeoutMs)]);
      guard();
      const result = await work(client);
      guard();
      // A rejected COMMIT is uncertain. Never retry or return credentials/identity.
      try { await client.query('COMMIT'); } catch (error) { discard = true; throw error; }
      begun = false;
      guard();
      return result;
    } catch (error) {
      if (begun && client) { try { await client.query('ROLLBACK'); } catch { discard = true; } }
      throw sanitized(error);
    } finally {
      if (typeof client?.release === 'function') {
        try { client.release(discard); } catch { throw new BrowserAuthStateError(); }
      }
    }
  }
  /** ADMIN ONLY: fresh dedicated namespace; never called by run()/login. */
  async initialize({ maxBytes = 8 * 1024 * 1024 } = {}) {
    if (!this.#policy) throw new TypeError('Configure this state through createBrowserOidc before bootstrap');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new TypeError('Invalid durable auth byte quota');
    let migration;
    try { migration = (await readFile(new URL('../migrations/004_browser_auth_state.sql', import.meta.url), 'utf8')).replaceAll('__SCHEMA__', this.#schema); } catch { fail(); }
    return this.#connection(async client => {
      await client.query(migration);
      await client.query(`INSERT INTO ${this.#schema}.browser_auth_state (schema_version, policy, key_check, max_bytes) VALUES ($1, $2, $3, $4)`,
        [BROWSER_AUTH_SCHEMA_VERSION, this.#policy, this.#check(), maxBytes]);
      return { schemaVersion: BROWSER_AUTH_SCHEMA_VERSION };
    });
  }
  async run(operation, input = {}, guard = () => {}) {
    if (!this.#policy) fail();
    let responseDeadline = Infinity, clockSample;
    const outcome = await this.#connection(async client => {
      const locked = await client.query(`SELECT schema_version, policy, key_check, max_bytes FROM ${this.#schema}.browser_auth_state WHERE singleton = true FOR UPDATE`);
      if (locked.rows.length !== 1) fail();
      const metadata = locked.rows[0];
      // JSONB object key order is not preserved. Compare the exact expected fields.
      if (metadata.schema_version !== BROWSER_AUTH_SCHEMA_VERSION || !same(metadata.key_check, this.#check()) ||
        !metadata.policy || metadata.policy.binding !== this.#policy.binding ||
        Object.keys(metadata.policy).length !== 2 || !metadata.policy.limits ||
        Object.keys(metadata.policy.limits).length !== Object.keys(this.#policy.limits).length ||
        Object.entries(this.#policy.limits).some(([key, value]) => metadata.policy.limits[key] !== value)) fail();
      const maxBytes = integer(metadata.max_bytes, 16 * 1024 * 1024);
      const limits = this.#policy.limits;
      const maxRows = limits.maxSessions + limits.maxTransactions + limits.maxTickets;
      const stored = await client.query(`SELECT kind, record_key, payload, expires_at FROM ${this.#schema}.browser_auth_records LIMIT $1`, [maxRows + 1]);
      if (stored.rows.length > maxRows) fail();
      const state = emptyAuthState(), before = new Map(); let bytes = 0;
      for (const row of stored.rows) {
        const { kind, record_key: key, payload } = row;
        if (!AUTH_STATE_KINDS.includes(kind) || !Buffer.isBuffer(key) || key.length !== 32) fail();
        bytes += payload.length;
        if (bytes > maxBytes) fail();
        const { id, record } = this.#decrypt(kind, key, payload);
        if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(id) || !same(this.#index(kind, id), key) ||
          !record || record.expiresAt !== integer(row.expires_at) || state[kind].has(id)) fail();
        state[kind].set(id, record);
        before.set(`${kind}:${id}`, { key, payload, encoded: JSON.stringify(record) });
      }
      if (state.sessions.size > limits.maxSessions || state.transactions.size + state.intents.size > limits.maxTransactions || state.tickets.size > limits.maxTickets) fail();
      // Obtain clock AFTER waiting for the lock and reading a fresh snapshot.
      const clock = await client.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now');
      guard();
      // Rotation/publication delete their prerequisites. Preserve the source
      // deadlines so expiry during SQL writes cannot turn into a fresh grant.
      const prerequisite = operation === 'finishCallback' ? state.transactions.get(input.id)
        : operation === 'publishLogin' ? state.intents.get(input.intentId) : null;
      const prerequisiteDeadline = prerequisite ? Math.min(prerequisite.expiresAt,
        prerequisite.priorSessionId ? state.sessions.get(prerequisite.priorSessionId)?.expiresAt ?? 0 : Infinity) : Infinity;
      const result = applyAuthState(state, operation, input, { now: integer(clock.rows[0]?.now), limits });
      const writes = []; let nextBytes = 0;
      for (const kind of AUTH_STATE_KINDS) for (const [id, record] of state[kind]) {
        const old = before.get(`${kind}:${id}`), encoded = JSON.stringify(record);
        before.delete(`${kind}:${id}`);
        if (old?.encoded === encoded) nextBytes += old.payload.length;
        else {
          const key = this.#index(kind, id), payload = this.#encrypt(kind, key, { id, record });
          nextBytes += payload.length; writes.push({ kind, key, payload, expiresAt: record.expiresAt });
        }
      }
      if (nextBytes > maxBytes) throw new BrowserAuthStateError('CAPACITY_EXCEEDED');
      for (const kind of AUTH_STATE_KINDS) {
        guard();
        const deletes = [...before].filter(([composite]) => composite.startsWith(`${kind}:`)).map(([, old]) => old.key);
        if (deletes.length) await client.query(`DELETE FROM ${this.#schema}.browser_auth_records WHERE kind = $1 AND record_key = ANY($2::bytea[])`, [kind, deletes]);
        const changed = writes.filter(row => row.kind === kind);
        guard();
        if (changed.length) await client.query(`INSERT INTO ${this.#schema}.browser_auth_records (kind, record_key, payload, expires_at)
          SELECT $1, unnest($2::bytea[]), unnest($3::bytea[]), unnest($4::bigint[])
          ON CONFLICT (kind, record_key) DO UPDATE SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at`,
          [kind, changed.map(row => row.key), changed.map(row => row.payload), changed.map(row => row.expiresAt)]);
      }
      // A slow write must not return an already-expired grant. COMMIT itself
      // can still have an uncertain outcome; callers must never retry it.
      const clockStarted = performance.now();
      const finalClock = await client.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now');
      const finalNow = integer(finalClock.rows[0]?.now);
      if (prerequisiteDeadline <= finalNow) throw new BrowserAuthStateError('UNAUTHENTICATED');
      const relevant = [];
      if (['beginLogin', 'checkIntent'].includes(operation) && result) relevant.push(state.intents.get(input.intentId));
      if (operation === 'publishLogin') relevant.push(state.transactions.get(input.transactionId));
      if (['consumeTransaction', 'checkTransaction'].includes(operation) && result) relevant.push(state.transactions.get(input.id));
      if (['getSession', 'checkSession'].includes(operation) && result) relevant.push(state.sessions.get(input.id));
      if (operation === 'finishCallback') relevant.push(state.sessions.get(input.sessionId));
      if (['issueTicket', 'bindTicket', 'checkTicket'].includes(operation) && result) {
        const ticket = state.tickets.get(input.ticketId); relevant.push(ticket, state.sessions.get(ticket?.sessionId));
      }
      responseDeadline = prerequisiteDeadline;
      clockSample = { now: finalNow, started: clockStarted };
      for (const record of relevant) {
        responseDeadline = Math.min(responseDeadline, record?.expiresAt ?? 0, record?.priorSessionId ? state.sessions.get(record.priorSessionId)?.expiresAt ?? 0 : Infinity);
        if (!record || record.expiresAt <= finalNow || record.priorSessionId && state.sessions.get(record.priorSessionId)?.expiresAt <= finalNow) throw new BrowserAuthStateError('UNAUTHENTICATED');
      }
      guard();
      return result;
    }, guard);
    // COMMIT acknowledgement can itself be delayed. Use a conservative elapsed
    // monotonic duration against the database clock sample, not app wall time.
    // A committed-but-unreturned bearer remains unreachable and expires normally.
    if (clockSample && clockSample.now + Math.ceil(performance.now() - clockSample.started) >= responseDeadline) throw new BrowserAuthStateError('UNAUTHENTICATED');
    return outcome;
  }
}
