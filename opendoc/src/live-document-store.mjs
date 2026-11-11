// Original OpenDoc implementation. MIT. Yjs is the sole live-document authority.
// Separate namespaces from REST documents and standalone collaboration rooms.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { StoreError } from './memory-store.mjs';
import { createPostgresAccountWriteGuard } from './account-store.mjs';
import { createLiveDocumentState, mergeLiveDocumentState, copyCollaborationUpdate, LIVE_DOCUMENT_LIMITS, MAX_COLLABORATION_STATE_BYTES } from './collaboration-state.mjs';

export const LIVE_DOCUMENT_SCHEMA_VERSION = 1;
export const GUARDED_LIVE_DOCUMENT_SCHEMA_VERSION = 2;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}(?![\s\S])/;
const TENANT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}(?![\s\S])/;
const SAFE = new Set(['BAD_REQUEST', 'FORBIDDEN', 'TOO_LARGE', 'CAPACITY_EXCEEDED', 'DEPENDENCY_UNAVAILABLE', 'CONFLICT', 'NOT_FOUND']);
const EMPTY = new Uint8Array([0, 0]);
const QUARANTINED = Symbol('quarantined live namespace');
const DIGEST_DOMAIN = Buffer.from('opendoc-live-checkpoint-v1\0');
const AUTHORITY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/;
class IntegrityError extends Error {}
function corrupt() { throw new IntegrityError(); }
function historyPin(option) {
  if (option === undefined) return null;
  const field = option && Object.getOwnPropertyDescriptor(option, 'authorityId');
  if (!option || Object.getPrototypeOf(option) !== Object.prototype || Reflect.ownKeys(option).length !== 1 ||
      !field || !Object.hasOwn(field, 'value') || typeof field.value !== 'string' || !AUTHORITY.test(field.value)) {
    throw new TypeError('historyGuard requires an explicit lowercase UUID authorityId');
  }
  return field.value;
}
function stored(check) {
  try { return check(); } catch { corrupt(); }
}
// Bind actual Yjs bytes AND their exact persisted projections. Length framing
// prevents concatenation ambiguity; neither text nor a state vector substitutes
// for canonical state. PostgreSQL uses this same framing on metadata-only reads.
function checkpointDigest(row) {
  const hash = createHash('sha256').update(DIGEST_DOMAIN);
  stored(() => scope(row.tenant_id, row.document_id));
  for (const value of [row.tenant_id, row.document_id]) {
    const bytes = Buffer.from(value), length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.byteLength); hash.update(length).update(bytes);
  }
  const revision = Buffer.alloc(8); revision.writeBigUInt64BE(BigInt(stored(() => integer(row.revision, 1)))); hash.update(revision);
  for (const [bytes, maximum, minimum] of [[row.state, MAX_COLLABORATION_STATE_BYTES, 2], [row.title_json, 1202, 0], [row.content_json, 1572866, 0]]) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < minimum || bytes.byteLength > maximum) corrupt();
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.byteLength); hash.update(length).update(bytes);
  }
  return hash.digest();
}
function newCheckpointDigest(row) {
  // A malformed newly computed result is a failed attempted write, not evidence
  // that the existing namespace is corrupt. Never commit quarantine for it.
  try { return checkpointDigest(row); } catch { fail('DEPENDENCY_UNAVAILABLE'); }
}
function digestSql(alias = '') {
  const prefix = alias ? `${alias}.` : '';
  const keys = ['tenant_id', 'document_id'].map(column => `int4send(octet_length(convert_to(${prefix}${column}, 'UTF8'))) || convert_to(${prefix}${column}, 'UTF8')`).join(' || ');
  return `sha256(decode('${DIGEST_DOMAIN.toString('hex')}', 'hex') || ${keys} || int8send(${prefix}revision) || ${['state', 'title_json', 'content_json']
    .map(column => `int4send(octet_length(${prefix}${column})) || ${prefix}${column}`).join(' || ')})`;
}
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
  if (typeof schema !== 'string' || !/^[a-z][a-z0-9_]{0,62}(?![\s\S])/.test(schema) || /^(?:pg_|public$|information_schema$)/.test(schema)) throw new TypeError('An explicit non-system PostgreSQL live-document schema is required');
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
async function document(row, guarded = false) {
  const parse = () => {
    const meta = metadata(row);
    const content = decodeString(row.content_json, 6 * LIVE_DOCUMENT_LIMITS.maxContentBytes + 2);
    if (!(row.state instanceof Uint8Array) || row.state.byteLength < 2 || row.state.byteLength > MAX_COLLABORATION_STATE_BYTES ||
      encoder.encode(content).byteLength > LIVE_DOCUMENT_LIMITS.maxContentBytes) fail('DEPENDENCY_UNAVAILABLE');
    return { meta, content };
  };
  const { meta, content } = guarded ? stored(parse) : parse();
  // Decode stored bytes only in the bounded worker, before exposing ready/state.
  let checked;
  try { checked = await mergeLiveDocumentState(row.state, EMPTY); }
  catch (error) {
    // BAD_REQUEST here is a deterministic rejection of stored bytes, not an
    // incoming mutation. Worker timeouts, capacity and outages are not evidence
    // of corrupt durable history and must never latch quarantine.
    if (guarded && error instanceof StoreError && error.code === 'BAD_REQUEST') corrupt();
    throw error;
  }
  if (checked.changed || checked.title !== meta.title || checked.content !== content) {
    if (guarded) corrupt();
    fail('DEPENDENCY_UNAVAILABLE');
  }
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
export async function initializePostgresLiveDocumentSchema({ pool, schema, historyGuard, ...options }) {
  requirePool(pool); const sqlSchema = schemaIdentifier(schema); const capacity = limits(options), authorityId = historyPin(historyGuard);
  let migration;
  try {
    migration = await readFile(new URL('../migrations/005_live_documents.sql', import.meta.url), 'utf8');
    if (authorityId) migration += await readFile(new URL('../migrations/006_guarded_live_documents.sql', import.meta.url), 'utf8');
    migration = migration.replaceAll('__SCHEMA__', sqlSchema);
  }
  catch (error) { throw sanitize(error); }
  return connection(pool, async client => {
    await client.query(migration);
    const schemaVersion = authorityId ? GUARDED_LIVE_DOCUMENT_SCHEMA_VERSION : LIVE_DOCUMENT_SCHEMA_VERSION;
    await client.query(`INSERT INTO ${sqlSchema}.live_document_state (singleton, schema_version, max_documents_per_tenant, max_documents, max_bytes${authorityId ? ', authority_id' : ''})
      VALUES (true, $1, $2, $3, $4${authorityId ? ', $5' : ''})`, [schemaVersion, capacity.maxDocumentsPerTenant, capacity.maxDocuments, capacity.maxBytes, ...(authorityId ? [authorityId] : [])]);
    return { schemaVersion, ...(authorityId ? { authorityId } : {}) };
  });
}

/**
 * Caller-owned pool; Yjs bytes and derived projection commit in the SAME row.
 * Quota-row locks serialize mutations across processes; shared read locks fence
 * reconnects behind uncertain commits. No snapshot replacement method exists.
 * Optional WebSocket polling can synchronize servers using this same primary
 * and schema. This adapter does not provide database failover or leader election.
 */
export class PostgresLiveDocumentStore {
  kind = 'postgresql-live-documents';
  #pool; #schema; #authorityId; #writeGuard;
  constructor({ pool, schema, historyGuard, accountSchema }) {
    requirePool(pool); this.#pool = pool; this.#schema = schemaIdentifier(schema);
    this.#authorityId = historyPin(historyGuard);
    if (accountSchema !== undefined) {
      if (accountSchema === schema) throw new TypeError('Account and live-document schemas must be separate');
      this.#writeGuard = createPostgresAccountWriteGuard({ schema: accountSchema });
    }
  }
  async #state(client, writing = false) {
    const { rows } = await client.query(`SELECT schema_version, max_documents_per_tenant, max_documents, max_bytes, document_count, byte_count${this.#authorityId ? ', authority_id, quarantined' : ''}
      FROM ${this.#schema}.live_document_state WHERE singleton = true FOR ${writing || this.#authorityId ? 'UPDATE' : 'SHARE'}`);
    const version = this.#authorityId ? GUARDED_LIVE_DOCUMENT_SCHEMA_VERSION : LIVE_DOCUMENT_SCHEMA_VERSION;
    if (rows.length !== 1 || integer(rows[0].schema_version, 1) !== version) fail('DEPENDENCY_UNAVAILABLE');
    const r = rows[0];
    // A missing pin, wrong target, version mismatch, or malformed control row is
    // unavailable, not permission to poison or adopt that namespace.
    if (this.#authorityId && (r.authority_id !== this.#authorityId || r.quarantined !== false)) fail('DEPENDENCY_UNAVAILABLE');
    const result = { maxDocumentsPerTenant: integer(r.max_documents_per_tenant, 1, 10000), maxDocuments: integer(r.max_documents, 1, 1000000), maxBytes: integer(r.max_bytes, 1), count: integer(r.document_count), bytes: integer(r.byte_count) };
    if (result.count > result.maxDocuments || result.bytes > result.maxBytes) fail('DEPENDENCY_UNAVAILABLE');
    return result;
  }
  async #run(writing, actor, work) {
    const result = await connection(this.#pool, async client => {
      if (writing && this.#writeGuard) await this.#writeGuard.authorize(client, actor);
      const caps = await this.#state(client, writing);
      try { return await work(client, caps); }
      catch (error) {
        if (!this.#authorityId || !(error instanceof IntegrityError)) throw error;
        // IntegrityError is raised ONLY while checking pre-mutation stored
        // state. Return a failure outcome so COMMIT persists this latch; throwing
        // here would undo quarantine in connection()'s rollback handler.
        const marked = await client.query(`UPDATE ${this.#schema}.live_document_state SET quarantined = true WHERE singleton = true RETURNING singleton`);
        if (marked.rows.length !== 1 || marked.rows[0].singleton !== true) fail('DEPENDENCY_UNAVAILABLE');
        return QUARANTINED;
      }
    });
    if (result === QUARANTINED) fail('DEPENDENCY_UNAVAILABLE');
    return result;
  }
  #checkpoint(row, checkpoint, digest) {
    if (!row || !checkpoint) corrupt();
    const revision = stored(() => integer(row.revision, 1));
    if (checkpoint.tenant_id !== row.tenant_id || checkpoint.document_id !== row.document_id ||
        stored(() => integer(checkpoint.revision, 1)) !== revision ||
        !(checkpoint.digest instanceof Uint8Array) || checkpoint.digest.byteLength !== 32 ||
        !(digest instanceof Uint8Array) || digest.byteLength !== 32 || !Buffer.from(checkpoint.digest).equals(digest)) corrupt();
  }
  async #guardedRow(client, tenant, id, metadataOnly = false) {
    const columns = metadataOnly ? `tenant_id, document_id, title_json, revision, created_at, updated_at, ${digestSql()} AS actual_digest` : '*';
    const canonical = await client.query(`SELECT ${columns} FROM ${this.#schema}.live_documents WHERE tenant_id = $1 AND document_id = $2`, [tenant, id]);
    const checkpoints = await client.query(`SELECT tenant_id, document_id, revision, digest FROM ${this.#schema}.live_document_checkpoints WHERE tenant_id = $1 AND document_id = $2`, [tenant, id]);
    if (canonical.rows.length > 1 || checkpoints.rows.length > 1) corrupt();
    if (!canonical.rows.length && !checkpoints.rows.length) return null;
    const row = canonical.rows[0];
    if (!row || row.tenant_id !== tenant || row.document_id !== id) corrupt();
    this.#checkpoint(row, checkpoints.rows[0], metadataOnly ? row.actual_digest : checkpointDigest(row));
    stored(() => metadata(row));
    return row;
  }
  async list(tenant) {
    scope(tenant);
    return this.#run(false, null, async (client, caps) => {
      if (this.#authorityId) {
        // Hash bytes in PostgreSQL: listing never buffers every 1 MiB state or
        // starts a worker per entry. The checkpoint binds projections too.
        const { rows } = await client.query(`SELECT d.tenant_id, d.document_id, d.title_json, d.revision, d.created_at, d.updated_at,
          ${digestSql('d')} AS actual_digest, c.tenant_id AS checkpoint_tenant_id, c.document_id AS checkpoint_document_id,
          c.revision AS checkpoint_revision, c.digest AS checkpoint_digest
          FROM ${this.#schema}.live_documents d FULL OUTER JOIN ${this.#schema}.live_document_checkpoints c
          ON d.tenant_id = c.tenant_id AND d.document_id = c.document_id
          WHERE COALESCE(d.tenant_id, c.tenant_id) = $1 ORDER BY COALESCE(d.document_id, c.document_id) LIMIT $2`, [tenant, caps.maxDocumentsPerTenant + 1]);
        if (rows.length > caps.maxDocumentsPerTenant) corrupt();
        return rows.map(row => {
          this.#checkpoint(row, { tenant_id: row.checkpoint_tenant_id, document_id: row.checkpoint_document_id,
            revision: row.checkpoint_revision, digest: row.checkpoint_digest }, row.actual_digest);
          if (row.tenant_id !== tenant) corrupt();
          return stored(() => metadata(row));
        });
      }
      const { rows } = await client.query(`SELECT document_id, title_json, revision, created_at, updated_at FROM ${this.#schema}.live_documents WHERE tenant_id = $1 ORDER BY document_id LIMIT $2`, [tenant, caps.maxDocumentsPerTenant + 1]);
      if (rows.length > caps.maxDocumentsPerTenant) fail('DEPENDENCY_UNAVAILABLE');
      return rows.map(metadata);
    });
  }
  async get(tenant, id) {
    scope(tenant, id);
    return this.#run(false, null, async client => {
      if (this.#authorityId) {
        const row = await this.#guardedRow(client, tenant, id);
        return row ? document(row, true) : null;
      }
      const { rows } = await client.query(`SELECT * FROM ${this.#schema}.live_documents WHERE tenant_id = $1 AND document_id = $2`, [tenant, id]);
      if (rows.length > 1) fail('DEPENDENCY_UNAVAILABLE');
      return rows.length ? document(rows[0]) : null;
    });
  }
  /** Poll a committed revision without decoding unchanged CRDT state.
   * The shared quota-row lock fences unresolved writes throughout both reads.
   * Normal writes must advance the revision; direct row edits, independent
   * cloned databases and transparent authority changes are outside this contract.
   */
  async getIfChanged(tenant, id, knownRevision) {
    scope(tenant, id);
    if (!Number.isSafeInteger(knownRevision) || knownRevision < 1) fail('BAD_REQUEST');
    return this.#run(false, null, async client => {
      if (this.#authorityId) {
        const row = await this.#guardedRow(client, tenant, id, true);
        if (!row) fail('NOT_FOUND');
        const revision = integer(row.revision, 1);
        // A caller-supplied higher floor is not durable evidence of corruption.
        if (revision < knownRevision) fail('DEPENDENCY_UNAVAILABLE');
        if (revision === knownRevision) return null;
        const full = await this.#guardedRow(client, tenant, id);
        return document(full, true);
      }
      const { rows } = await client.query(`SELECT revision FROM ${this.#schema}.live_documents WHERE tenant_id = $1 AND document_id = $2`, [tenant, id]);
      if (!rows.length) fail('NOT_FOUND');
      if (rows.length !== 1) fail('DEPENDENCY_UNAVAILABLE');
      const revision = integer(rows[0].revision, 1);
      if (revision < knownRevision) fail('DEPENDENCY_UNAVAILABLE');
      if (revision === knownRevision) return null;
      const current = await client.query(`SELECT * FROM ${this.#schema}.live_documents WHERE tenant_id = $1 AND document_id = $2`, [tenant, id]);
      if (current.rows.length !== 1 || integer(current.rows[0].revision, 1) !== revision) fail('DEPENDENCY_UNAVAILABLE');
      return document(current.rows[0]);
    });
  }
  async create(tenant, input, trustedActor) {
    scope(tenant); const actor = this.#writeGuard?.snapshot(tenant, trustedActor), data = inputDocument(input);
    return this.#run(true, actor, async (client, caps) => {
      if (this.#authorityId) {
        const current = await this.#guardedRow(client, tenant, data.id);
        if (current) { await document(current, true); fail('CONFLICT'); }
        const checkpoints = await client.query(`SELECT count(*) AS count FROM ${this.#schema}.live_document_checkpoints`);
        if (stored(() => integer(checkpoints.rows[0]?.count)) !== caps.count) corrupt();
      } else {
        const current = await client.query(`SELECT document_id FROM ${this.#schema}.live_documents WHERE tenant_id = $1 AND document_id = $2`, [tenant, data.id]);
        if (current.rows.length) fail('CONFLICT');
      }
      const count = await client.query(`SELECT count(*) AS count FROM ${this.#schema}.live_documents WHERE tenant_id = $1`, [tenant]);
      if (integer(count.rows[0]?.count) >= caps.maxDocumentsPerTenant || caps.count >= caps.maxDocuments) fail('CAPACITY_EXCEEDED');
      const merged = await createLiveDocumentState(data);
      const bytes = size(tenant, { ...data, state: merged.state });
      if (bytes > caps.maxBytes - caps.bytes) fail('CAPACITY_EXCEEDED');
      const digest = this.#authorityId ? newCheckpointDigest({ tenant_id: tenant, document_id: data.id, revision: 1,
        state: merged.state, title_json: stringBytes(merged.title), content_json: stringBytes(merged.content) }) : null;
      const { rows } = await client.query(`INSERT INTO ${this.#schema}.live_documents (tenant_id, document_id, state, title_json, content_json, logical_bytes, revision)
        VALUES ($1, $2, $3, $4, $5, $6, 1) RETURNING *`, [tenant, data.id, Buffer.from(merged.state), stringBytes(merged.title), stringBytes(merged.content), bytes]);
      await client.query(`UPDATE ${this.#schema}.live_document_state SET document_count = document_count + 1, byte_count = byte_count + $1 WHERE singleton = true`, [bytes]);
      if (this.#authorityId) await client.query(`INSERT INTO ${this.#schema}.live_document_checkpoints (tenant_id, document_id, revision, digest) VALUES ($1, $2, 1, $3)`, [tenant, data.id, digest]);
      if (rows.length !== 1) fail('DEPENDENCY_UNAVAILABLE');
      return { ...metadata(rows[0]), state: merged.state, content: merged.content };
    });
  }
  async applyUpdate(tenant, id, update, trustedActor) {
    scope(tenant, id); const actor = this.#writeGuard?.snapshot(tenant, trustedActor), input = copyCollaborationUpdate(update, LIVE_DOCUMENT_LIMITS.maxUpdateBytes);
    return this.#run(true, actor, async (client, caps) => {
      let row;
      if (this.#authorityId) row = await this.#guardedRow(client, tenant, id);
      else {
        const { rows } = await client.query(`SELECT * FROM ${this.#schema}.live_documents WHERE tenant_id = $1 AND document_id = $2 FOR UPDATE`, [tenant, id]);
        if (rows.length > 1) fail('DEPENDENCY_UNAVAILABLE'); row = rows[0];
      }
      if (!row) fail('NOT_FOUND');
      const current = await document(row, Boolean(this.#authorityId));
      const previousBytes = this.#authorityId ? stored(() => integer(row.logical_bytes, 1)) : integer(row.logical_bytes, 1);
      if (previousBytes !== size(tenant, current) || previousBytes > caps.bytes) {
        if (this.#authorityId) corrupt();
        fail('DEPENDENCY_UNAVAILABLE');
      }
      const merged = await mergeLiveDocumentState(current.state, input);
      if (!merged.changed) return current;
      const bytes = size(tenant, { ...current, ...merged });
      if (bytes > caps.maxBytes - (caps.bytes - previousBytes) || current.revision === Number.MAX_SAFE_INTEGER) fail('CAPACITY_EXCEEDED');
      const digest = this.#authorityId ? newCheckpointDigest({ tenant_id: tenant, document_id: id, revision: current.revision + 1,
        state: merged.state, title_json: stringBytes(merged.title), content_json: stringBytes(merged.content) }) : null;
      const next = await client.query(`UPDATE ${this.#schema}.live_documents SET state = $3, title_json = $4, content_json = $5, logical_bytes = $6,
        revision = revision + 1, updated_at = clock_timestamp() WHERE tenant_id = $1 AND document_id = $2 RETURNING *`, [tenant, id, Buffer.from(merged.state), stringBytes(merged.title), stringBytes(merged.content), bytes]);
      await client.query(`UPDATE ${this.#schema}.live_document_state SET byte_count = byte_count + $1 WHERE singleton = true`, [bytes - previousBytes]);
      if (this.#authorityId) {
        const checkpoint = await client.query(`UPDATE ${this.#schema}.live_document_checkpoints SET revision = $3, digest = $4
          WHERE tenant_id = $1 AND document_id = $2 AND revision = $5 RETURNING revision`, [tenant, id, current.revision + 1, digest, current.revision]);
        if (checkpoint.rows.length !== 1 || integer(checkpoint.rows[0].revision, 1) !== current.revision + 1) fail('DEPENDENCY_UNAVAILABLE');
      }
      if (next.rows.length !== 1) fail('DEPENDENCY_UNAVAILABLE');
      return { ...metadata(next.rows[0]), state: merged.state, content: merged.content };
    });
  }
}
