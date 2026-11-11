# Shared live-document collaboration

OpenDoc v0.8 adds an **explicitly enabled, bounded polling mode** for live-document
WebSockets connected to the same authoritative PostgreSQL primary and schema.
An edit committed through one process can reach already-connected readers in
another process without a manual sync or reconnect. It is an experimental
reference transport, not a production availability or database failover system.

The independent REST document collection and standalone `opendoc-yjs-1` rooms
keep their existing behavior. The live `opendoc-yjs-2` wire protocol does not
change. Without this option, live fanout remains process-local.

## Compose each instance explicitly

```js
import { PostgresLiveDocumentStore } from '../src/live-document-store.mjs';
import { attachCollaborationServer } from '../src/collaboration-server.mjs';

// Each process owns its pool. Every pool must target the SAME fixed primary
// and SAME live-document schema, with the same immutable revision history.
const liveStore = new PostgresLiveDocumentStore({
  pool,
  schema: 'my_live_documents'
});
const collaboration = attachCollaborationServer({
  server,
  liveStore,
  authenticate: authenticateSocket,
  allowedOrigins: ['https://editor.example.test'],
  sharedLiveSync: { intervalMs: 1000 }
});
```

Use this same live authority in that instance's HTTP live-document handler.
There is no new schema or migration. Existing live namespaces can opt in by
updating the transport composition. Authentication, current tenant membership,
shared browser sessions/tickets, TLS, origins, pool limits and proxy upgrades
remain operator-owned. See [live documents](live-documents.md) and
[shared sessions](shared-sessions.md) for those contracts.

`sharedLiveSync` must be a plain object containing only the optional `intervalMs`
key. `{}` selects 1,000 ms. A supplied interval must be a safe integer between
50 and 30,000 ms. Omit the option to disable it; `false`, `null`, unknown keys and
invalid intervals are rejected. The option requires the trusted adapter kind
`postgresql-live-documents` and its `getIfChanged` method. Memory stores cannot
opt in. The same option works with the loopback-only server helper.

This adapter check catches accidental composition mistakes, not malicious or
incorrect operator code. Spoofing a kind marker does not establish PostgreSQL
semantics or shared authority.

## One fixed authority, not database failover

All participating instances must use the same fixed primary and schema. Do not
route reads to replicas, dynamically switch pool targets or schema aliases,
restore an earlier database behind running connections, replace revision
history, edit stored state out of band, or fall back to an independent memory
store. A second writable server or cloned database is a separate authority even
when its schema, document IDs and revisions match.

The store's shared quota-row locks fence reads behind pending application
transactions and PostgreSQL rejects those locking reads on read-only replicas.
Those properties do **not** discover a competing writable primary or prevent
split brain. No Redis, LISTEN/NOTIFY, distributed cache, room registry, leader
election, write lease, failover protocol or multi-primary reconciliation is
implemented. Operators remain responsible for database availability, backups,
restoration procedures and fencing any authority changes. No automatic authority
change is supported by this mode.

Revisions are immutable history: changing canonical Yjs bytes advances the
revision, while an identical replay preserves it. Unchanged polls read revision
metadata without decoding the full state. Therefore an equal revision alone
cannot reveal an out-of-band byte change or another database with the same
revision. When a full state is returned, the transport rejects a lower revision
or different bytes for an already observed revision. This is an observed-history
sanity check, not failover or fork detection.

Observed-history checks apply only during an active room's lifetime. Retiring
that room or restarting the process discards its floor; reconnect can establish
a different baseline. Closing code 1011 is not permanent quarantine, rollback
detection across reconnects, or authorization to restore data. Operators must
stop clients and processes and validate the authority before restoring or
changing history. Persistent authority epochs and recovery fencing are future
work; this mode must not be used as a substitute for them.

## Ordering, acknowledgements and authorization

Each process still owns its local room queue. Joins, explicit syncs, mutations,
periodic reads and their state delivery run through that queue. A slow poll
cannot finish after a newer local write and send an older snapshot behind its
acknowledgement. An external commit after a read is picked up by a later pass.

The room records its immutable tenant, document and adapter identity. It keeps
the highest observed authority revision and a bounded digest of those bytes.
Each socket tracks the last state revision sent to it. Polls start from the
lowest delivered revision among open room members, not merely the newest room
observation. Consequently a joining client or explicit sync that sees a newer
revision cannot leave older idle viewers behind an advanced polling floor.
All returned snapshots are checked against the highest observed room revision.

Automatic state delivery skips an equal revision already sent to that receiver.
The first snapshot and an explicit `{type:'sync'}` request still return state.
A no-op mutation still receives its own sequence acknowledgement after storage
confirms the result, even when no new payload is needed. A remote commit, an
unchanged poll or a state frame never creates an acknowledgement for a local
edit. Delete-only and causal-pending changes propagate when canonical state and
revision change, whether or not projected text or a state vector changes.

Every receiving socket is independently reauthorized after awaited storage reads
and immediately before data delivery. The writer is reauthorized again before
its explicit ACK. Changing principal or tenant ends that socket; no new identity
is silently adopted. Viewer/commenter roles remain read-only. As in the existing
protocol, `ready` reports the role at handshake, not a continuously pushed role
update. A later attempted write is checked against the current role and denied
if it is no longer permitted. Unchanged polls emit no data; the existing idle
reauthorization timer continues to check otherwise idle sockets.

Revocation is not atomic cancellation of an in-flight document write. Access is
checked before submitting the mutation and again before sending state or its ACK,
but membership and document commits are not one transaction. A write already
authorized and submitted can still commit if access is revoked while storage is
pending; other authorized readers may receive that committed change. The revoked
socket receives no new protected output after the next access check denies it.
Applications requiring revocation to cancel admitted writes need an additional
transactional authorization/fencing design, not just this polling option.

## Bounded polling and lifecycle

The interval is a delay **between completed passes**, not a freshness deadline.
One pass snapshots the bounded active-room set, then queues at most one room
poll at a time. Rooms already running or waiting on local work are skipped for
that pass, so an unresolved mutation fence cannot block unrelated rooms. There
are no overlapping passes, missed-interval catch-up tasks or unbounded poll
promises. A read plus per-receiver authorization shares the
existing transport dependency limit. A queued/active poll also counts toward
`pendingOperations`; saturated global operation admission defers polling to a
later pass. Existing room, connection, per-room connection, output-buffer and
dependency timeouts still apply and can only be tightened.

Pending local operations defer their room until a later pass. A full pass also
takes time for database reads, validation workers and authorization. Many rooms or slow adapters can therefore
increase propagation latency well beyond `intervalMs`. Sustained operation
admission pressure can defer later rooms repeatedly; the scheduler is not a
fairness or bounded-staleness guarantee. This mode promises no fixed latency
under overload or failures. There are no reads for empty rooms.
Rooms retire once their clients and queued operations have gone away.

A timed-out dependency retains its admission slot until the underlying call
actually settles. A poll failure, missing document, invalid snapshot or observed
revision regression closes that process's affected room with code 1011 and
`Room resync required.` Late read results cannot be sent. Ambiguous mutations
retain the existing stronger room fence until their actual commit/rollback
settles; they never produce a speculative ACK. Other processes enforce their
own read fences and checks rather than receiving a trusted cross-node error
message.

Shutdown clears the scheduler, rejects new connections and suppresses late
state/ACK delivery and rescheduling. `close()` does not wait forever for an
uncooperative external adapter. JavaScript timeout races do not cancel an already
running database query: operators must configure PostgreSQL statement and
idle-transaction timeouts, pool capacity and connection cleanup. The caller owns
and closes each pool. No transport timeout is proof that a mutation rolled back.
Clients must preserve unacknowledged state and explicitly resync/reconnect using
the existing bounded recovery behavior.

## Store contract

`PostgresLiveDocumentStore.getIfChanged(tenantId, documentId, revision)` accepts a
positive safe revision previously observed for that scoped document. It uses the
same shared quota-row transaction fence as `get`:

- Return `null` only when the document exists at exactly the supplied revision.
- Return a validated complete document when its revision is newer.
- Reject a missing document, lower revision, corrupt record or dependency error.

The unchanged fast path does not allocate a Yjs worker. Changed records receive
the same bounded isolated decoding and projection consistency checks as full
reads. The transport treats a `null` response below its room's maximum observed
revision as a regression too. This method is a trusted internal store operation,
not a new public HTTP route or client-selectable tenant boundary.

## Verification and scope

Run `npm test` for shared-mode option validation, automatic two-transport
convergence, no-op ACKs, idle/retired room cleanup, poll/write ordering, join/sync
revision floors, receiver revocation, dependency saturation and shutdown races.
Synthetic adapters make those races deterministic; they do not prove database
behavior.

The opted-in `npm run test:postgres` suite adds
`integration/shared-live-sync.test.mjs`: independent child server processes,
distinct pools, real PostgreSQL state and account membership, cross-node edits,
deletions, restart/reopen and injected failures. It uses only the documented
synthetic loopback database and refuses ambient production connection strings.
Passing these tests does not certify database failover, hostile-operator safety,
multi-primary operation, infrastructure capacity or production HA.
