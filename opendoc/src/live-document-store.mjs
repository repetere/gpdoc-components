// Original OpenDoc implementation. MIT. Yjs is the sole live-document authority.
// Separate namespaces from REST documents and standalone collaboration rooms.
import { readFile } from 'node:fs/promises';
import { StoreError } from './memory-store.mjs';
import { createLiveDocumentState, mergeLiveDocumentState, copyCollaborationUpdate, LIVE_DOCUMENT_LIMITS, MAX_COLLABORATION_STATE_BYTES } from './collaboration-state.mjs';

export const LIVE_DOCUMENT_SCHEMA_VERSION = 1;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}(?![\s\S])/;
const TENANT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}(?![\s\S])/;
const SAFE = new Set(['BAD_REQUEST', 'TOO_LARGE', 'CAPACITY_EXCEEDED', 'DEPENDENCY_UNAVAILABLE', 'CONFLICT', 'NOT_FOUND']);
const EMPTY = new Uint8Array([0, 0]);
const encoder = new TextEncoder();
function fail(code) { throw new StoreError(code); }
function sanitize(error) { return new StoreError(error instanceof StoreError && SAFE.has(error.code) ? error.code : 'DEPENDENCY_UNAVAILABLE'); }
function scope(tenant, id = 'unused') { if (typeof tenant !== 'string' || !TENANT.test(tenant) || typeof id !== 'string' || !ID.test(id)) fail('BAD_REQUEST'); }
function inputDocument(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).length !== 3 ||
    !['id', 'title', 'content'].every(key => Object.hasOwn(input, key)) || typeof input.id !== 'string' || !ID.test(input.id) ||
    typeof input.title !== 'string' || input.title.length > LIVE_DOCUMENT_LIMITS.maxTitleCodeUnits || typeof input.content !== 'string') fail('BAD_REQUEST');
  if (encoder.encode(input.content).byteLength > LIVE_DOCUMENT_LIMITS.maxContentBytes) fail('TOO_LARGE');
  return { id: input.id, title: input.title, content: input.content };
}
function limits({ maxDocumentsPerTenant = 100, maxDocuments = 1000, maxBytes = 16 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxDocumentsPerTenant) || maxDocumentsPerTenant < 1 || maxDocumentsPerTenant > 10000 ||
    !Number.isSafeInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 1000000 ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Invalid live-document capacity limits');
  return { maxDocumentsPerTenant, maxDocuments, maxBytes };
}
function stringBytes(value) { return Buffer.from(JSON.stringify(value), 'utf8'); }
function decodeString(value, maximum) {
  if (!(value instanceof Uint8Array) || value.byteLength > maximum) fail('DEPENDENCY_UNAVAILABLE');
  let result;
  try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)); } catch { fail('DEPENDENCY_UNAVAILABLE'); }
  if (typeof result !== 'string') fail('DEPENDENCY_UNAVAILABLE');
  return result;
}
function size(tenant, value) { return value.state.byteLength + tenant.length + value.id.length + stringBytes(value.title).byteLength + stringBytes(value.content).byteLength; }
function detached(doc) { return { ...doc, state: Uint8Array.from(doc.state) }; }
/** Public projection only; never exposes a replaceable REST snapshot or binary JSON. */
export function liveDocumentProjection(doc, summary = false) {
  const { id, title, content, revision, createdAt, updatedAt } = doc;
  return { id, title, ...(summary ? {} : { content }), revision, createdAt, updatedAt, authority: 'yjs' };
}

/** Bounded ephemeral single-process store. Reads serialize behind unsettled writes. */
export class MemoryLiveDocumentStore {
  kind = 'memory-live-documents';
  #documents = new Map();
  #limits;
  #bytes = 0;
  #tail = Promise.resolve();
  #pending = 0;
  constructor(options) { this.#limits = limits(options); }
  async #run(work) {
    if (this.#pending >= 128) fail('CAPACITY_EXCEEDED');
    this.#pending++;
    const result = this.#tail.then(work);
    this.#tail = result.catch(() => {});
    try { return await result; } finally { this.#pending--; }
  }
  async list(tenant) {
    scope(tenant);
    return this.#run(() => [...this.#documents.values()].filter(value => value.tenant === tenant)
      .map(value => liveDocumentProjection(value.doc, true)).sort((a, b) => a.id.localeCompare(b.id)));
  }
  async get(tenant, id) {
    scope(tenant, id);
    return this.#run(() => { const value = this.#documents.get(JSON.stringify([tenant, id])); return value ? detached(value.doc) : null; });
  }
  async create(tenant, input) {
    scope(tenant);
    const data = inputDocument(input);
    return this.#run(async () => {
      const key = JSON.stringify([tenant, data.id]);
      if (this.#documents.has(key)) fail('CONFLICT');
      const tenantCount = [...this.#documents.values()].filter(value => value.tenant === tenant).length;
      if (tenantCount >= this.#limits.maxDocumentsPerTenant || this.#documents.size >= this.#limits.maxDocuments) fail('CAPACITY_EXCEEDED');
      const merged = await createLiveDocumentState(data);
      const now = new Date().toISOString();
      const doc = { id: data.id, title: merged.title, content: merged.content, state: merged.state, revision: 1, createdAt: now, updatedAt: now, authority: 'yjs' };
      const bytes = size(tenant, doc);
      if (bytes > this.#limits.maxBytes - this.#bytes) fail('CAPACITY_EXCEEDED');
      this.#documents.set(key, { tenant, doc }); this.#bytes += bytes;
      return detached(doc);
    });
  }
  async applyUpdate(tenant, id, update) {
    scope(tenant, id);
    const bytes = copyCollaborationUpdate(update, LIVE_DOCUMENT_LIMITS.maxUpdateBytes);
    return this.#run(async () => {
      const key = JSON.stringify([tenant, id]); const current = this.#documents.get(key)?.doc;
      if (!current) fail('NOT_FOUND');
      const merged = await mergeLiveDocumentState(current.state, bytes);
      if (!merged.changed) return detached(current);
      const doc = { ...current, state: merged.state, title: merged.title, content: merged.content, revision: current.revision + 1, updatedAt: new Date().toISOString() };
      const total = this.#bytes - size(tenant, current) + size(tenant, doc);
      if (total > this.#limits.maxBytes || !Number.isSafeInteger(doc.revision)) fail('CAPACITY_EXCEEDED');
      this.#documents.set(key, { tenant, doc }); this.#bytes = total;
      return detached(doc);
    });
  }
}

function schemaIdentifier(schema) {
  if (typeof schema !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(schema) || /^(?:pg_|public$|information_schema$)/.test(schema)) throw new TypeError('An explicit non-system PostgreSQL live-document schema is required');
  return `"${schema}"`;
}
function requirePool(pool) { if (!pool || typeof pool.connect !== 'function') throw new TypeError('A pg Pool-compatible adapter is required'); }
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!(typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value))) fail('DEPENDENCY_UNAVAILABLE');
  const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) fail('DEPENDENCY_UNAVAILABLE'); return n;
}
function timestamp(value) {
  const result = value instanceof Date ? value : new Date(value);
  if (!(value instanceof Date || typeof value === 'string') || !Number.isFinite(result.getTime())) fail('DEPENDENCY_UNAVAILABLE');
  return result.toISOString();
}
function metadata(row) {
  const title = decodeString(row?.title_json, 1202);
  if (!row || typeof row.document_id !== 'string' || !ID.test(row.document_id) || title.length > LIVE_DOCUMENT_LIMITS.maxTitleCodeUnits) fail('DEPENDENCY_UNAVAILABLE');
  return { id: row.document_id, title, revision: integer(row.revision, 1), createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at), authority: 'yjs' };
}
async function document(row) {
  const meta = metadata(row);
  const content = decodeString(row.content_json, 6 * LIVE_DOCUMENT_LIMITS.maxContentBytes + 2);
  if (!(row.state instanceof Uint8Array) || row.state.byteLength < 2 || row.state.byteLength > MAX_COLLABORATION_STATE_BYTES ||
    encoder.encode(content).byteLength > LIVE_DOCUMENT_LIMITS.maxContentBytes) fail('DEPENDENCY_UNAVAILABLE');
  // Decode stored bytes only in the bounded worker, before exposing ready/state.
  const checked = await mergeLiveDocumentState(row.state, EMPTY);
  if (checked.changed || checked.title !== meta.title || checked.content !== content) fail('DEPENDENCY_UNAVAILABLE');
  return { ...meta, content: checked.content, state: checked.state };
}
async function connection(pool, work) {
  let client, transaction = false, discard = false;
  try {
    client = await pool.connect();
    if (!client || typeof client.query !== 'function' || typeof client.release !== 'function') fail('DEPENDENCY_UNAVAILABLE');
    transaction = true;
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const result = await work(client);
    await client.query('COMMIT'); transaction = false;
    return result;
  } catch (error) {
    if (transaction) { try { await client.query('ROLLBACK'); } catch { discard = true; } }
    throw sanitize(error);
  } finally {
    if (typeof client?.release === 'function') { try { client.release(discard); } catch (error) { throw sanitize(error); } }
  }
}

/** Explicit fresh namespace bootstrap. No implicit migrations, reuse or DROP. */
export async function initializePostgresLiveDocumentSchema({ pool, schema, ...options }) {
  requirePool(pool); const sqlSchema = schemaIdentifier(schema); const capacity = limits(options);
  let migration;
  try { migration = (await readFile(new URL('../migrations/005_live_documents.sql', import.meta.url), 'utf8')).replaceAll('__SCHEMA__', sqlSchema); }
  catch (error) { throw sanitize(error); }
  return connection(pool, async client => {
    await client.query(migration);
    await client.query(`INSERT INTO ${sqlSchema}.live_document_state (singleton, schema_version, max_documents_per_tenant, max_documents, max_bytes)
      VALUES (true, $1, $2, $3, $4)`, [LIVE_DOCUMENT_SCHEMA_VERSION, capacity.maxDocumentsPerTenant, capacity.maxDocuments, capacity.maxBytes]);
    return { schemaVersion: LIVE_DOCUMENT_SCHEMA_VERSION };
  });
}

/**
 * Caller-owned pool; Yjs bytes and derived projection commit in the SAME row.
 * Quota-row locks serialize mutations across processes; shared read locks fence
 * reconnects behind uncertain commits. No snapshot replacement method exists.
 * WebSocket fanout remains single-process; multiple writers need explicit sync.
 */
export class PostgresLiveDocumentStore {
  kind = 'postgresql-live-documents';
  #pool; #schema;
  constructor({ pool, schema }) { requirePool(pool); this.#pool = pool; this.#schema = schemaIdentifier(schema); }
  async #state(client, writing = false) {
    const { rows } = await client.query(`SELECT schema_version, max_documents_per_tenant, max_documents, max_bytes, document_count, byte_count
      FROM ${this.#schema}.live_document_state WHERE singleton = true FOR ${writing ? 'UPDATE' : 'SHARE'}`);
    if (rows.length !== 1 || integer(rows[0].schema_version, 1) !== LIVE_DOCUMENT_SCHEMA_VERSION) fail('DEPENDENCY_UNAVAILABLE');
    const r = rows[0];
    const result = { maxDocumentsPerTenant: integer(r.max_documents_per_tenant, 1, 10000), maxDocuments: integer(r.max_documents, 1, 1000000), maxBytes: integer(r.max_bytes, 1), count: integer(r.document_count), bytes: integer(r.byte_count) };
    if (result.count > result.maxDocuments || result.bytes > result.maxBytes) fail('DEPENDENCY_UNAVAILABLE');
    return result;
  }
  async list(tenant) {
    scope(tenant);
    return connection(this.#pool, async client => {
      const caps = await this.#state(client);
      const { rows } = await client.query(`SELECT document_id, title_json, revision, created_at, updated_at FROM ${this.#schema}.live_documents WHERE tenant_id = $1 ORDER BY document_id LIMIT $2`, [tenant, caps.maxDocumentsPerTenant + 1]);
      if (rows.length > caps.maxDocumentsPerTenant) fail('DEPENDENCY_UNAVAILABLE');
      return rows.map(metadata);
    });
  }
  async get(tenant, id) {
    scope(tenant, id);
    return connection(this.#pool, async client => {
      await this.#state(client);
      const { rows } = await client.query(`SELECT * FROM ${this.#schema}.live_documents WHERE tenant_id = $1 AND document_id = $2`, [tenant, id]);
      if (rows.length > 1) fail('DEPENDENCY_UNAVAILABLE');
      return rows.length ? document(rows[0]) : null;
    });
  }
  async create(tenant, input) {
    scope(tenant); const data = inputDocument(input);
    return connection(this.#pool, async client => {
      const caps = await this.#state(client, true);
      const current = await client.query(`SELECT document_id FROM ${this.#schema}.live_documents WHERE tenant_id = $1 AND document_id = $2`, [tenant, data.id]);
      if (current.rows.length) fail('CONFLICT');
      const count = await client.query(`SELECT count(*) AS count FROM ${this.#schema}.live_documents WHERE tenant_id = $1`, [tenant]);
      if (integer(count.rows[0]?.count) >= caps.maxDocumentsPerTenant || caps.count >= caps.maxDocuments) fail('CAPACITY_EXCEEDED');
      const merged = await createLiveDocumentState(data);
      const bytes = size(tenant, { ...data, state: merged.state });
      if (bytes > caps.maxBytes - caps.bytes) fail('CAPACITY_EXCEEDED');
      const { rows } = await client.query(`INSERT INTO ${this.#schema}.live_documents (tenant_id, document_id, state, title_json, content_json, logical_bytes, revision)
        VALUES ($1, $2, $3, $4, $5, $6, 1) RETURNING *`, [tenant, data.id, Buffer.from(merged.state), stringBytes(merged.title), stringBytes(merged.content), bytes]);
      await client.query(`UPDATE ${this.#schema}.live_document_state SET document_count = document_count + 1, byte_count = byte_count + $1 WHERE singleton = true`, [bytes]);
      if (rows.length !== 1) fail('DEPENDENCY_UNAVAILABLE');
      return { ...metadata(rows[0]), state: merged.state, content: merged.content };
    });
  }
  async applyUpdate(tenant, id, update) {
    scope(tenant, id); const input = copyCollaborationUpdate(update, LIVE_DOCUMENT_LIMITS.maxUpdateBytes);
    return connection(this.#pool, async client => {
      const caps = await this.#state(client, true);
      const { rows } = await client.query(`SELECT * FROM ${this.#schema}.live_documents WHERE tenant_id = $1 AND document_id = $2 FOR UPDATE`, [tenant, id]);
      if (!rows.length) fail('NOT_FOUND');
      if (rows.length !== 1) fail('DEPENDENCY_UNAVAILABLE');
      const current = await document(rows[0]);
      const previousBytes = integer(rows[0].logical_bytes, 1);
      if (previousBytes !== size(tenant, current) || previousBytes > caps.bytes) fail('DEPENDENCY_UNAVAILABLE');
      const merged = await mergeLiveDocumentState(current.state, input);
      if (!merged.changed) return current;
      const bytes = size(tenant, { ...current, ...merged });
      if (bytes > caps.maxBytes - (caps.bytes - previousBytes) || current.revision === Number.MAX_SAFE_INTEGER) fail('CAPACITY_EXCEEDED');
      const next = await client.query(`UPDATE ${this.#schema}.live_documents SET state = $3, title_json = $4, content_json = $5, logical_bytes = $6,
        revision = revision + 1, updated_at = clock_timestamp() WHERE tenant_id = $1 AND document_id = $2 RETURNING *`, [tenant, id, Buffer.from(merged.state), stringBytes(merged.title), stringBytes(merged.content), bytes]);
      await client.query(`UPDATE ${this.#schema}.live_document_state SET byte_count = byte_count + $1 WHERE singleton = true`, [bytes - previousBytes]);
      if (next.rows.length !== 1) fail('DEPENDENCY_UNAVAILABLE');
      return { ...metadata(next.rows[0]), state: merged.state, content: merged.content };
    });
  }
}
