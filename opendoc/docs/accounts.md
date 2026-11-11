# Persistent server-owned accounts

OpenDoc's PostgreSQL account store maps an already-verified external identity to
an internal principal and that principal's role in one server-selected tenant.
It does not validate passwords or tokens, run an identity provider, or expose
HTTP administration routes. It is original MIT-licensed code.

The identity is the exact `(issuer, subject)` pair. A subject is never a global
user ID. Emails, verified-email claims, display names, token roles, groups and
client-selected tenants are not account-linking or authorization evidence.
A new external identity receives no access until an administrator explicitly
provisions it. Login never creates principals, links identities or grants roles.

## Separate bootstrap and runtime

The host supplies and owns standard `pg` pools. Importing the module and creating
`PostgresAccountStore` performs no connections, DDL, migrations, configuration
discovery or pool shutdown. The account schema must be separate from REST document
and collaboration schemas. Existing document and room tables are not changed.

An authorized administrator runs bootstrap once, using a **fresh namespace**:

```js
import {
  initializePostgresAccountSchema,
  PostgresAccountStore
} from '../src/account-store.mjs';

// administrativePool is configured and owned by the host, not this module.
await initializePostgresAccountSchema({
  pool: administrativePool,
  schema: 'opendoc_accounts',
  maxPrincipals: 10000,
  maxIdentityBindings: 20000,
  maxMemberships: 50000,
  maxMembershipsPerTenant: 10000,
  maxBytes: 16 * 1024 * 1024
});
```

Bootstrap uses transactional `CREATE SCHEMA`, refuses every existing schema, and
never drops, reuses, upgrades or silently repairs one. It never executes on login
or server startup. The SQL in `migrations/003_account_store.sql` is a bootstrap
template with a validated, quoted namespace substitution, not a migration runner.
All identifiers and limits must be supplied by trusted host configuration.

Use a restricted runtime database role for authentication. It needs schema `USAGE`,
`SELECT` on the four tables, and `UPDATE(singleton)` on `account_state` because
PostgreSQL requires an update privilege for the shared row lock. That single
boolean is constrained to `true`; the resolver never updates it. Do not give the
authentication role account-row mutation or schema-creation privileges. Use a
separate administrative pool/role for the administrative methods below. Database
owners and administrators remain trusted. Direct SQL writes that bypass the
store's locking and quota protocol are unsupported.

The host configures connection, query, statement and idle-transaction deadlines,
TLS, database credentials and pool shutdown. Credentials, tokens and cookies are
not account rows. Choose PostgreSQL with built-in `sha256(bytea)` and stored
generated columns; no extensions are installed by this module.

## Authentication composition

```js
const accounts = new PostgresAccountStore({
  pool: authenticationPool,
  schema: 'opendoc_accounts'
});
const resolveMembership = accounts.resolveMembership.bind(accounts);

// Supply this callback to the access-token or browser OIDC authenticator.
// It must run only after that adapter verifies the provider credential.
const membership = await resolveMembership({
  issuer: 'https://identity.example.test',
  subject: 'opaque-provider-subject',
  activeTenantId: 'workspace-a' // trusted server configuration
});
// { principalId: 'person-123', tenantId: 'workspace-a', role: 'editor' }
// or null when no active authorized mapping exists.
```

The callback has the same contract as `createAccessTokenAuthenticator` and the
browser OIDC adapter. Only the server's pinned issuer, verified subject and
server-configured active tenant go into the lookup. The store does not establish
that a caller verified a token; authentication adapters enforce that boundary.
A raw public call to `resolveMembership` is not an authentication service.

The lookup joins the identity binding, active principal, and membership with an
explicit tenant predicate. Missing identity, absent membership or inactive
principal returns `null`. Every lookup is fresh; there is no membership cache.
Database errors propagate as sanitized `StoreError('DEPENDENCY_UNAVAILABLE')`,
not a successful authentication or an invitation to enroll. The HTTP adapter must
fail closed on such errors. Malformed arguments return `BAD_REQUEST`.

A successful lookup is an access decision at its database transaction boundary,
not an indefinite lease. A revocation cannot cancel a previously authorized
operation already executing elsewhere. Recheck membership for subsequent
requests and collaboration authorization boundaries rather than copying a role
into a long-lived session and trusting it forever.

## Administrative APIs

**Every method below is an administrator-only host API.** No public HTTP admin,
self-enrollment, email-linking, recovery or role-management endpoint is provided.
The host must authorize administrators independently before invoking a method.
Never route an arbitrary request body into these methods.

```js
const admin = new PostgresAccountStore({
  pool: administrativePool,
  schema: 'opendoc_accounts'
});

await admin.provisionAccount({
  issuer: 'https://identity.example.test',
  subject: 'opaque-provider-subject',
  principalId: 'person-123',
  tenantId: 'workspace-a',
  role: 'editor'
});

// Explicitly link a second verified provider identity to this existing person.
// The host administrator must establish that the person owns both identities.
await admin.linkIdentity({
  issuer: 'https://another-identity.example.test',
  subject: 'another-opaque-subject',
  principalId: 'person-123'
});

// Explicitly grant a role or change an existing tenant role.
await admin.setMembership({
  principalId: 'person-123', tenantId: 'workspace-a', role: 'viewer'
});

// Remove just this tenant membership. Returns true, or false if already absent.
await admin.revokeMembership({
  principalId: 'person-123', tenantId: 'workspace-a'
});

// Disable every external identity and every tenant for this principal.
await admin.setPrincipalActive({ principalId: 'person-123', active: false });
```

- `provisionAccount` atomically creates an active principal if absent, links the
  external identity, and grants the tenant role. An identical existing provision
  succeeds without duplicate records. An existing different role is `CONFLICT`:
  use `setMembership` for a deliberate role change.
- An `(issuer, subject)` binding is immutable through this API. Linking the same
  pair to a different principal returns `CONFLICT`, never an upsert or silent
  reassignment. `linkIdentity` links to an existing active principal only and
  returns `{ principalId }`; an identical link is idempotent.
- `setMembership` requires an existing active principal and returns
  `{ principalId, tenantId, role }`. `provisionAccount` returns the same shape.
  Both unknown-principal link/grant operations return `NOT_FOUND`. There is no
  automatic creation outside `provisionAccount`.
- Provisioning, linking and granting against an inactive principal return
  `CONFLICT`. Reactivation requires explicit `setPrincipalActive` with `true`;
  this returns `{ principalId, active }` and does not recreate revoked memberships.
  Existing retained memberships become usable again after reactivation.
- Revocation removes only one tenant membership and releases its quota usage.
  Principals and identity bindings remain, including when disabled. There is no
  binding reassignment, principal deletion, tenant deletion or garbage collection
  API in this milestone. Plan capacity for these durable identity records.

Method arguments are exact plain data objects with no extra fields or accessors.
The four roles are `owner`, `editor`, `viewer`, and `commenter`. Principal IDs use
ASCII letters/digits followed by letters/digits/underscore/hyphen, up to 64
characters. Tenant IDs additionally allow dots after the first character and
are bounded to 128 characters. Issuers are nonblank strings up to 2048 JavaScript
string units; subjects up to 512. Both reject controls and unpaired surrogates.
Neither is trimmed, lowercased, URL-normalized or Unicode-normalized.

## Storage, isolation and bounds

The dedicated schema has four tables:

- `principals`: internal principal ID and explicit active flag.
- `identity_bindings`: exact UTF-8 issuer and subject bytes, immutable principal
  association, and generated fixed-width SHA-256 index keys.
- `memberships`: `(tenant_id, principal_id)` primary key and trusted role.
- `account_state`: schema version, bounded quotas, counters and a lock row.

Exact byte storage avoids database collation folding. The generated digest-key
primary key enforces uniqueness for every exact issuer/subject pair while keeping
index tuples bounded even for the longest accepted Unicode inputs. A lookup also
compares both original byte strings. A hypothetical digest collision between
different pairs cannot authenticate or link as the existing pair: resolution
returns `null`, and linking returns `CONFLICT`. The digests are index keys, not
anonymization. Backups still contain identities and need ordinary access controls.

Each write takes an exclusive lock on the same schema-wide state row before
reading or mutating account data. This makes identity uniqueness, counts,
per-tenant membership limits and byte accounting atomic across pools and
processes. PostgreSQL primary/foreign keys add another integrity boundary.
Failures roll back the whole operation, including partially inserted principals
or bindings. Global serialization favors reference correctness over throughput.

Resolvers hold a shared state-row lock inside a `READ COMMITTED` transaction and
run the identity/membership query in a subsequent statement. They can run
concurrently with one another, but wait for a pending earlier writer to settle
before selecting a fresh snapshot. This prevents a lost writer connection or
uncertain commit from allowing a reconnect to bypass a still-pending revocation.
All writes through this store use the same lock protocol.

Defaults are 10,000 principals, 20,000 identity bindings, 50,000 memberships,
10,000 memberships per tenant, and 16 MiB of logical stored bytes. Global row
limits can each be configured from 1 to 1,000,000; the per-tenant limit from 1 to
10,000. The byte limit is a positive safe integer. Logical bytes are UTF-8 issuer,
subject, principal, tenant and role data, counting each occurrence in each table;
fixed database/index overhead is not included. Both row bounds and field-length
bounds apply. Quota excess returns `CAPACITY_EXCEEDED` and changes nothing.

Database error messages, connection URLs, parameters, causes and driver details
are never exposed in store errors. Rollback is attempted even if `BEGIN`'s reply
is lost; a failed rollback discards the connection rather than returning a
transaction-bearing client to the pool. Operations are never automatically
retried. A lost `COMMIT` reply is `DEPENDENCY_UNAVAILABLE` even if the change
committed. Inspect current state through fresh reads and trusted administration
before issuing a new deliberate change. Do not replay an old grant blindly:
revocation or a new role decision may have happened in the meantime.

## Verification

`node --test test/account-store.test.mjs` runs scripted contract tests, including
no-I/O construction, sanitized errors, cleanup, strict inputs, tenant-bound SQL
and administrative conflict rules. These tests are not proof of database
isolation.

`integration/account-store.test.mjs` opts into a real synthetic PostgreSQL
instance only with `OPENDOC_PG_INTEGRATION=1`. It requires the exact database/user
`opendoc_test`, password `synthetic-test-only`, a loopback URL without query
options, and the expected server address. It verifies exact identities, Unicode,
absence and inactive denial, no email linking, cross-tenant roles, immutable
bindings, concurrent quotas, revocation, process/pool persistence, rollback
atomicity, pending-writer read barriers and uncertain-commit outcomes.
It creates random fresh schemas and cleans up only those exact schemas and tables
without `CASCADE`. It must never target production or a shared non-test database.
