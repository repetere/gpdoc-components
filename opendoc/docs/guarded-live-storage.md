# Guarded live-document storage

This optional evaluation mode adds two separate protections to the existing
PostgreSQL live-document adapter:

- A trusted account-schema binding can check current write membership inside the
  same transaction that creates or changes a live document.
- A fresh guarded live namespace keeps a revision/checksum checkpoint alongside
  each canonical document, with a persistent, namespace-wide quarantine latch.

Neither option changes the live WebSocket protocol. Omitting both keeps the
existing schema-v1 storage and authentication behavior. Memory documents,
independent REST documents and standalone collaboration rooms are unchanged.
These are bounded reference safeguards, not production HA, database failover,
an independent audit log, or protection against a hostile database operator.

## Explicit fresh provisioning and composition

Provision an account schema separately using the existing account bootstrap.
It must be in the **same PostgreSQL database** as the live schema. The host owns
the pool, its fixed primary target, credentials, schema choices and authenticator.
This example assumes that `pool`, `server` and `authenticateSocket` are supplied
by that host:

```js
import { randomUUID } from 'node:crypto';
import {
  initializePostgresLiveDocumentSchema,
  PostgresLiveDocumentStore
} from '../src/live-document-store.mjs';
import { attachCollaborationServer } from '../src/collaboration-server.mjs';

// Administrative provisioning, ONCE for a fresh namespace. Save this non-secret
// pin in deployment configuration before starting any application processes.
const authorityId = randomUUID();
await initializePostgresLiveDocumentSchema({
  pool,
  schema: 'example_live_guarded',
  historyGuard: { authorityId }
});

// Runtime: every instance uses that saved pin, never a newly generated UUID or
// a value automatically discovered from the database it happens to reach.
const liveStore = new PostgresLiveDocumentStore({
  pool,
  schema: 'example_live_guarded',
  historyGuard: { authorityId },
  accountSchema: 'example_accounts'
});
const collaboration = attachCollaborationServer({
  server,
  liveStore,
  authenticate: authenticateSocket,
  allowedOrigins: ['https://editor.example.test'],
  sharedLiveSync: { intervalMs: 1000 }
});
```

For a synthetic configuration example, a pin can look like
`4d70654e-646f-4367-8000-000000000001`. It is an identity label, **not a password or
credential**; generate a distinct UUID for each real fresh namespace. A pin does
not authenticate the server or discover which primary is legitimate.

`historyGuard` must be a plain object with exactly one own data property,
`authorityId`, containing a lowercase UUID. The initializer returns
`{schemaVersion: 2, authorityId}`. Without the option it still returns
`{schemaVersion: 1}`. Constructors are inert: they never connect, migrate, create,
adopt, repair or reset anything.

The guarded initializer appends `006_guarded_live_documents.sql` to the normal
fresh-schema creation in one transaction. It refuses an existing schema. That
SQL file is **not an upgrade script** for an existing live namespace. No automatic
schema-v1 migration or history adoption is provided. Old adapters reject schema
version 2. New adapters without an explicit pin also reject it, and pinned
adapters reject schema version 1 or a different pin. There is no legacy fallback.

## Transactional account checks

The `accountSchema` option is independent of `historyGuard`; it can be used with
schema-v1 live storage too. It names a separate, explicitly trusted account
schema in the live pool's database. Equal account/live schema names are rejected.
The schema name does not establish a trustworthy tenant or identity relationship:
the host must bind its authenticator, account store and live store correctly.

With this option, direct mutation calls require a trusted actor:

```js
const actor = { principalId: 'example_editor', tenantId: 'example_tenant' };
await liveStore.create('example_tenant', {
  id: 'example_document', title: 'Example', content: 'Initial content'
}, actor);
await liveStore.applyUpdate('example_tenant', 'example_document', yjsUpdate, actor);
```

The actor has exactly two own data properties, `principalId` and `tenantId`.
It is copied and validated synchronously before the first asynchronous step.
Missing actors, getters, extra fields and tenant mismatches are denied; a caller
cannot mutate its actor object while pool acquisition is pending to change the
admitted identity. This object is supplied by trusted server composition, never
copied from a client-selected identity in a request body or WebSocket update.
The HTTP live-create handler and live-v2 transport forward their authenticated
principal/tenant pair. A client-supplied role is not accepted as authorization.

The transaction first obtains the account namespace's shared state-row lock,
then checks the current active principal and owner/editor membership, then locks
the live namespace. Both locks are retained through commit or rollback. Account
administrative mutations use the conflicting exclusive account lock. Therefore
a revocation/downgrade that commits first blocks a subsequent document write;
a write that obtained authorization first may finish before the revocation can
commit. This is an ordering guarantee, not retroactive cancellation. No-op Yjs
replays also require current write authorization.

This option covers the account database's current principal and tenant write
membership only. Session logout/expiry, browser-ticket or JWT expiry, and external
identity-provider revocation are not made atomic with the document commit.
They remain part of the host's normal authentication checks. Independent REST
document writes and standalone collaboration writes do not use this live-store
transactional account guard.

The fixed lock order is **account, then live**. Do not introduce inverse-order
transactions elsewhere. Account errors fail closed; no second pool, separate
authorization transaction, retry or fallback is used. Reads still depend on the
host's normal authentication and tenant isolation. Receivers are still checked
again before protected state delivery and acknowledgements.

Give the live pool only the account reads and row-lock permissions this check
requires, in addition to its own live-storage permissions. PostgreSQL `FOR SHARE`
requires applicable `UPDATE` privilege as well as `SELECT`; a narrowly scoped
column privilege on the account state table can satisfy locking without granting
blanket account administration. Review that grant with the database operator.
Do not give the live application broad account mutation, schema creation or
credential-management privileges merely to make this check run.

## What a guarded checkpoint means

`live_document_state` stores the pinned `authority_id`, schema version and
`quarantined` bit. `live_document_checkpoints` has one row per `(tenant_id,
document_id)`, with a positive safe-integer revision and a 32-byte SHA-256 digest.
There is intentionally no cascading foreign key: deleting a canonical document
must not silently delete the evidence that it existed.

The digest binds a fixed domain, length-framed tenant/document identifiers, the
revision, and the exact persisted Yjs state, title JSON bytes and content JSON
bytes. It hashes actual canonical Yjs bytes, not only rendered text or a Yjs
state vector. Delete-only and causal-pending state therefore remain covered.
Projection-only changes are covered too. Timestamps are validated as timestamps,
not included in the checkpoint checksum. This is a checksum, not a signature or
an authorization mechanism.

Every guarded operation first takes the live namespace quota row **FOR UPDATE**.
This deliberately serializes guarded reads and writes and avoids lock-upgrade
deadlocks. Under that same lock:

- Creation requires both the canonical key and checkpoint to be absent, then
  creates both atomically. It never treats a missing checkpoint as permission to
  adopt existing state.
- A changed mutation validates the existing pair, merges the update, and writes
  the next revision plus checkpoint in one transaction. A no-op preserves both.
- `get` validates the pair and fully decodes the state/projection before return.
- `getIfChanged` verifies the checksum even at an equal revision. An unchanged
  result avoids the Yjs worker, but no longer avoids hashing the stored bytes.
- `list` joins both sides and validates the stored tuple checksum before exposing
  summaries. It does not download all binary snapshots or start a worker per
  listed document. An orphan canonical or checkpoint row in that tenant fails.

These operations compare the current row and checkpoint inside their transaction,
not a delayed response against a newer cross-process observation. A valid read
or write response can arrive after another process has committed a newer revision;
that alone is **not** corruption or grounds for permanent quarantine. Existing
local room queues and delivery floors still prevent local revision regression.
A caller's `knownRevision` above the current stored revision is rejected, but
does not by itself poison durable quarantine.

## Sticky quarantine and unavailable dependencies

A deterministically inconsistent stored pair, including a missing canonical row
with a retained checkpoint, a canonical row with no checkpoint, a revision
mismatch, checksum mismatch, or malformed checked metadata, stops the operation.
Before returning the sanitized `DEPENDENCY_UNAVAILABLE` failure, the adapter
commits `quarantined = true`. This is deliberately a committed failure outcome:
throwing before commit would roll the quarantine change back.

The latch covers the **entire live namespace**, including other tenants and
documents. All five store methods refuse it thereafter. Room retirement,
disconnect, process restart, a newer document revision, or restoring the affected
document's bytes does not clear a committed latch. Other processes notice it at
their next store operation; this is not an instantaneous cluster-wide kill
switch and it does not recall a result already validated by an earlier transaction.

Incorrect configuration/pins, account denials, malformed user updates, quota
rejections, worker capacity/timeouts, connection failures and ambiguous COMMIT
results are not evidence of corrupt stored history. They fail closed without
automatically setting quarantine. A malformed newly generated mutation result
is also a failed attempted write, not proof of existing durable corruption.
The decoder currently reports invalid previous-state bytes and some worker
failures with the same dependency error. If bytes and checkpoint match but the
worker rejects them without a distinct integrity result, the adapter remains
unavailable without claiming that permanent quarantine was recorded. Static
metadata/byte-bound violations and checksum/projection inconsistencies have
separate deterministic checks.

Missing or invalid namespace-control rows and inaccessible/broken schema objects
can prevent the adapter from safely recording a latch. Those cases remain
unavailable; do not report them as successfully persisted quarantine. A lost
response to the quarantine COMMIT also has an uncertain outcome. No error or
transport timeout proves either successful persistence or rollback. The adapter
does not blindly retry either a mutation or quarantine COMMIT.

There is no reset, clear-quarantine, authority rotation, repair or automatic
recovery endpoint. Clients must preserve unacknowledged local work. Operators
must stop/fence clients and writers, preserve and inspect the evidence, decide
the authoritative history outside this API, and provision a separately validated
fresh namespace when appropriate. Simply
deleting a checkpoint or switching off the option is not recovery. No supported
live-document deletion, history reset or schema-v1 import is added here.

## Bounds and operating cost

The existing document count, per-tenant count and logical-document byte limits
remain unchanged. Normal writes create exactly one fixed-size revision/digest
checkpoint per document, with bounded tenant/document keys. The existing maximum
document count also bounds checkpoint entries. Creation checks checkpoint count
against the namespace document count before adding one. Reads of nonexistent
keys allocate no checkpoint, quarantine row, timer or permanent observation map.
Quarantine is one boolean in the existing singleton, not an unbounded event log.

Checkpoint keys, the 8-byte revision and 32-byte digest add fixed logical
metadata per document; PostgreSQL indexes, row headers, WAL and backups add
physical overhead. These are not charged to the existing document `maxBytes`.
Set physical storage limits separately. There is no metadata eviction or TTL
that could silently forget history.

Guarded reads serialize with all namespace writes. Every unchanged poll hashes
the actual stored tuple, and listing hashes the bounded tenant result set. This
can substantially reduce throughput or increase latency. It is an explicit
evaluation tradeoff, not a benchmark or latency guarantee. Configure statement
and idle-transaction timeouts, pool capacity and cleanup. JavaScript timeouts do
not cancel PostgreSQL transactions. Existing transport admission limits remain.

## Exact limits of the guarantee

The checkpoint and quarantine bit live in the **same PostgreSQL database** as the
document. They survive room and process restart while that database history is
preserved. They can detect a document-only rollback, conflicting bytes or missing
one-sided state while the corresponding checkpoint survives.

They **cannot detect a coherent restoration, deletion or clone of both document
and checkpoint/control history**. A clone contains the same authority ID and can
be independently writable. A complete older backup can contain matching older
rows and an unset quarantine bit. A higher divergent revision is not proven to
descend from an independently trusted history. The configured UUID pin does not
fix those limitations. Missing both sides of a never-seen key is indistinguishable
from prior state removed together with its evidence.

No external witness, monotonic epoch service, lease, consensus protocol,
multi-primary fencing, tamper-proof log or split-brain reconciliation is provided.
An administrator able to rewrite both data and checksums can bypass this check.
Operators must continue using one fixed primary/schema, forbid out-of-band writes,
and control restore, clone and authority-change procedures. Independent rollback
detection would require durable evidence outside the restored/cloned failure
boundary and a separately designed recovery protocol.

## Verification

`test/live-history-guard.test.mjs` provides focused scripted store tests for
configuration, pair validation, tuple checksums, no-op/changed writes, quarantine
commit ordering and ambiguous outcomes. These deterministic scripts do not prove
PostgreSQL behavior. The real integration suite runs independent server processes
and pools against explicitly enabled synthetic PostgreSQL, including concurrent
commits, room/process restart, document-only corruption, quarantine persistence,
and lost COMMIT responses. Follow [PostgreSQL test instructions](postgres.md);
never substitute production connection strings or credentials.

Passing those tests establishes only the tested fixed-authority behavior. It
does not certify availability, failover safety, restoration detection, hostile
operator resistance or production capacity.
