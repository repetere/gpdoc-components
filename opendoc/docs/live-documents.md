# Live documents: one Yjs authority

This opt-in reference collection connects the authenticated editor to durable Yjs
collaboration. It is a separate resource from both REST documents and standalone
collaboration rooms. Equal IDs in the three collections do not link their data.
There is no automatic migration, snapshot replacement endpoint, REST-to-Yjs copy,
or background mirroring. An operator must explicitly compose and serve the API,
WebSocket transport and authentication adapters.

## Data model and routes

Each live document has a stable, caller-chosen `id`, a tenant scope resolved by the
server, and exactly two plain-text Yjs roots:

- `doc.getText('title')`: at most 200 UTF-16 code units.
- `doc.getText('content')`: at most 256 KiB encoded as UTF-8.

Creation requires well-formed Unicode strings. NUL, CRLF and non-ASCII text are
supported. Lone UTF-16 surrogates are rejected instead of being silently replaced
by Yjs UTF-8 encoding. Editors must preserve surrogate-pair boundaries in text
splices. HTML, Markdown or other markup in content is opaque plain text, not rich
Yjs formatting. Maps, arrays, embeds, formatting attributes, nested XML/types, subdocuments
and additional root names are rejected. Wire-equivalent plain text is validated
by its decoded content, not by a client-side constructor name.

`createOpenDocHandler({ store, liveStore, authenticate, allowedOrigins })` adds:

| Request | Result |
| --- | --- |
| `POST /api/v1/live-documents` with exactly `{id,title,content}` | Creates a new document and returns its projection with status 201 and `Location`. |
| `GET /api/v1/live-documents` | `{documents:[...]}` with metadata/title summaries, without content or binary state. |
| `GET /api/v1/live-documents/:id` | The current committed text projection; missing or other-tenant IDs return 404. |

A full projection is `{id,title,content,revision,createdAt,updatedAt,authority:'yjs'}`.
Revision starts at 1, changes when canonical Yjs state changes, and does not grow
on an identical replay. It is a server persistence revision, not a text version or
an HTTP conditional-write token. Projections intentionally have no ETag.
`PUT`, `PATCH`, and `DELETE` are not implemented for live documents. The only edit
operation is an authenticated Yjs update, never a submitted replacement snapshot.
The binary Yjs state is returned only through the collaboration protocol.

Owner and editor tenant roles may create/edit. Viewer and commenter roles may
list/read/join; they cannot send Yjs mutations. Roles apply to all live documents
in the verified tenant. Per-document sharing is not implemented. Client fields
cannot select a tenant, principal or role. Origins use the existing explicit
allowlist, and HTTP bodies are bounded before JSON parsing.

The original `/api/v1/documents` routes, `If-Match` semantics and stores are
unchanged. The original `/api/v1/collaboration/:roomId` endpoint remains the
independent `opendoc-yjs-1` protocol. No caller should derive a live document from
either collection by ID alone.

Capabilities include optional `liveDocuments` metadata naming the collection,
protocol, storage kind, and `requiresWebSocketHost:true`. The existing REST
`features.liveCollaboration` remains false: injecting a store into an HTTP handler
does not prove a WebSocket listener or proxy is attached and reachable. The editor
must authenticate and receive the first durable state before declaring it ready.

## Explicit composition

Use `MemoryLiveDocumentStore` for a bounded, ephemeral local demonstration. A
process exit loses its documents. Use `PostgresLiveDocumentStore` for persistence.
Both implement `list(tenantId)`, `get(tenantId,id)`, `create(tenantId,input)`, and
`applyUpdate(tenantId,id,bytes)`. They intentionally have no replacement method.
`get` returns detached state bytes plus the text projection; reads never allocate.
The store is a trusted internal adapter; authentication belongs to the API and
transport, not to a client-supplied tenant value passed directly to the store.

```js
import { createOpenDocHandler } from './src/api.mjs';
import { attachCollaborationServer } from './src/collaboration-server.mjs';
import { PostgresLiveDocumentStore } from './src/live-document-store.mjs';

const liveStore = new PostgresLiveDocumentStore({ pool, schema: 'my_live_documents' });
const handle = createOpenDocHandler({
  store: restStore, liveStore, authenticate: authenticateHttp,
  allowedOrigins: ['https://editor.example.test']
});
// Serve `handle` on the explicitly owned HTTP(S) server with the web/auth adapter.
const transport = attachCollaborationServer({
  server, liveStore, authenticate: authenticateSocket,
  allowedOrigins: ['https://editor.example.test']
});
// Optional `store: standaloneCollaborationStore` also enables the separate v1 route.
```

The same `liveStore` authority must back the HTTP collection and WebSocket route.
Do not attach two competing upgrade handlers for the same server. Authentication
adapters, connection pools, TLS, origins, proxy upgrades and HTTP request handling
are caller-owned. The local helper binds only `127.0.0.1`.

For browser sessions, obtain a narrowly scoped, short-lived ticket with
`POST /auth/collaboration-ticket` and exactly `{documentId:'the-id'}`. Use the
returned exact live-document WebSocket path and send the ticket in the first JSON
frame. The ticket is bound to its document target, current session and one
server-owned connection ID. It cannot be used for another live document or a
standalone room. The prior `{roomId}` request remains standalone-only. See
[browser login](browser-login.md) and [shared sessions](shared-sessions.md) for
session authentication, expiry and ticket replay restrictions.

## Live wire protocol and saved status

Connect to `/api/v1/live-documents/:id/collaboration` on the same explicitly
configured server. Query strings, ambient authorization headers, subprotocol
credentials and non-allowlisted origins are rejected. Cookie-only WebSocket
upgrades do not authenticate a client.

1. Client sends text JSON `{type:'authenticate',token:'...'}`.
2. Server verifies current membership, reads the existing durable document, and
   verifies membership again. A missing document closes with policy error before
   emitting any `ready` or state frame.
3. Server sends `{type:'ready',protocol:'opendoc-yjs-2',role:'editor'}` (or the actual
   verified role), followed by a committed state frame.
4. A state frame has byte `2`, an unsigned big-endian 64-bit revision, and a Yjs v1
   binary update. The revision must fit a JavaScript safe integer.
5. Each client mutation frame has byte `3`, an unsigned big-endian **32-bit**
   sequence number, then the Yjs v1 update. Start at 1 and increment exactly once
   per frame on that connection. Zero, skipped, repeated or exhausted sequences
   are rejected. A reconnect starts a new sequence at 1.
6. The server serializes the room, checks current write permission, merges and
   validates the update, commits it, then sends the committed state to currently
   authorized room members. Only afterward does it send the original sender
   `{type:'ack',sequence:1,revision:2}` after another permission check.

The explicit sequence acknowledgement covers deletion-only updates. A server
state vector alone cannot prove that a delete set was committed. A state frame
received because another collaborator saved is not an acknowledgement of the
client's own edit. Keep unsent/unacknowledged work marked pending. The bundled
live client retains the same in-memory Y.Doc on reconnect, merges the first
server state without emitting a premature write, and replays retained state with
a new connection sequence. It waits for the corresponding acknowledgement before
calling that replay saved. Never seed a newly connected Y.Doc by inserting text
from the HTTP projection; that creates unrelated CRDT operations and duplicates.

Text `{type:'sync'}` requests a fresh committed snapshot. Missing dependencies and
delete sets are preserved inside the bounded canonical state. A string-only
causal fragment can omit its root name while awaiting an unknown ancestor; it may
be retained but is not projected until validated dependencies arrive. Explicitly
forbidden roots/types are rejected even when deleted or pending.

Every write is acknowledged only after the store reports its durable outcome.
Timeouts or other ambiguous storage results force every connected room member to
reconnect; the room is fenced until a still-running store call settles. An
uncertain commit is never blindly retried inside the store. Yjs replay on a later
connection is idempotent whether that earlier commit succeeded or rolled back.
Definite invalid, oversized, quota-exceeded or missing-document mutations do not
produce an acknowledgement. Network failure can still lose a valid ack: retain
the Y.Doc and reconnect rather than assuming data loss or inventing success.

## PostgreSQL provisioning and durability

Administratively bootstrap a **fresh, separate, non-system** schema with
`initializePostgresLiveDocumentSchema({pool,schema,...limits})`. It uses
`migrations/005_live_documents.sql` and refuses existing schemas. Constructors do
not connect, migrate, reuse schemas, or drop data. It is not an upgrade of REST
or standalone collaboration schemas; no existing installation needs migration to
keep its old routes working. The caller owns and closes its pool.

The `live_documents` row stores authoritative Yjs bytes and derived title/content
JSON-byte projections atomically. JSON bytea preserves NUL without PostgreSQL
text conversion. A schema-wide quota row is locked before mutation; all writers,
including independent processes/pools, merge the latest document under that lock.
A read takes a shared quota-row lock before selecting, so it waits for an
unresolved writer instead of exposing an earlier MVCC state as current. A full
read validates state and projection consistency in the bounded worker before the
transport can announce ready. Lost `BEGIN` or `COMMIT` responses trigger rollback
cleanup; failed rollback discards the pooled connection. Driver details are not
included in client errors.

Defaults are 100 documents per tenant, 1,000 documents total, and 16 MiB logical
bytes per namespace. Logical bytes count the Yjs state, ASCII scope identifiers,
and serialized title/content projections, not indexes/WAL/backups or physical
PostgreSQL size. All three limits are atomic. Configure separate physical storage
and history-retention budgets. There is no delete, compaction, history reset,
backup/restore UI or general migration tool in this milestone.

Durable multi-process writes are tested, but live fanout is **single-process**.
There is no Redis, LISTEN/NOTIFY, distributed room registry or cross-node event
bus. Use one active collaboration process per live namespace, or explicitly
request sync/reconnect to read changes committed elsewhere. Do not claim automatic
cross-node convergence from PostgreSQL storage alone. Shared login sessions do
not change this transport constraint.

## Parsing and resource limits

Live input updates and canonical snapshots are at most 1 MiB. The larger live
update bound permits full retained-state reconnect replay; standalone v1 updates
remain limited to 64 KiB. Incremental editing is subject to the same total
snapshot bound, which includes deletion/history data. Exceeding the limit rejects
the mutation, preserves the prior committed state, and must leave local edits
visibly unsaved.

All untrusted Yjs decoding/merging, including persisted-state validation, runs in
short-lived workers. The existing client/struct/clock/nesting/pending-state limits
still apply, along with four concurrent workers and a two-second worker timeout.
Live structs accept only plain text or deleted-content representations. There is
no off-thread promise backlog: saturated worker admission fails closed. Memory
store operations are additionally bounded to 128 pending operations.

WebSocket connections, pending operations, authentication, dependency timeouts and
buffered output use the existing tightened-only transport limits. Deployments
also need connection/rate limits, CPU/memory limits, PostgreSQL statement and
idle-transaction timeouts, pool limits, TLS and an upgrade-capable proxy. V8 worker
heap settings do not bound every native allocation; this is not a hostile-code
sandbox or an unbounded general collaboration platform.

## Verification

Run `npm test` for memory, API, schema and real loopback WebSocket tests. The live
cases cover creation/reopen, no REST overwrite, tenants/roles, empty and NUL text,
Unicode limits, malicious Yjs schema, causal pending state, concurrent edits,
delete-only ACKs, persistence-before-ack, ambiguous commits and reconnect.

The opted-in `npm run test:postgres` suite includes
`integration/live-document.test.mjs`. It refuses non-synthetic or non-loopback
targets and tests fresh-pool persistence, independent-pool merges, quota races,
exact accounting, rollback, lost COMMIT response replay, server-confirmed read
fences, and a network edit followed by HTTP projection read. Use only the documented
synthetic local test database, never an ambient production `DATABASE_URL`.
