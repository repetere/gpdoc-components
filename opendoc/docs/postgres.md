# PostgreSQL document store

OpenDoc includes an original, bounded PostgreSQL implementation of the asynchronous document-store port. It stores text and metadata durably, scopes document queries to the server-authenticated tenant, and checks revisions and capacity transactionally across processes. It is a reference adapter, not a production deployment, backup system, document ACL service or cloud provisioning tool.

The adapter receives a caller-owned [node-postgres Pool](https://node-postgres.com/apis/pool). It does not load connection strings from the environment, create a pool, select a database, migrate at startup, retry mutations or close the caller's pool. `pg` is pinned in the package lock. The implementation uses the driver's default `bytea`, `bigint` and timestamp parsers; changing those parsers may make the adapter fail closed.

## Explicit schema provisioning

Provision only a dedicated database and schema you intend OpenDoc to use. Review `migrations/001_document_store.sql` first. Its `__SCHEMA__` placeholder is an identifier substituted by the initializer, not executable standalone SQL or a client input. Do not run this operation automatically whenever a server starts.

```js
import { Pool } from 'pg';
import { initializePostgresSchema } from './src/postgres-store.mjs';

// Supply an explicitly selected administrative database configuration.
// Do not put credentials into source files, documents, profiles or shared logs.
const adminPool = new Pool(adminDatabaseConfiguration);
try {
  await initializePostgresSchema({
    pool: adminPool,
    schema: 'opendoc',
    maxDocumentsPerTenant: 100,
    maxDocuments: 1000,
    maxBytes: 16 * 1024 * 1024
  });
} finally {
  await adminPool.end();
}
```

`initializePostgresSchema` executes one transaction that creates a **new** schema, two tables and a version/capacity state row. The schema name is required, restricted to lowercase ASCII identifiers and quoted. System schemas, `public`, dotted identifiers and SQL fragments are rejected. An existing schema causes rollback, even if it appears to be an earlier OpenDoc schema. The initializer does not drop, overwrite, adopt, repair or upgrade existing objects. There is no upgrade path from a future or unrecognized schema version in this milestone.

Defaults are 100 documents per tenant, 1,000 total documents and 16 MiB of combined ID/title/content logical UTF-8 bytes. Explicit provisioning can set the tenant bound to at most 10,000 and the total count to at most 1,000,000. The byte budget must be a positive JavaScript safe integer. These limits live in the database state row, not in request inputs or per-server constructor options, so all writers use the same limits. They are reference bounds, not full disk, heap, transaction-log, index or storage quotas. JSON escaping and database overhead can require more physical bytes.

Use one schema per OpenDoc service, not per tenant. Select the schema from trusted server configuration. The runtime role needs schema `USAGE`, `SELECT` on both tables, `INSERT`/`UPDATE` on `documents` and `UPDATE` on `store_state`; it does not need schema creation or deletion privileges. Admin provisioning and grants remain an operator responsibility. Do not grant these database permissions to end users or document content. Direct SQL writes, manual counter changes or an untrusted pool can invalidate the adapter's invariants.

## Runtime adapter

```js
import { Pool } from 'pg';
import { PostgresDocumentStore } from './src/postgres-store.mjs';
import { createOpenDocHandler } from './src/api.mjs';

const pool = new Pool(runtimeDatabaseConfiguration);
const store = new PostgresDocumentStore({ pool, schema: 'opendoc' });
const handle = createOpenDocHandler({ store, authenticate: verifiedAuthenticator });

// The host owns graceful HTTP shutdown, then: await pool.end().
```

There is no implicit schema default and construction performs no queries. Every operation checks the schema version and fails closed if the schema is absent, the state is malformed or the version is unsupported. Configure finite connection, query, statement and transaction timeouts in the caller's pool and PostgreSQL deployment. The adapter does not override the host's transport/TLS settings; production connection security and database access controls require a separate review. Prefer a trusted `search_path`, such as `pg_catalog`, because all OpenDoc tables are explicitly schema-qualified.

The port is the same as `MemoryDocumentStore`:

- `list(tenantId)` returns metadata only, in stable bytewise ID order. It returns the **complete bounded tenant list**, not a page. This milestone has no pagination token or query-parameter pagination. It reads at most `maxDocumentsPerTenant + 1` rows and returns `CAPACITY_EXCEEDED` rather than silently truncating if an operator change or out-of-band write puts the tenant above its bound. There is no content column in the listing query.
- `get(tenantId, id)` returns the document or `null` when absent from that tenant.
- `create(tenantId, { id, title, content })` returns revision 1 or `CONFLICT` for an existing ID in that tenant.
- `replace(tenantId, id, expectedRevision, { title, content })` preserves ID/creation time and increments the revision exactly once. A missing tenant/document pair yields `NOT_FOUND`; a stale revision yields `PRECONDITION_FAILED`.

All document reads and writes use tenant parameters, including duplicate checks, count queries and conditional updates. Tenancy comes from the host authenticator, not the profile, document body or a client-selected schema. Tenant authorization remains application-enforced; this adapter does not claim PostgreSQL row-level security or protection against a malicious database administrator.

## Transaction, preservation and failure behavior

Every create/replace transaction takes a row lock on the schema-wide state record before checking quotas or mutating documents. That lock serializes writers across pools and processes. Replacements also lock the current document and put the tenant, ID and expected revision in the SQL update predicate. Document bytes, revision and counters commit together. Transaction isolation is explicitly `READ COMMITTED`, so a waiting writer rechecks the committed state after obtaining the lock. This simple global lock is deliberately conservative and can limit throughput; it is not a scalable collaboration sequencer.

Title and content are stored as JSON-encoded strings in `bytea`, preserving every string accepted by the API, including CRLF, emoji, NUL and lone UTF-16 surrogates. PostgreSQL `text`/`jsonb` cannot represent all of those cases losslessly. The adapter never normalizes, renders, executes or fetches document content. The logical byte budget matches the memory store's UTF-8 accounting, including JavaScript's replacement-byte treatment of lone surrogates.

Database and connection errors become `StoreError('DEPENDENCY_UNAVAILABLE')` without the driver's message, query, parameters, credentials or cause. Known document/capacity failures retain their narrow `StoreError` code. An unsuccessful transaction is rolled back; a failed rollback removes the connection from the pool. A transport failure during commit can leave the outcome unknown. **No mutation is automatically retried**: read the document and reconcile before deciding what to do. This milestone does not provide idempotency keys or revision history, only the current document and monotonic revision number. The HTTP API continues to map capacity failures to 429 and unavailable dependencies to 503.

## Tests and safety boundary

`test/postgres.test.mjs` uses a scripted Pool to test query contracts, failure sanitization and rollback handling. Those tests are not evidence that SQL runs on a real database.

`integration/postgres.test.mjs` runs actual PostgreSQL queries only after explicit opt-in:

```sh
npm ci --ignore-scripts
OPENDOC_PG_INTEGRATION=1 \
DATABASE_URL='postgres://opendoc_test:synthetic-test-only@127.0.0.1:5432/opendoc_test' \
node --test integration/postgres.test.mjs
```

Create the local synthetic `opendoc_test` database/role separately. The harness does not create or drop databases or roles. Its URL guard requires loopback, the exact database/role/password shown above, no query parameters and no fragments. A different local port is allowed. `localhost` is pinned to `127.0.0.1`, not resolved to an arbitrary host. Ambient PostgreSQL variables cannot replace the explicitly supplied connection target. Never repurpose these synthetic credentials for real data or expose this test database publicly.

After connecting, the harness verifies the database, role and server loopback address **before schema creation**. Each run creates randomly named, isolated schemas and tracks only those it successfully creates. Cleanup drops its two known tables and the exact owned schema without `CASCADE`. It never sweeps a name prefix or modifies pre-existing objects. An interrupted process can leave an isolated synthetic schema behind; inspect ownership and contents before manual cleanup.

The real integration suite covers:

- Independent PostgreSQL backend connections and persistence across new pools and a separate Node process.
- Cross-tenant equal IDs, metadata-only bounded lists and opaque string preservation.
- Concurrent create conflicts and repeated two-writer compare-and-swap races.
- Global/per-tenant document limits and global byte capacity under concurrent writers.
- Replacement byte-accounting rollback, revision overflow and explicit listing overflow.
- Missing/future schema refusal, refused reinitialization and standard HTTP API/error behavior.

`npm run test:postgres` also runs the composed real HTTP/access-token/PostgreSQL scenario in `integration/service.test.mjs`, including denied membership, ID-token rejection, tenant isolation, service/pool restart and a concurrent HTTP update conflict. Its target is restricted to the same synthetic credentials and explicit `127.0.0.1` loopback host.

Local validation used PostgreSQL 17.11 and `pg` 8.23.1. This demonstrates persistence across application-process restarts, **not** database crash recovery, power-loss durability, backup/restore, HA failover or any particular cloud environment. Connection-level and query-contract tests complement each other; neither proves production readiness. There is no OIDC/Ping login, object storage, live collaboration or air-gap acceptance claim in this adapter.
