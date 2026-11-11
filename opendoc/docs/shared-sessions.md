# Shared browser authentication state (evaluation foundation)

OpenDoc optionally persists browser auth state in PostgreSQL. This is a bounded,
portable foundation, **not a production high-availability or SSO certification**.
The default remains the in-memory implementation described in
[browser-login.md](browser-login.md). HTTP routes, cookies and response shapes
are unchanged.

The durable adapter stores the whole authentication lifecycle: pending login
intents (before request bodies/PKCE finish), OIDC transactions, consumed callback
claims, sessions and one-connection collaboration tickets. It is not a cache of
session snapshots. Login on instance A can finish on B, and an application
process restart does not discard committed state. Logout, login replacement,
rotation and ticket consumption serialize across instances.

## Explicit operator setup

The host supplies `pg` and owns its pool. No database listener, migration,
credential, key, account, network service or cloud resource is created implicitly.
Use a **fresh dedicated schema**, separate from documents and accounts. Constructors
are inert. Runtime requests refuse missing/incompatible schema metadata.

```js
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createBrowserOidc } from '../src/browser-oidc.mjs';
import { PostgresBrowserAuthState } from '../src/postgres-browser-auth-state.mjs';

// Example only: the operator supplies a private 32-byte random key file and
// database connection/TLS configuration through their secret/config system.
const encryptionKey = await readFile(process.env.OPENDOC_AUTH_KEY_FILE);
const pool = new Pool({
  ...operatorDatabaseConfiguration,
  max: 8,
  connectionTimeoutMillis: 2000,
  query_timeout: 3000,
  statement_timeout: 2000,
  idle_in_transaction_session_timeout: 5000,
});
const authState = new PostgresBrowserAuthState({
  pool,
  schema: 'opendoc_browser_auth',
  encryptionKey,
  queryTimeoutMs: 2000,
});
const browser = createBrowserOidc({
  ...operatorOidcConfiguration,
  resolveMembership: accounts.resolveMembership.bind(accounts),
  authState,
});

// ONE-TIME ADMINISTRATIVE BOOTSTRAP ONLY, before serving requests.
// Do not include this in ordinary instance startup or retry it on failures.
await authState.initialize({ maxBytes: 8 * 1024 * 1024 });
```

The bootstrap uses `migrations/004_browser_auth_state.sql`. Creating an existing
namespace rejects; it never adopts, overwrites or upgrades tables. Run bootstrap
with a controlled administrative connection, then construct runtime adapters with
the same key/schema/configuration and a restricted runtime pool. The runtime role
needs schema usage; select/insert/update/delete on `browser_auth_records`; and
select plus row-lock permission on `browser_auth_state` (for example, update of
its `singleton` column only). It does not need CREATE/DROP/ALTER or access to
unrelated schemas. Supply verified TLS and network access policy for non-loopback
databases. The example's timeout numbers are operator choices, not a complete
production pool configuration.

Every instance must use the same key and exact browser trust configuration.
The stored SHA-256 binding covers issuer, client ID and auth method, redirect URI,
authorization/token/JWKS endpoints, active tenant, loopback mode, success path and
all configured limits. Client-secret values are not included, allowing a separately
coordinated provider secret update. A different tenant/provider/client/policy/key
cannot reinterpret existing sessions. Mismatches return sanitized dependency errors;
there is no silent fallback to memory. Change configuration with an explicit
namespace transition that signs users out, not by editing metadata in place.

`queryTimeoutMs` is a positive integer up to 10,000, default 2,000. The adapter
sets transaction-local statement and lock timeouts. Operators must also set pool
connection and query deadlines: a pool acquisition can otherwise remain pending.
The browser's admission slot stays occupied until underlying work actually
settles, even when its public response deadline has elapsed.

## Atomic operations and race boundaries

Each state operation has one PostgreSQL transaction. It locks the namespace's
singleton row with `SELECT ... FOR UPDATE`, reads a fresh READ COMMITTED snapshot,
validates config/key/version and bounded records, applies the state transition,
writes only changed/deleted records, and commits exactly once. All cooperating
instances use this lock, including authentication reads and cleanup. No provider
request, request-body read, PKCE digest or membership lookup holds a database lock.

The shared state machine in `src/browser-auth-state.mjs` uses explicit opaque
intent, callback-claim and session-version values. It never compares JavaScript
object identities to decide whether durable work remains authorized.

- `beginLogin` atomically cancels the old transaction and sibling work, records a
  new intent and captures the currently live originating session. It happens
  before awaiting the JSON body or PKCE digest. An intent consumes one global
  transaction slot and expires after the operation deadline interval.
- `publishLogin` requires the still-current intent and originating session. It
  replaces that intent with a transaction containing state, nonce and verifier.
- `consumeTransaction` assigns a single callback claim before any code exchange.
  Consumed transactions remain cancellable while provider/membership calls wait.
  A crash after consumption never makes the authorization code reusable.
- `finishCallback` requires that same claim, current intent and live original
  session, checks capacity, rotates the prior session and deletes the transaction
  in one commit. Source transaction/intent/session deadlines are also checked
  after SQL writes, before COMMIT, so a slow publication cannot renew expired work. A conservative
  post-COMMIT check uses database time plus monotonic elapsed duration to withhold
  grants if acknowledgement arrives after a source or session deadline.
- `removeSession` checks the expected version and deletes the session, every
  associated ticket, and its pending login intents/transactions atomically.
- `issueTicket` checks the current session and shared ticket quota. `bindTicket`
  binds first use to one server-generated connection ID atomically. Another socket
  cannot claim it; the original connection can revalidate until fixed expiry.
- Session and ticket validation query current membership outside the lock, then
  recheck durable state afterward. Revocation, changed principal mapping, logout,
  rotation or expiry during that await denies the result. Roles are never cached.

Failure cleanup can delete only the callback's own still-current claim. Duplicate
or superseded callbacks emit no stale `Set-Cookie` deletion. Initiation cleanup is
conditional and bounded by durable expiry if a process crashes. Cleanup is inside
the operation's admission accounting and cannot extend the HTTP response deadline.

These checks define authentication-time authorization. They do not cancel a REST
write already authorized and executing in a separate document transaction, and
cannot recall an HTTP response already sent. A first-time anonymous browser with
no transaction or session cookie still cannot correlate simultaneous login tabs.

## Bounds, database time and maintenance

Existing `BROWSER_OIDC_LIMITS` apply. The durable namespace shares `maxSessions`,
`maxTransactions` (transactions **plus in-progress intents**) and `maxTickets`.
The maximum total is 3,000 records at default settings. Each ciphertext record is
limited to 16 KiB; the namespace has an additional durable ciphertext-byte quota
(default 8 MiB, maximum 16 MiB). The quota excludes PostgreSQL row/index/WAL and
backup overhead. A configured count/byte limit rejects new work instead of
silently evicting active users. Pending JavaScript operations remain capped **per
instance**, not deployment-wide. Deployments still need shared ingress/rate limits.

PostgreSQL `clock_timestamp()` after acquiring the lock decides state expiry.
Reads never slide session/ticket lifetimes. The browser still uses its local clock
for OIDC claim verification, HTTP cookie ages and response deadlines; keep app and
database clocks synchronized. Test coverage verifies that changing the application
clock does not change the adapter's durable expiry decisions.

Every operation prunes expired records and dependent work. Call
`await authState.run('stats')` from an operator-owned maintenance job to prune an
otherwise idle namespace. Physical deletion is opportunistic; an expired row can
remain on disk while idle but can never grant access. PostgreSQL vacuum, WAL,
backup retention, disk capacity and operational monitoring remain operator duties.
The `run`/`configure` interface is an internal trusted-server adapter contract, not
an endpoint or a browser-controlled administrative API.

`browser.stats()` stays synchronous for the default memory adapter. With PostgreSQL
it returns a promise, so use `await browser.stats()` for either mode. Its result
continues to contain counts only (`sessions`, `transactions`, `tickets`,
`pendingOperations`). The adapter's internal stats additionally reports `intents`.
`browser.close()` stops this browser adapter and rejects late results. It clears
owned default memory state, but does **not** delete external/shared durable state
or close the caller-owned pool. Gracefully drain outstanding work before ending
that pool. Restart another instance with the same namespace/key/config to resume.

## At-rest protection and key operations

The operator supplies exactly 32 random key bytes from their secret manager or
private mounted file. OpenDoc does not generate, print, persist or back up that
key. Do not use a password, a repository value, a public identifier or a browser
bundle. Secure the root key and pool credentials independently from database
backups and restrict access to application processes that must authenticate.

HKDF-SHA-256 derives separate encryption and index keys scoped to the schema.
Records use AES-256-GCM with a fresh random 96-bit nonce per changed record and
an authenticated context containing schema version, namespace, trust binding,
record type and HMAC index. Record keys are keyed HMAC-SHA-256 values rather than
raw cookie/ticket/intent identifiers. Ciphertexts contain the bearer identifiers,
CSRF secret, subject/principal, state/nonce/PKCE verifier and relationship/fencing
values. Provider access/refresh/ID-token strings are never persisted.

An offline database read therefore exposes record types, counts, expiry times,
payload lengths, public configuration hashes and access patterns, but not usable
bearer tokens or PKCE secrets without the operator key. Wrong keys, swapped
ciphertexts, altered expiry metadata and authentication-tag failures reject closed.
Encryption does not protect a compromised live application that already has the
key, a malicious database that deletes/denies service, or rollback/replay of
previously valid encrypted records or whole database snapshots. Backups can contain older sessions and
logout state. After disaster recovery from potentially stale data, use a fresh
namespace and key and require fresh logins; never silently serve a stale snapshot.

There is deliberately no key ring, online rotation, re-encryption migration or
zero-downtime trust-policy transition in this milestone. A key loss invalidates
access to the namespace. A key replacement requires an operator-controlled fresh
namespace and reauthentication. Retain/destroy old encrypted data and old keys
according to the operator's retention and incident-response policy.

## Fail-closed errors and limitations

A storage/lock/pool/decryption/schema failure never grants identity or returns new
credentials, and never switches to a process-local cache. Public errors contain
only the existing sanitized codes. COMMIT is attempted once. If it succeeds on
the server but its acknowledgement is lost, the operation returns dependency
failure and the connection is discarded. The adapter never retries uncertain
minting/consumption. A session or ticket may have committed without ever reaching
the browser; it remains bounded and expires. A successful but slow COMMIT can
also leave an unreachable session when its source deadline passes before the
acknowledgement: the response is denied, not falsely described as rolled back.
An uncertain logout may or may not
have committed: a 503 is not proof of sign-out. Retry only after inspecting the
current state, and start a fresh login after an uncertain callback.

The namespace-wide lock and bounded full decrypt/read are intentional simplicity
tradeoffs. They are not a scale benchmark, replica protocol, failover guarantee,
connection-draining scheme or certification of production HA. Use one authoritative
PostgreSQL writer, not asynchronous replica reads. Protect against stale restore,
split brain, insecure pools and unbounded ingress separately. Collaboration
transport rooms still have their existing deployment limitations; sharing auth
state does not make collaboration fan-out multi-instance.

## Verification

`npm test` includes the unchanged memory browser regressions and adapter failure,
cleanup-deadline, version/snapshot and bounded-policy tests. The opt-in
`integration/browser-auth-state.test.mjs` uses real PostgreSQL and the maintained
local synthetic OIDC provider. It covers three separate operating-system processes
for login initiation, callback and session retrieval; concurrent callback claims;
logout versus delayed callback/body work; replacement/rotation; single-connection
tickets; current membership; durable quotas/pruning; config/key/ciphertext failures;
and actual COMMIT success followed by a synthetic lost acknowledgement.

Run only with the existing synthetic local test contract:

```sh
OPENDOC_PG_INTEGRATION=1 \
DATABASE_URL='postgres://opendoc_test:synthetic-test-only@127.0.0.1:55432/opendoc_test' \
npm run test:postgres
```

The harness verifies the connected database/user/server address, uses unique fresh
test schemas, and deletes only its own known tables without CASCADE. No remote or
ambient database target is accepted. These are network/process/database tests,
not public HTTPS cookie QA, production IdP interoperability, security penetration
review or an air-gap certification.
