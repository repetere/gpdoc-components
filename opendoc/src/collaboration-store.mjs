// Original OpenDoc implementation. MIT, see ../../LICENSE.
// Standalone collaboration rooms. Never reads or changes REST document tables.
import { readFile } from 'node:fs/promises';
import { StoreError } from './memory-store.mjs';
import { copyCollaborationUpdate, mergeCollaborationState, MAX_COLLABORATION_STATE_BYTES } from './collaboration-state.mjs';

export const COLLABORATION_SCHEMA_VERSION = 1;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SAFE_CODES = new Set(['BAD_REQUEST', 'TOO_LARGE', 'CAPACITY_EXCEEDED', 'DEPENDENCY_UNAVAILABLE']);
function fail(code) { throw new StoreError(code); }
function sanitized(error) {
  return new StoreError(error instanceof StoreError && SAFE_CODES.has(error.code) ? error.code : 'DEPENDENCY_UNAVAILABLE');
}
function schemaIdentifier(schema) {
  if (typeof schema !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(schema) || /^(?:pg_|public$|information_schema$)/.test(schema)) {
    throw new TypeError('An explicit non-system PostgreSQL collaboration schema name is required');
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
function scope(tenantId, roomId) {
  if (typeof tenantId !== 'string' || !TENANT_ID.test(tenantId) || typeof roomId !== 'string' || !ID.test(roomId)) fail('BAD_REQUEST');
}
function room(row) {
  if (!(row?.state instanceof Uint8Array) || row.state.byteLength < 2 || row.state.byteLength > MAX_COLLABORATION_STATE_BYTES) fail('DEPENDENCY_UNAVAILABLE');
  return { state: Uint8Array.from(row.state), revision: integer(row.revision, 1) };
}
async function connection(pool, transactional, work) {
  let client;
  let inTransaction = false;
  let discard = false;
  try {
    client = await pool.connect();
    if (!client || typeof client.query !== 'function' || typeof client.release !== 'function') fail('DEPENDENCY_UNAVAILABLE');
    if (transactional) {
      // A timeout can occur after BEGIN reached the server. Always clean up.
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
    // An uncertain COMMIT is never retried here. Replaying the same Yjs update
    // later is idempotent whether that commit reached the server or not.
    throw sanitized(error);
  } finally {
    if (typeof client?.release === 'function') {
      try { client.release(discard); } catch (error) { throw sanitized(error); }
    }
  }
}

/**
 * Explicit one-time administrative bootstrap of a FRESH, separate namespace.
 * Refuses existing schemas, including REST-store schemas. No startup migrations,
 * schema reuse, upgrades, DROP, implicit connections, or pool ownership.
 */
export async function initializePostgresCollaborationSchema({ pool, schema, maxRoomsPerTenant = 100, maxRooms = 1000, maxBytes = 16 * 1024 * 1024 }) {
  requirePool(pool);
  const sqlSchema = schemaIdentifier(schema);
  if (!Number.isSafeInteger(maxRoomsPerTenant) || maxRoomsPerTenant < 1 || maxRoomsPerTenant > 10000 ||
      !Number.isSafeInteger(maxRooms) || maxRooms < 1 || maxRooms > 1000000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Invalid PostgreSQL collaboration capacity limits');
  let migration;
  try { migration = (await readFile(new URL('../migrations/002_collaboration_store.sql', import.meta.url), 'utf8')).replaceAll('__SCHEMA__', sqlSchema); }
  catch (error) { throw sanitized(error); }
  return connection(pool, true, async client => {
    await client.query(migration);
    await client.query(`INSERT INTO ${sqlSchema}.collaboration_state
      (singleton, schema_version, max_rooms_per_tenant, max_rooms, max_bytes)
      VALUES (true, $1, $2, $3, $4)`, [COLLABORATION_SCHEMA_VERSION, maxRoomsPerTenant, maxRooms, maxBytes]);
    return { schemaVersion: COLLABORATION_SCHEMA_VERSION };
  });
}

/**
 * Caller-owned standard pg Pool. All mutations serialize on a schema-wide quota
 * row before locking/merging one tenant+room snapshot, so quotas and updates are
 * atomic across processes. This favors correctness, not high throughput.
 * Reads hold a shared quota-row lock until their snapshot transaction commits.
 * This fences reconnects behind any still-settling writer, even when that writer
 * lost its connection before receiving COMMIT/ROLLBACK confirmation. Reads can
 * overlap other reads, but wait for all schema-wide writes to settle.
 * Authorization belongs to the caller. Reads never allocate a room.
 */
export class PostgresCollaborationStore {
  kind = 'postgresql-collaboration';
  #pool;
  #schema;
  constructor({ pool, schema }) {
    requirePool(pool);
    this.#pool = pool;
    this.#schema = schemaIdentifier(schema);
  }
  async #state(client, lock) {
    const lockClause = lock === 'share' ? ' FOR SHARE' : ' FOR UPDATE';
    const { rows } = await client.query(`SELECT schema_version, max_rooms_per_tenant, max_rooms,
      max_bytes, room_count, byte_count FROM ${this.#schema}.collaboration_state WHERE singleton = true${lockClause}`);
    if (rows.length !== 1 || integer(rows[0].schema_version, 1) !== COLLABORATION_SCHEMA_VERSION) fail('DEPENDENCY_UNAVAILABLE');
    const row = rows[0];
    const state = {
      maxRoomsPerTenant: integer(row.max_rooms_per_tenant, 1, 10000), maxRooms: integer(row.max_rooms, 1, 1000000),
      maxBytes: integer(row.max_bytes, 1), roomCount: integer(row.room_count), byteCount: integer(row.byte_count)
    };
    if (state.roomCount > state.maxRooms || state.byteCount > state.maxBytes) fail('DEPENDENCY_UNAVAILABLE');
    return state;
  }
  async get(tenantId, roomId) {
    scope(tenantId, roomId);
    return connection(this.#pool, true, async client => {
      // READ COMMITTED takes a fresh statement snapshot after this lock waits.
      // A plain MVCC read could return stale state while an uncertain writer
      // still holds its transaction open and might commit afterward.
      await this.#state(client, 'share');
      const { rows } = await client.query(`SELECT state, revision FROM ${this.#schema}.collaboration_rooms
        WHERE tenant_id = $1 AND room_id = $2`, [tenantId, roomId]);
      if (rows.length > 1) fail('DEPENDENCY_UNAVAILABLE');
      return rows.length ? room(rows[0]) : null;
    });
  }
  async applyUpdate(tenantId, roomId, update) {
    scope(tenantId, roomId);
    const input = copyCollaborationUpdate(update);
    return connection(this.#pool, true, async client => {
      const quotas = await this.#state(client, 'update');
      const current = await client.query(`SELECT state, revision, logical_bytes FROM ${this.#schema}.collaboration_rooms
        WHERE tenant_id = $1 AND room_id = $2 FOR UPDATE`, [tenantId, roomId]);
      if (current.rows.length > 1) fail('DEPENDENCY_UNAVAILABLE');
      const previous = current.rows.length ? room(current.rows[0]) : null;
      const previousBytes = previous ? integer(current.rows[0].logical_bytes, 1) : 0;
      if (previousBytes > quotas.byteCount) fail('DEPENDENCY_UNAVAILABLE');
      if (previous && previousBytes !== previous.state.byteLength + tenantId.length + roomId.length) fail('DEPENDENCY_UNAVAILABLE');
      const merged = await mergeCollaborationState(previous?.state ?? null, input);
      if (previous && !merged.changed) return previous;
      const bytes = merged.state.byteLength + tenantId.length + roomId.length;
      if (bytes > quotas.maxBytes - (quotas.byteCount - previousBytes) || previous?.revision === Number.MAX_SAFE_INTEGER) fail('CAPACITY_EXCEEDED');
      if (!previous) {
        const { rows } = await client.query(`SELECT count(*) AS count FROM ${this.#schema}.collaboration_rooms WHERE tenant_id = $1`, [tenantId]);
        if (integer(rows[0]?.count) >= quotas.maxRoomsPerTenant || quotas.roomCount >= quotas.maxRooms) fail('CAPACITY_EXCEEDED');
        await client.query(`INSERT INTO ${this.#schema}.collaboration_rooms
          (tenant_id, room_id, state, logical_bytes, revision) VALUES ($1, $2, $3, $4, 1)`, [tenantId, roomId, Buffer.from(merged.state), bytes]);
      } else {
        await client.query(`UPDATE ${this.#schema}.collaboration_rooms SET state = $3, logical_bytes = $4,
          revision = revision + 1, updated_at = clock_timestamp() WHERE tenant_id = $1 AND room_id = $2`,
        [tenantId, roomId, Buffer.from(merged.state), bytes]);
      }
      await client.query(`UPDATE ${this.#schema}.collaboration_state SET room_count = room_count + $1,
        byte_count = byte_count + $2 WHERE singleton = true`, [previous ? 0 : 1, bytes - previousBytes]);
      return { state: merged.state, revision: previous ? previous.revision + 1 : 1 };
    });
  }
}
