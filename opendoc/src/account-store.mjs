// Original OpenDoc implementation. MIT, see ../../LICENSE.
// Durable identity mapping, not an identity provider or public administration API.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { StoreError } from './memory-store.mjs';

export const ACCOUNT_SCHEMA_VERSION = 1;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}(?![\s\S])/;
const TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}(?![\s\S])/;
const ROLES = new Set(['owner', 'editor', 'viewer', 'commenter']);
const SAFE_CODES = new Set(['BAD_REQUEST', 'FORBIDDEN', 'CONFLICT', 'NOT_FOUND', 'CAPACITY_EXCEEDED', 'DEPENDENCY_UNAVAILABLE']);
function fail(code) { throw new StoreError(code); }
function sanitized(error) {
  return new StoreError(error instanceof StoreError && SAFE_CODES.has(error.code) ? error.code : 'DEPENDENCY_UNAVAILABLE');
}
function schemaIdentifier(schema) {
  if (typeof schema !== 'string' || !/^[a-z][a-z0-9_]{0,62}(?![\s\S])/.test(schema) || /^(?:pg_|public$|information_schema$)/.test(schema)) {
    throw new TypeError('An explicit non-system PostgreSQL account schema name is required');
  }
  return `"${schema}"`;
}
function requirePool(pool) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('A pg Pool-compatible adapter is required');
}
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!(typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value))) fail('DEPENDENCY_UNAVAILABLE');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) fail('DEPENDENCY_UNAVAILABLE');
  return n;
}
function input(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) fail('BAD_REQUEST');
  const copy = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('BAD_REQUEST');
    copy[key] = descriptor.value;
  }
  return copy;
}
function principal(value) { if (typeof value !== 'string' || !ID.test(value)) fail('BAD_REQUEST'); }
function tenant(value) { if (typeof value !== 'string' || !TENANT_ID.test(value)) fail('BAD_REQUEST'); }
function role(value) { if (!ROLES.has(value)) fail('BAD_REQUEST'); }
function boundedString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim().length > 0 &&
    value.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(value);
}
function identity(issuer, subject) {
  if (!boundedString(issuer, 2048) || !boundedString(subject, 512)) fail('BAD_REQUEST');
  // Binary storage avoids locale/collation folding. Fixed-width generated hash
  // keys avoid PostgreSQL's btree tuple-size limit for long UTF-8 identifiers.
  // Every read also checks the original bytes: a hash collision cannot link or
  // authenticate as another identity. Such an administrative insert conflicts.
  const issuerBytes = Buffer.from(issuer, 'utf8'), subjectBytes = Buffer.from(subject, 'utf8');
  return { issuerBytes, subjectBytes, issuerHash: createHash('sha256').update(issuerBytes).digest(),
    subjectHash: createHash('sha256').update(subjectBytes).digest() };
}
function sameBytes(actual, expected) { return actual instanceof Uint8Array && Buffer.from(actual).equals(expected); }
function rowCount(rows) { if (!Array.isArray(rows) || rows.length > 1) fail('DEPENDENCY_UNAVAILABLE'); }

async function accountState(client, sqlSchema, write = false) {
  const { rows } = await client.query(`SELECT schema_version, max_principals, max_identity_bindings,
    max_memberships, max_memberships_per_tenant, max_bytes, principal_count, identity_binding_count,
    membership_count, byte_count FROM ${sqlSchema}.account_state WHERE singleton = true${write ? ' FOR UPDATE' : ' FOR SHARE'}`);
  if (rows.length !== 1 || integer(rows[0].schema_version, 1) !== ACCOUNT_SCHEMA_VERSION) fail('DEPENDENCY_UNAVAILABLE');
  const r = rows[0], state = {
    maxPrincipals: integer(r.max_principals, 1, 1000000), maxIdentityBindings: integer(r.max_identity_bindings, 1, 1000000),
    maxMemberships: integer(r.max_memberships, 1, 1000000), maxMembershipsPerTenant: integer(r.max_memberships_per_tenant, 1, 10000),
    maxBytes: integer(r.max_bytes, 1), principals: integer(r.principal_count), bindings: integer(r.identity_binding_count),
    memberships: integer(r.membership_count), bytes: integer(r.byte_count)
  };
  if (state.principals > state.maxPrincipals || state.bindings > state.maxIdentityBindings ||
      state.memberships > state.maxMemberships || state.bytes > state.maxBytes) fail('DEPENDENCY_UNAVAILABLE');
  return state;
}

/** Internal live-store integration, not credential verification or a transaction.
 * The caller MUST supply its own READ COMMITTED transaction client and retain
 * the account lock through its mutation's commit/rollback. Acquire this lock
 * before any live-document lock. No pool, callbacks, retries or fallback exist.
 */
export function createPostgresAccountWriteGuard({ schema } = {}) {
  const sqlSchema = schemaIdentifier(schema);
  function snapshot(tenantId, actor) {
    try {
      if (!actor || Object.getPrototypeOf(actor) !== Object.prototype || Reflect.ownKeys(actor).length !== 2) fail('FORBIDDEN');
      const principalField = Object.getOwnPropertyDescriptor(actor, 'principalId');
      const tenantField = Object.getOwnPropertyDescriptor(actor, 'tenantId');
      if (!principalField || !tenantField || !Object.hasOwn(principalField, 'value') || !Object.hasOwn(tenantField, 'value') ||
          typeof principalField.value !== 'string' || !ID.test(principalField.value) ||
          typeof tenantField.value !== 'string' || !TENANT_ID.test(tenantField.value) || tenantField.value !== tenantId) fail('FORBIDDEN');
      return Object.freeze({ principalId: principalField.value, tenantId: tenantField.value });
    } catch { fail('FORBIDDEN'); }
  }
  return Object.freeze({
    snapshot,
    async authorize(client, actor) {
      try {
        // Recheck the snapshot shape without evaluating caller accessors.
        const tenantField = actor && Object.getOwnPropertyDescriptor(actor, 'tenantId');
        const trusted = snapshot(tenantField?.value, actor);
        await accountState(client, sqlSchema);
        // A separate statement gets a fresh snapshot AFTER any pending account
        // administrator holding the exclusive state-row lock has settled.
        const { rows } = await client.query(`SELECT p.principal_id, m.tenant_id, m.role FROM ${sqlSchema}.principals p
          JOIN ${sqlSchema}.memberships m ON m.principal_id = p.principal_id AND m.tenant_id = $1
          WHERE p.principal_id = $2 AND p.active = true`, [trusted.tenantId, trusted.principalId]);
        rowCount(rows);
        if (!rows.length) fail('FORBIDDEN');
        const r = rows[0];
        if (r.principal_id !== trusted.principalId || r.tenant_id !== trusted.tenantId || !ROLES.has(r.role)) fail('DEPENDENCY_UNAVAILABLE');
        if (r.role !== 'owner' && r.role !== 'editor') fail('FORBIDDEN');
      } catch (error) { throw sanitized(error); }
    }
  });
}

async function connection(pool, work) {
  let client, inTransaction = false, discard = false;
  try {
    client = await pool.connect();
    if (!client || typeof client.query !== 'function' || typeof client.release !== 'function') fail('DEPENDENCY_UNAVAILABLE');
    // BEGIN may have reached PostgreSQL before the local caller times out.
    inTransaction = true;
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const result = await work(client);
    await client.query('COMMIT');
    inTransaction = false;
    return result;
  } catch (error) {
    if (inTransaction) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
    }
    // No retries, including when COMMIT may have succeeded. An administrator
    // must inspect current state before deciding whether to issue a new change.
    throw sanitized(error);
  } finally {
    if (typeof client?.release === 'function') {
      try { client.release(discard); } catch (error) { throw sanitized(error); }
    }
  }
}

/** Explicit administrative bootstrap of a fresh, dedicated namespace only. */
export async function initializePostgresAccountSchema({ pool, schema, maxPrincipals = 10000, maxIdentityBindings = 20000,
  maxMemberships = 50000, maxMembershipsPerTenant = 10000, maxBytes = 16 * 1024 * 1024 } = {}) {
  requirePool(pool);
  const sqlSchema = schemaIdentifier(schema);
  if (![maxPrincipals, maxIdentityBindings, maxMemberships].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 1000000) ||
      !Number.isSafeInteger(maxMembershipsPerTenant) || maxMembershipsPerTenant < 1 || maxMembershipsPerTenant > 10000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Invalid PostgreSQL account capacity limits');
  let migration;
  try { migration = (await readFile(new URL('../migrations/003_account_store.sql', import.meta.url), 'utf8')).replaceAll('__SCHEMA__', sqlSchema); }
  catch (error) { throw sanitized(error); }
  return connection(pool, async client => {
    await client.query(migration);
    await client.query(`INSERT INTO ${sqlSchema}.account_state
      (singleton, schema_version, max_principals, max_identity_bindings, max_memberships, max_memberships_per_tenant, max_bytes)
      VALUES (true, $1, $2, $3, $4, $5, $6)`,
    [ACCOUNT_SCHEMA_VERSION, maxPrincipals, maxIdentityBindings, maxMemberships, maxMembershipsPerTenant, maxBytes]);
    return { schemaVersion: ACCOUNT_SCHEMA_VERSION };
  });
}

/**
 * Caller-owned pg Pool. Constructor is inert. Only resolveMembership belongs in
 * the authentication path; ALL other methods require host-admin authorization.
 * All writes serialize on a quota row. Reads hold its shared lock and use a new
 * READ COMMITTED statement snapshot after that lock is acquired. An unsettled
 * writer cannot be bypassed by an authentication lookup on another connection.
 */
export class PostgresAccountStore {
  kind = 'postgresql-accounts';
  #pool;
  #schema;
  constructor({ pool, schema } = {}) {
    requirePool(pool);
    this.#pool = pool;
    this.#schema = schemaIdentifier(schema);
  }
  async #state(client, write = false) {
    return accountState(client, this.#schema, write);
  }
  #reserve(state, kind, limit, deltaBytes) {
    if ((kind && state[kind] >= state[limit]) || deltaBytes > state.maxBytes - state.bytes) fail('CAPACITY_EXCEEDED');
    if (state.bytes + deltaBytes < 0) fail('DEPENDENCY_UNAVAILABLE');
    if (kind) state[kind]++;
    state.bytes += deltaBytes;
  }
  async #saveState(client, state) {
    await client.query(`UPDATE ${this.#schema}.account_state SET principal_count = $1, identity_binding_count = $2,
      membership_count = $3, byte_count = $4 WHERE singleton = true`, [state.principals, state.bindings, state.memberships, state.bytes]);
  }
  async #principal(client, principalId) {
    const { rows } = await client.query(`SELECT active FROM ${this.#schema}.principals WHERE principal_id = $1`, [principalId]);
    rowCount(rows);
    if (rows.length && typeof rows[0].active !== 'boolean') fail('DEPENDENCY_UNAVAILABLE');
    return rows[0] ?? null;
  }
  async #link(client, state, principalId, external) {
    const { issuerBytes, subjectBytes, issuerHash, subjectHash } = external;
    const { rows } = await client.query(`SELECT issuer, subject, principal_id FROM ${this.#schema}.identity_bindings
      WHERE issuer_hash = $1 AND subject_hash = $2`, [issuerHash, subjectHash]);
    rowCount(rows);
    if (rows.length) {
      if (rows[0].principal_id !== principalId || !sameBytes(rows[0].issuer, issuerBytes) || !sameBytes(rows[0].subject, subjectBytes)) fail('CONFLICT');
      return;
    }
    this.#reserve(state, 'bindings', 'maxIdentityBindings', issuerBytes.length + subjectBytes.length + principalId.length);
    await client.query(`INSERT INTO ${this.#schema}.identity_bindings (issuer, subject, principal_id) VALUES ($1, $2, $3)`,
      [issuerBytes, subjectBytes, principalId]);
  }
  async #membership(client, state, principalId, tenantId, nextRole, allowChange) {
    const { rows } = await client.query(`SELECT role FROM ${this.#schema}.memberships WHERE tenant_id = $1 AND principal_id = $2`, [tenantId, principalId]);
    rowCount(rows);
    if (rows.length) {
      if (!ROLES.has(rows[0].role)) fail('DEPENDENCY_UNAVAILABLE');
      if (rows[0].role === nextRole) return;
      if (!allowChange) fail('CONFLICT');
      this.#reserve(state, null, null, nextRole.length - rows[0].role.length);
      await client.query(`UPDATE ${this.#schema}.memberships SET role = $3 WHERE tenant_id = $1 AND principal_id = $2`, [tenantId, principalId, nextRole]);
      return;
    }
    const count = await client.query(`SELECT count(*) AS count FROM ${this.#schema}.memberships WHERE tenant_id = $1`, [tenantId]);
    if (integer(count.rows[0]?.count) >= state.maxMembershipsPerTenant) fail('CAPACITY_EXCEEDED');
    this.#reserve(state, 'memberships', 'maxMemberships', tenantId.length + principalId.length + nextRole.length);
    await client.query(`INSERT INTO ${this.#schema}.memberships (tenant_id, principal_id, role) VALUES ($1, $2, $3)`, [tenantId, principalId, nextRole]);
  }
  async resolveMembership(value) {
    const { issuer, subject, activeTenantId } = input(value, ['issuer', 'subject', 'activeTenantId']);
    tenant(activeTenantId);
    const external = identity(issuer, subject);
    return connection(this.#pool, async client => {
      await this.#state(client);
      const { rows } = await client.query(`SELECT p.principal_id, m.tenant_id, m.role FROM ${this.#schema}.identity_bindings b
        JOIN ${this.#schema}.principals p ON p.principal_id = b.principal_id
        JOIN ${this.#schema}.memberships m ON m.principal_id = p.principal_id AND m.tenant_id = $1
        WHERE b.issuer_hash = $2 AND b.subject_hash = $3 AND b.issuer = $4 AND b.subject = $5 AND p.active = true`,
      [activeTenantId, external.issuerHash, external.subjectHash, external.issuerBytes, external.subjectBytes]);
      rowCount(rows);
      if (!rows.length) return null;
      const r = rows[0];
      if (typeof r.principal_id !== 'string' || !ID.test(r.principal_id) || r.tenant_id !== activeTenantId || !ROLES.has(r.role)) fail('DEPENDENCY_UNAVAILABLE');
      return { principalId: r.principal_id, tenantId: activeTenantId, role: r.role };
    });
  }
  /** ADMIN ONLY. Atomic create/link/grant; conflicting bindings or roles reject. */
  async provisionAccount(value) {
    const { issuer, subject, principalId, tenantId, role: nextRole } = input(value, ['issuer', 'subject', 'principalId', 'tenantId', 'role']);
    principal(principalId); tenant(tenantId); role(nextRole);
    const external = identity(issuer, subject);
    return connection(this.#pool, async client => {
      const state = await this.#state(client, true);
      const existing = await this.#principal(client, principalId);
      if (existing && !existing.active) fail('CONFLICT');
      if (!existing) {
        this.#reserve(state, 'principals', 'maxPrincipals', principalId.length);
        await client.query(`INSERT INTO ${this.#schema}.principals (principal_id, active) VALUES ($1, true)`, [principalId]);
      }
      await this.#link(client, state, principalId, external);
      await this.#membership(client, state, principalId, tenantId, nextRole, false);
      await this.#saveState(client, state);
      return { principalId, tenantId, role: nextRole };
    });
  }
  /** ADMIN ONLY. Link another provider identity to an existing active principal. */
  async linkIdentity(value) {
    const { issuer, subject, principalId } = input(value, ['issuer', 'subject', 'principalId']);
    principal(principalId);
    const external = identity(issuer, subject);
    return connection(this.#pool, async client => {
      const state = await this.#state(client, true);
      const existing = await this.#principal(client, principalId);
      if (!existing) fail('NOT_FOUND');
      if (!existing.active) fail('CONFLICT');
      await this.#link(client, state, principalId, external);
      await this.#saveState(client, state);
      return { principalId };
    });
  }
  /** ADMIN ONLY. Explicitly grant or change one active principal's tenant role. */
  async setMembership(value) {
    const { principalId, tenantId, role: nextRole } = input(value, ['principalId', 'tenantId', 'role']);
    principal(principalId); tenant(tenantId); role(nextRole);
    return connection(this.#pool, async client => {
      const state = await this.#state(client, true);
      const existing = await this.#principal(client, principalId);
      if (!existing) fail('NOT_FOUND');
      if (!existing.active) fail('CONFLICT');
      await this.#membership(client, state, principalId, tenantId, nextRole, true);
      await this.#saveState(client, state);
      return { principalId, tenantId, role: nextRole };
    });
  }
  /** ADMIN ONLY. Missing membership is an idempotent false, without enrollment. */
  async revokeMembership(value) {
    const { principalId, tenantId } = input(value, ['principalId', 'tenantId']);
    principal(principalId); tenant(tenantId);
    return connection(this.#pool, async client => {
      const state = await this.#state(client, true);
      const { rows } = await client.query(`DELETE FROM ${this.#schema}.memberships WHERE tenant_id = $1 AND principal_id = $2 RETURNING role`, [tenantId, principalId]);
      rowCount(rows);
      if (!rows.length) return false;
      if (!ROLES.has(rows[0].role) || state.memberships < 1) fail('DEPENDENCY_UNAVAILABLE');
      state.memberships--;
      this.#reserve(state, null, null, -(tenantId.length + principalId.length + rows[0].role.length));
      await this.#saveState(client, state);
      return true;
    });
  }
  /** ADMIN ONLY. Deactivation denies every identity and tenant of the principal. */
  async setPrincipalActive(value) {
    const { principalId, active } = input(value, ['principalId', 'active']);
    principal(principalId);
    if (typeof active !== 'boolean') fail('BAD_REQUEST');
    return connection(this.#pool, async client => {
      await this.#state(client, true);
      if (!await this.#principal(client, principalId)) fail('NOT_FOUND');
      await client.query(`UPDATE ${this.#schema}.principals SET active = $2 WHERE principal_id = $1`, [principalId, active]);
      return { principalId, active };
    });
  }
}
