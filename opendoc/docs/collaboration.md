# Experimental authenticated Yjs collaboration

OpenDoc has an original, bounded reference WebSocket transport and PostgreSQL
Yjs-state store. This is an **experimental building block**, not a production
collaboration service or a complete collaborative editor. It uses a small custom
protocol, `opendoc-yjs-1`; it is **not compatible with stock y-websocket clients**.
Yjs and ws are pinned MIT dependencies. No cloud service is required.

## Scope and data boundary

Collaboration rooms are addressed by `/api/v1/collaboration/{roomId}`. A room ID
is 1–64 ASCII letters, digits, underscores or hyphens, beginning with a letter or
digit. The verified server-side principal supplies the tenant; clients cannot
supply a tenant, role or principal in the protocol. Keys are `(tenantId, roomId)`.

A room stores a Yjs V1 binary state, not the REST document's title/content JSON.
REST documents and collaboration rooms have **separate storage and revisions**.
Using the same ID does not connect them. There is no automatic conversion,
dual-write, import/export or cross-format conflict resolution. Applications must
choose an authoritative format before adding those features. No rich-document
schema or editor binding is implied by the room transport.

Owner/editor roles may submit updates. Viewer/commenter roles may read only.
The reference authorization model grants access to every room in the verified
tenant. Per-room sharing and ACLs, comment operations, presence and awareness
are not implemented. A random room ID is not an authorization mechanism.

## Server wiring

```js
import { attachCollaborationServer } from '../src/collaboration-server.mjs';
import { PostgresCollaborationStore } from '../src/collaboration-store.mjs';

const collaboration = attachCollaborationServer({
  server: httpsServer, // Explicit caller-owned HTTPS server; no implicit listener.
  store: new PostgresCollaborationStore({ pool, schema: 'opendoc_collaboration' }),
  authenticate, // The same trusted access-token/membership resolver used by REST.
  allowedOrigins: ['https://editor.example.test']
});

// Stop upgrades/sockets, then drain caller-owned database work separately.
await collaboration.close();
```

Provision a **fresh, separate collaboration schema** as an explicit, one-time
administrative step. This does not extend or reuse the REST document schema:

```js
import { initializePostgresCollaborationSchema } from '../src/collaboration-store.mjs';

await initializePostgresCollaborationSchema({
  pool: adminPool,
  schema: 'opendoc_collaboration',
  maxRoomsPerTenant: 100,
  maxRooms: 1000,
  maxBytes: 16 * 1024 * 1024
});
```

Review `migrations/002_collaboration_store.sql` first. Its `__SCHEMA__`
placeholder is validated and quoted by the initializer; it is not executable
standalone SQL. The initializer creates a fresh schema, `collaboration_rooms`
and `collaboration_state` tables and the schema/version/quota record in one
transaction. It refuses existing schemas, including REST-store schemas. It does
not upgrade, overwrite, repair or adopt existing tables. Never run it implicitly
at service startup. The adapter receives a caller-owned pg Pool and never
selects a database, creates/closes a pool or loads credentials from the
environment. Schema names must be explicit, non-system lowercase identifiers.

Defaults are 100 rooms per tenant, 1,000 rooms total and 16 MiB of logical state
plus scope-identifier bytes. Administrative provisioning permits a per-tenant
limit up to 10,000 and total limit up to 1,000,000. The quotas are persisted in
the schema-wide state row, not supplied by clients or per-server configuration.
These counters do not cap PostgreSQL indexes, WAL, temporary files or physical
disk use. A schema-wide row lock serializes writers before room-state merge;
this prioritizes atomic quotas/correctness, not high write throughput. Reads
take a shared lock on that same row inside a READ COMMITTED transaction before
reading a room. This barrier waits for an outstanding writer to commit or roll
back, even if its database connection already reported an error, so a reconnect
does not read an old snapshot ahead of an unresolved commit. Concurrent reads
may share the lock, but readers and writers can delay each other. A
commit-response failure can have an unknown outcome, so the adapter never
silently retries a mutation.

The runtime database role needs schema `USAGE`, `SELECT` on both tables,
`INSERT`/`UPDATE` on `collaboration_rooms` and `UPDATE` on `collaboration_state`.
Schema creation/deletion privileges are not required at runtime. Grants and
administrative credentials remain operator-owned; never grant table write
access to document users. Direct SQL writes or manually changed counters can
invalidate store invariants. Configure finite pool connection/admission, query,
statement and idle-transaction timeouts, reviewed database TLS and a trusted
search path. Tenancy is application-enforced, not a claim of PostgreSQL row-level
security against a malicious application or database administrator.

A custom store must implement async `get(tenantId, roomId)` returning `null` or
`{ state: Uint8Array, revision: number }`, and async
`applyUpdate(tenantId, roomId, update)` returning the full committed snapshot.
The store must enforce tenant isolation, validate untrusted Yjs updates and merge
atomically. Reads must wait behind previously admitted, unresolved writes, not
return an older MVCC snapshot while an uncertain commit is still running. Only
`BAD_REQUEST`, `TOO_LARGE` and `CAPACITY_EXCEEDED` may report definite rejection
with no state change; all other mutation failures require room resynchronization.
The transport does not make an unsafe custom store safe.

The transport owns the server's WebSocket upgrade route handling and rejects
other upgrade paths. Do not attach a second competing upgrade handler to the
same server. Normal HTTP routes may coexist. Production deployments must supply
TLS, trusted proxy configuration, request/header timeouts, connection/rate
limits, database timeouts, monitoring and a reviewed authentication system.

`startLocalCollaborationServer({ store, authenticate, allowedOrigins, port: 0 })`
is a testing/development convenience. It only binds `127.0.0.1`, returns
`{ url, stats, close }`, and has no public bind option. Append the room path to
its `ws://127.0.0.1:<port>` URL. `close()` is idempotent. Transport shutdown stops
new upgrades and disconnects sockets but **does not drain already-started
persistence operations**. Operators must let caller-owned database work settle
or explicitly abort/roll it back before pool/process teardown. Reconnecting
clients must read/replay writes whose acknowledgment was lost; a disconnect does
not establish rollback. `stats()` exposes bounded resource counts, never tokens,
principals or document content.

## Authentication and browser origins

The first WebSocket message must be a UTF-8 text frame containing exactly:

```json
{"type":"authenticate","token":"ACCESS_TOKEN"}
```

No query tokens, token-bearing URLs, authorization headers, subprotocols,
client tenant fields or extra JSON fields are accepted. Browser WebSockets
cannot set an Authorization header, which is why the first frame carries the
token. Use `wss://` outside loopback. Browser-generated cookies may be present
but are ignored, never forwarded to the authenticator and never sufficient to
sign in. Do not log incoming frames or credentials.

The server creates a clean `Request` with `Authorization: Bearer <token>` and the
exact collaboration path, then invokes the injected authenticator. It forwards
only that authorization and the verified allowed Origin, not ambient browser
cookies or arbitrary handshake headers. The existing access-token adapter
checks pinned local keys, issuer, audience, access-token type, lifetime and
trusted current membership. Token acquisition/login UI is outside this module.

An explicit origin allowlist is required. Entries must be exact HTTPS origins,
or HTTP loopback origins for local testing. Foreign, `null`, empty and duplicate
Origins are rejected. Missing Origin is rejected by default. Setting
`allowMissingOrigin: true` deliberately permits trusted native clients without
an Origin; it does not permit an explicitly empty Origin. Origin is an additional
browser protection, not a substitute for authentication.

Credentials and current membership are revalidated before every room read,
before every edit and independently for every outbound snapshot recipient.
Membership is checked again after a database read. Principal or tenant changes
on an existing connection close it; reconnect under the new identity. Idle
connections start revalidation every 30 seconds by default. Idle expiry/revocation
closure also depends on authenticator latency, up to the dependency timeout; it
is not an absolute 30-second revocation guarantee. A reader revoked before fanout
receives no new snapshot. Resolver failures close access rather than using stale cached
permissions. Applications must supply a resolver that actually checks current
trusted membership on every call. These checks do not promise a distributed,
transactional authorization barrier across a simultaneous membership change.

## Exact wire protocol

After successful authentication and the first authorized database read, the
server sends:

```json
{"type":"ready","protocol":"opendoc-yjs-1","role":"editor"}
```

It then sends a binary full-state frame. There is no document data before
successful authentication.

- Client binary update: one byte `0x01`, followed by a Yjs V1 update.
- Server binary state: one byte `0x02`, then an unsigned 64-bit big-endian
  revision (8 bytes), then a complete Yjs V1 state update.
- Revisions must be non-negative JavaScript safe integers. An absent room is
  represented by revision `0` and the empty Yjs update bytes `[0, 0]`.
- After authentication, the only accepted text message is exactly
  `{"type":"sync"}`. It requests an authorized current full snapshot.
- The first valid non-empty edit may create a room. An empty initial update is
  rejected by the durable store. Replaying an already-applied update does not
  advance the stored revision.
- The sender also receives the committed full state, which acknowledges the
  persisted revision. Full-state broadcasts are intentionally simple and bounded,
  not an optimized state-vector/awareness protocol.
- Text messages with unknown fields/types, malformed frames, or a second
  authentication message close the connection. Token refresh requires reconnect.

Within one transport instance, initial joins, reads and writes share one bounded
room queue. A join cannot miss an update while fetching its initial snapshot.
The server waits for persistence to commit before broadcasting. Failed writes
are not broadcast. Dependency failures, unknown mutation errors and malformed
post-write results are treated as ambiguous commits and disconnect all current
room clients for resync. Definite rejected/rolled-back `BAD_REQUEST`, `TOO_LARGE`
and `CAPACITY_EXCEEDED` store outcomes close only the offending client. A mutation
timeout also has an uncertain outcome: every current
room client is disconnected with `Room resync required.`, and the room remains
fenced until the actual operation settles. Reconnect then reads durable state;
never assume a timeout proves an edit was rolled back. A timed-out dependency
keeps its admission slot until it actually settles, so abandoned promises cannot
grow without bound.

## Client helper and reconnect

`src/collaboration-client.mjs` exports `encodeUpdateFrame`, `decodeStateFrame`
and `connectCollaboration` for browser bundlers or Node tests:

```js
import * as Y from 'yjs';
import { connectCollaboration } from '../src/collaboration-client.mjs';

const doc = new Y.Doc();
const session = await connectCollaboration({
  url: 'wss://docs.example.test/api/v1/collaboration/example',
  token: accessToken,
  doc,
  onError: error => showConnectionProblem(error.message)
});

// Edit through an application-owned editor binding to doc.
// The promise resolves after initial sync, not after every local edit commits.
console.log(session.role, session.revision);
session.sync(); // Explicit current-state read.
session.close();
```

For reconnect, call `connectCollaboration` again with a fresh credential and the
**same Y.Doc**. It applies the server snapshot and submits the local difference,
so retained offline edits can merge with other clients' intervening edits. It
does not recreate a new document or overwrite remote state with plaintext.

The helper does not automatically retry, refresh credentials, save an offline
queue to disk, split oversized replays, bind editor UI or provide a conflict UI.
Every initial or reconnect replay must fit the 64 KiB update cap, even though a
server snapshot may be 1 MiB. An oversized offline replay fails visibly; the
caller's Y.Doc retains its data.
A viewer helper does not transmit local changes, but it cannot make an editor
read-only: applications must disable editing based on the returned role. Keep
local-only viewer edits out of a later editor session unless their replay is
intended. Concurrent sessions for the same Y.Doc are not a supported lifecycle.
Use the error hook to make disconnects visible and arrange explicit reconnect.

## Resource limits

Defaults below may only be tightened using the server `limits` option:

| Resource | Default maximum |
| --- | --- |
| Connections, including unauthenticated sockets | 128 |
| Joined connections per room | 32 |
| Active/queued rooms | 128 |
| Pending operations per connection | 8 |
| Pending operations across transport | 128 |
| In-flight dependency operations, including timed-out operations | 128 |
| Outbound buffered bytes per connection | 2 MiB |
| Token bytes | 8,192 |
| First authentication deadline | 5 seconds |
| Dependency operation deadline | 5 seconds |
| Idle credential/membership revalidation interval | 30 seconds |
| Forced close grace | 500 ms |

A client update is at most **64 KiB** of Yjs bytes plus its one-byte header.
Persisted Yjs state is at most **1 MiB**, and a state frame adds 9 bytes. No
WebSocket compression is enabled. The pending-count caps also bound retained
inbound frames. Slow consumers are disconnected before exceeding the outbound
buffer limit. Idle, empty room queue entries are removed.

The durable store also limits Yjs structure counts, nesting, pending dependency
bytes, historical client IDs, aggregate clock lengths and persisted rooms/bytes, and isolates
untrusted decoding in bounded disposable workers. See its implementation and
store tests for the exact caps. The 128 Yjs client-ID cap counts historical IDs
retained in room history, not concurrent connections. A room may eventually hit
that or another history limit; automatic rollover/migration is not provided.
The 1,048,576 aggregate struct-clock limit includes retained history/tombstones;
deleting visible text does not reset it. There is no reset/delete API in this
milestone.
These limits are not a general hostile-code sandbox. Process/container CPU and
memory limits, database pool admission, physical database size, backups, high
availability and abuse/rate controls remain operator responsibilities.

Close codes are sanitized: `1008` invalid message/access, `1009` oversized
message, `1011` dependency/connection failure or required resync, `1013` capacity
or slow consumer, and `1001` server shutdown. Unexpected disconnects can appear
as `1006` to a peer. No exception detail, credential or document content is put
in a close reason.

## Proven behavior and remaining work

Real loopback WebSocket tests cover two-client convergence, concurrent edits,
explicit reconnect/offline replay, viewer/commenter write rejection, tenant
isolation, authentication/Origin/frame validation, revoked-reader fanout,
join races, persistence-before-broadcast, late-commit resync, resource limits
and cleanup. These transport unit tests use an in-memory fixture; that fixture
is **not** evidence of durable storage.

The separate PostgreSQL integration suite exercises actual PostgreSQL,
cryptographically signed access tokens, two independent network clients,
duplicate replay, tenant/room separation, credential expiry, membership
revocation, reconnect and server/database-pool restart against the durable store.
Store tests also exercise separate Node-process restart, atomic quota races,
pending causal updates, lost COMMIT replies and read barriers against unresolved
transactions.
Run `npm run test:postgres` with the [documented disposable database setup](postgres.md#tests-and-safety-boundary); unit
mocks alone do not establish these claims. A service/pool restart is not a
power-loss or database crash-recovery test.

PostgreSQL merges are atomic across writers, but room fanout exists in only one
process. **Cross-instance live fanout is unsupported.** Do not split a room over
multiple transport instances, perform out-of-band room writes or run multiple
replicas and assume viewers will converge live. A reviewed shared event system,
replay/resync protocol and multi-instance testing are future work. Other future
work includes room ACLs/sharing, editor schema/binding, awareness, durable client
offline queues, distributed backpressure, migrations and operational recovery,
observability, load/security audits, TLS/proxy deployment and packaged browser
end-to-end tests. No air-gap certification or production-readiness claim follows
from these tests.
