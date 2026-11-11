// Original OpenDoc implementation. MIT, see ../../LICENSE.
// pg is injected: this module never chooses a connection or migrates on startup.
import { readFile } from 'node:fs/promises';
import { StoreError } from './memory-store.mjs';

export const POSTGRES_SCHEMA_VERSION = 1;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SAFE_CODES = new Set(['BAD_REQUEST', 'TOO_LARGE', 'CONFLICT', 'NOT_FOUND', 'PRECONDITION_FAILED', 'CAPACITY_EXCEEDED', 'DEPENDENCY_UNAVAILABLE']);
const COLUMNS = 'id, title_json, content_json, revision, created_at, updated_at';

function fail(code) { throw new StoreError(code); }
function sanitized(error) {
  // Never retain a driver message, query, URL, parameters, stack cause or detail.
  return new StoreError(error instanceof StoreError && SAFE_CODES.has(error.code) ? error.code : 'DEPENDENCY_UNAVAILABLE');
}
function schemaIdentifier(schema) {
  if (typeof schema !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(schema) || /^(?:pg_|public$|information_schema$)/.test(schema)) {
    throw new TypeError('An explicit non-system PostgreSQL schema name is required');
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
function scope(tenantId, ...ids) {
  if (typeof tenantId !== 'string' || !TENANT_ID.test(tenantId) || ids.some(id => typeof id !== 'string' || !ID.test(id))) fail('BAD_REQUEST');
}
function documentInput(input, creating) {
  const keys = creating ? ['id', 'title', 'content'] : ['title', 'content'];
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).length !== keys.length || !keys.every(k => Object.hasOwn(input, k))) fail('BAD_REQUEST');
  if (creating && (typeof input.id !== 'string' || !ID.test(input.id))) fail('BAD_REQUEST');
  if (typeof input.title !== 'string' || input.title.length > 200 || typeof input.content !== 'string') fail('BAD_REQUEST');
  if (Buffer.byteLength(input.content, 'utf8') > 1024 * 1024) fail('TOO_LARGE');
}
function stringBytes(value) { return Buffer.from(JSON.stringify(value), 'utf8'); }
function decodeString(value) {
  if (!(value instanceof Uint8Array)) fail('DEPENDENCY_UNAVAILABLE');
  const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value));
  if (typeof result !== 'string') fail('DEPENDENCY_UNAVAILABLE');
  return result;
}
function document(row, withContent = true) {
  if (typeof row.id !== 'string' || !ID.test(row.id)) fail('DEPENDENCY_UNAVAILABLE');
  const result = {
    id: row.id, title: decodeString(row.title_json), revision: integer(row.revision, 1),
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString()
  };
  if (withContent) result.content = decodeString(row.content_json);
  return result;
}

async function connection(pool, transactional, work) {
  let client;
  let inTransaction = false;
  let discard = false;
  try {
    client = await pool.connect();
    if (!client || typeof client.query !== 'function' || typeof client.release !== 'function') fail('DEPENDENCY_UNAVAILABLE');
    if (transactional) {
      // A client-side timeout can reject after the server accepted BEGIN.
      // Arm cleanup before sending it, not only after receiving success.
      inTransaction = true;
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    }
    const result = await work(client);
    if (transactional) {
      await client.query('COMMIT');
      inTransaction = false;
    }
    return result;
  } catch (error) {
    if (inTransaction) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
    }
    throw sanitized(error);
  } finally {
    // A failed rollback must not return a transaction-bearing client to the pool.
    if (typeof client?.release === 'function') {
      try { client.release(discard); } catch (error) { throw sanitized(error); }
    }
  }
}

/**
 * Explicit administrative bootstrap, NOT a runtime startup/migration hook.
 * Creates a fresh schema transactionally; refuses any existing schema, including
 * an earlier OpenDoc schema. No DROP, overwrite, retry, or upgrade is performed.
 * The application role should not have CREATE privilege after provisioning.
 */
export async function initializePostgresSchema({ pool, schema, maxDocumentsPerTenant = 100, maxDocuments = 1000, maxBytes = 16 * 1024 * 1024 }) {
  requirePool(pool);
  const sqlSchema = schemaIdentifier(schema);
  if (!Number.isSafeInteger(maxDocumentsPerTenant) || maxDocumentsPerTenant < 1 || maxDocumentsPerTenant > 10000 ||
      !Number.isSafeInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 1000000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Invalid PostgreSQL store capacity limits');
  let migration;
  try { migration = (await readFile(new URL('../migrations/001_document_store.sql', import.meta.url), 'utf8')).replaceAll('__SCHEMA__', sqlSchema); }
  catch (error) { throw sanitized(error); }
  return connection(pool, true, async client => {
    await client.query(migration);
    await client.query(`INSERT INTO ${sqlSchema}.store_state
      (singleton, schema_version, max_documents_per_tenant, max_documents, max_bytes)
      VALUES (true, $1, $2, $3, $4)`, [POSTGRES_SCHEMA_VERSION, maxDocumentsPerTenant, maxDocuments, maxBytes]);
    return { schemaVersion: POSTGRES_SCHEMA_VERSION };
  });
}

/**
 * Bounded durable reference store, using a caller-owned standard pg Pool.
 * Each mutation locks a schema-wide state row before checking limits and writing.
 * This intentionally favors simple, cross-process correctness over throughput.
 * Use one schema per service, not per tenant. Tenancy is always a query parameter.
 */
export class PostgresDocumentStore {
  kind = 'postgresql';
  #pool;
  #schema;

  constructor({ pool, schema }) {
    requirePool(pool);
    this.#pool = pool;
    this.#schema = schemaIdentifier(schema);
  }

  async #state(client, lock = false) {
    const { rows } = await client.query(`SELECT schema_version, max_documents_per_tenant, max_documents,
      max_bytes, document_count, byte_count FROM ${this.#schema}.store_state WHERE singleton = true${lock ? ' FOR UPDATE' : ''}`);
    if (rows.length !== 1 || integer(rows[0].schema_version, 1) !== POSTGRES_SCHEMA_VERSION) fail('DEPENDENCY_UNAVAILABLE');
    const row = rows[0];
    const state = {
      maxDocumentsPerTenant: integer(row.max_documents_per_tenant, 1, 10000),
      maxDocuments: integer(row.max_documents, 1, 1000000), maxBytes: integer(row.max_bytes, 1),
      documentCount: integer(row.document_count), byteCount: integer(row.byte_count)
    };
    if (state.documentCount > state.maxDocuments || state.byteCount > state.maxBytes) fail('DEPENDENCY_UNAVAILABLE');
    return state;
  }

  async list(tenantId) {
    scope(tenantId);
    return connection(this.#pool, false, async client => {
      const state = await this.#state(client);
      const { rows } = await client.query(`SELECT id, title_json, revision, created_at, updated_at
        FROM ${this.#schema}.documents WHERE tenant_id = $1 ORDER BY id COLLATE "C" LIMIT $2`, [tenantId, state.maxDocumentsPerTenant + 1]);
      // The API has no cursor contract yet. Return the whole bounded list or fail.
      if (rows.length > state.maxDocumentsPerTenant) fail('CAPACITY_EXCEEDED');
      return rows.map(row => document(row, false));
    });
  }

  async get(tenantId, id) {
    scope(tenantId, id);
    return connection(this.#pool, false, async client => {
      await this.#state(client);
      const { rows } = await client.query(`SELECT ${COLUMNS} FROM ${this.#schema}.documents WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      return rows.length ? document(rows[0]) : null;
    });
  }

  async create(tenantId, input) {
    scope(tenantId);
    documentInput(input, true);
    // Snapshot before the first await: caller mutation cannot change saved values.
    const { id, title, content } = input;
    const bytes = Buffer.byteLength(id + title + content, 'utf8');
    return connection(this.#pool, true, async client => {
      const state = await this.#state(client, true);
      const existing = await client.query(`SELECT id FROM ${this.#schema}.documents WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      if (existing.rows.length) fail('CONFLICT');
      const count = await client.query(`SELECT count(*) AS count FROM ${this.#schema}.documents WHERE tenant_id = $1`, [tenantId]);
      if (integer(count.rows[0]?.count) >= state.maxDocumentsPerTenant || state.documentCount >= state.maxDocuments || bytes > state.maxBytes - state.byteCount) fail('CAPACITY_EXCEEDED');
      let result;
      try {
        result = await client.query(`INSERT INTO ${this.#schema}.documents
          (tenant_id, id, title_json, content_json, logical_bytes, revision)
          VALUES ($1, $2, $3, $4, $5, 1) RETURNING ${COLUMNS}`, [tenantId, id, stringBytes(title), stringBytes(content), bytes]);
      } catch (error) {
        if (error?.code === '23505') fail('CONFLICT');
        throw error;
      }
      await client.query(`UPDATE ${this.#schema}.store_state SET document_count = document_count + 1,
        byte_count = byte_count + $1 WHERE singleton = true`, [bytes]);
      return document(result.rows[0]);
    });
  }

  async replace(tenantId, id, expectedRevision, input) {
    scope(tenantId, id);
    documentInput(input, false);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail('PRECONDITION_FAILED');
    const { title, content } = input;
    const bytes = Buffer.byteLength(id + title + content, 'utf8');
    return connection(this.#pool, true, async client => {
      const state = await this.#state(client, true);
      const current = await client.query(`SELECT revision, logical_bytes FROM ${this.#schema}.documents
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, id]);
      if (!current.rows.length) fail('NOT_FOUND');
      const revision = integer(current.rows[0].revision, 1);
      if (revision !== expectedRevision) fail('PRECONDITION_FAILED');
      const previousBytes = integer(current.rows[0].logical_bytes, 1);
      if (previousBytes > state.byteCount) fail('DEPENDENCY_UNAVAILABLE');
      if (bytes > state.maxBytes - (state.byteCount - previousBytes) || revision === Number.MAX_SAFE_INTEGER) fail('CAPACITY_EXCEEDED');
      const { rows } = await client.query(`UPDATE ${this.#schema}.documents SET title_json = $4,
        content_json = $5, logical_bytes = $6, revision = revision + 1, updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2 AND revision = $3 RETURNING ${COLUMNS}`,
      [tenantId, id, expectedRevision, stringBytes(title), stringBytes(content), bytes]);
      if (rows.length !== 1) fail('PRECONDITION_FAILED');
      await client.query(`UPDATE ${this.#schema}.store_state SET byte_count = byte_count + $1 WHERE singleton = true`, [bytes - previousBytes]);
      return document(rows[0]);
    });
  }
}
