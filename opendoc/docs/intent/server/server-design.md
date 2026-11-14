---
parent: ../../design.md
prefix: OD-SERVER
---

# Deployable OpenDoc server

## Single-host POC composition

The optional Lightsail recipe retains the existing proxy-mode server contract
and verified PostgreSQL TLS. One explicitly authorized 2 GB Linux host runs
OpenDoc, self-hosted Keycloak, PostgreSQL and Caddy, with bounded memory and
disk-backed swap. Only HTTP/HTTPS and operator-scoped SSH are public. Keycloak
registration, public administration and master-realm routes are disabled; one
explicit issuer/subject mapping admits the randomly credentialed POC owner.
The initial realm import and private configuration are fresh-install-only.
Separate application/database administrator credentials stay out of the runtime
application container. Persistent local volumes survive container restart.

The recipe deliberately trades availability and capacity for the selected
$12/month plan. It adds no load balancer, managed database, paid snapshot or
additional disk. Workload acceptance must test actual provider login, document
durability and memory use before reporting a live POC. Insufficient capacity
requires a user decision rather than an automatic paid upgrade. This deployment
does not change the server's experimental enterprise/air-gap boundaries.

## Context and design philosophy

The deployable host composes the existing OpenDoc adapters into a Node.js service
using one operator-selected PostgreSQL primary. Browser OIDC, account mapping,
encrypted shared sessions, REST documents and authoritative live documents share
one configuration and lifecycle. Existing standalone adapters and loopback demos
retain their contracts. Deployability means a runnable, configurable service and
container with exercised installation and restart behavior; it does not establish
enterprise-provider interoperability, production capacity, database failover or
air-gap readiness.

## Commands and interfaces

| Command | Contract |
| --- | --- |
| `npm start -- --config /path/server.json` | Validate configuration, open restricted runtime connections, check compatibility, then serve HTTP and WebSockets. |
| `npm run server:check -- --config /path/server.json` | Perform local configuration, certificate, key and asset checks without connecting to PostgreSQL, the identity provider or a listener. |
| `npm run server:init -- --config /path/server.json --component accounts\|documents\|live\|sessions` | Initialize exactly one fresh schema with an explicit administrative database credential. Refuse an existing namespace and never run during server startup. |
| `npm run server:account -- --config /path/server.json --input /path/account.json` | Provision one explicit issuer/subject/principal/tenant/role mapping through the existing account store using the administrative connection. |

Secret values never appear in command arguments. Configuration contains paths to
mounted secret files; account input is a bounded file rather than an argument or
an HTTP administration endpoint. The initializer supports individual components
so an interrupted installation can finish its remaining fresh schemas without
adopting or overwriting a completed component. There is no automatic destructive
cleanup, migration, account enrollment or mutation retry.

## Configuration and trust

The configuration file is bounded UTF-8 JSON with a versioned, closed schema.
Nested objects reject unknown keys and malformed types. All file paths resolve
relative to the configuration file. The validated configuration is copied before
asynchronous startup work. Errors identify the failing configuration field or
operational stage without including file contents, database URLs, credentials,
provider responses, document text or request headers.

The configuration and account-input files are each limited to 64 KiB, decoded
with fatal UTF-8 handling, and reject duplicate object keys. Secret files are
regular files: database/client secrets are bounded to 4096 UTF-8 bytes, the auth
key is exactly 32 raw bytes, and certificates/CA/key material have an explicit
1 MiB per-file limit. Secret mounts may use symlinks; reads validate the opened
file descriptor and byte count rather than trusting a prior path inspection.
Empty and embedded-NUL secrets are rejected; ordinary secret text files permit
one terminal LF or CRLF, with no other implicit trimming.

The configuration has these top-level sections: `version` (exactly 1), `server`,
`database`, `schemas`, `oidc`, `authKeyFile`, `activeTenantId`, and optional
`administration`, `live` and `limits`. Listener ports are integers 1–65535;
ephemeral test ports are an injected test-host option and not a production
configuration value. `server.mode` is `direct-tls`, `proxy` or `development`.
Direct TLS requires `tlsCertificateFile` and `tlsKeyFile`; proxy mode requires
an explicit private listener address. Bind configuration never changes the
canonical public origin. The host retains the existing bounded adapter limits;
the exposed `limits` setting only tightens the readiness deadline.

Required configuration names the exact public origin, listener address and port,
active tenant, PostgreSQL host/port/database/user and password-file path, four
distinct non-system schema names, authentication-key file, operator-pinned OIDC
issuer/client/authorization/token/JWKS endpoints and client-secret file. Runtime
and administration database credentials are separate configuration sections.
The administrative section is optional for ordinary startup. A 32-byte raw auth
key is read from a mounted file; startup never generates or rotates it.

PostgreSQL uses structured connection options rather than a connection-string
parser that can override TLS. Non-loopback connections require certificate
verification with an optional operator-provided CA file. Explicit development
mode permits unencrypted loopback connections only. Pools have bounded size,
connection acquisition, queries, statements and idle transactions. Pool errors
are handled without exposing their original messages.

The OIDC callback is derived as `${publicOrigin}/auth/callback`. Membership comes
only from `PostgresAccountStore.resolveMembership`. The deployment serves one
configured active tenant; the host introduces no client-selected tenant or
roles. The existing provider configuration and RS256 constraints remain in
force. There is no discovery fetch, provider token refresh or email-based account
linking. Local development permits only loopback identity and application URLs,
matching the existing OIDC adapter's contract.

## Ingress and TLS

Public origins require HTTPS. Direct TLS mode loads an operator-provided key and
certificate and serves HTTPS itself. Reverse-proxy mode is an explicit operator
choice: a private ingress terminates TLS, forwards the configured public Host,
and strips `Forwarded` and all `X-Forwarded-*` headers before the private Node
listener. The host retains the existing strict HTTP bridge and does not infer
origin or client identity from proxy headers. Deployments must restrict direct
access to the private listener through their network policy.

HTTP request validation alone does not protect WebSocket upgrades. Extract the
bridge's raw Host/forwarded-header checks into one reusable validator, preserving
its existing HTTP behavior. The deployable host applies this validator to the
upgrade event before the collaboration adapter can call `handleUpgrade`. Enforce
exactly one canonical Host, reject all forwarded headers, preserve transport
path/query restrictions and destroy rejected upgrade sockets without sending
authentication or document data. A host-owned upgrade dispatcher controls
admission during startup and drain rather than relying on listener ordering.

Explicit development mode binds to loopback and supports HTTP. It cannot combine
public binding with insecure development cookies or remote unencrypted storage.
All deployment examples use synthetic endpoints and mounted secret paths.
Browser assets remain bundled and same-origin; no external fonts or CDN assets
are introduced. Branding and document rendering remain the existing editor's
behavior in this server milestone.

## Runtime composition

The host constructs one bounded runtime pool, `PostgresAccountStore`,
`PostgresDocumentStore`, `PostgresLiveDocumentStore` and
`PostgresBrowserAuthState`. `createBrowserOidc` configures the shared session
policy and supplies both the HTTP authentication handler and collaboration
authenticator. `createWebClientHandler` serves the existing assets;
`createWebClientNodeListener` bridges HTTP. `attachCollaborationServer` attaches
live WebSocket upgrades to the same server and uses the exact public origin.

The live store always binds `accountSchema` for transaction-bound live writes.
An optional explicit authority UUID enables guarded live schema version 2;
omission selects the existing schema version 1. Startup never adopts a guarded
namespace, invents a pin, migrates a legacy schema or resets quarantine.
Shared-primary polling is a separate explicit configuration option and preserves
the existing bounded synchronization contract. REST and live document authority
remain separate, with no conversion or snapshot dual writes.

## Startup and readiness

Startup validates configuration, reads secret/certificate files, verifies bundled
assets and constructs adapters before binding a listener. A bounded startup
probe checks the four schema versions, live authority/quarantine metadata and
the shared-auth policy/key binding. Add bounded, read-only `checkReadiness()`
methods to the four PostgreSQL adapters, reusing their private metadata validators
and key/policy comparison logic. These methods do not run the session state
machine, perform expired-record cleanup, inspect every document or decrypt every
session. A successful probe verifies configuration/schema compatibility, not
whole-database integrity. Protected operations retain their normal validation.
The probe does not create a schema, seed documents, mint user credentials or
alter membership. Any partial startup failure closes resources already acquired.

`GET /healthz` reports process liveness. `GET /readyz` reports readiness with a
bounded dependency probe and returns 503 while draining or on incompatible or
unavailable storage. Both responses contain only a small generic status and use
no-store headers. Readiness is not evidence that a real enterprise provider is
available or interoperable. Probe work is single-flight, time-bounded and
releases or retains admission according to actual settlement rather than merely
the expiration of a wrapper timeout. Health routes use the same Host, target and
method restrictions as other HTTP traffic.

## Shutdown and failure behavior

SIGINT and SIGTERM start an idempotent drain. New HTTP work and upgrades are
rejected, readiness becomes false, and the collaboration adapter stops admitting
connections. Existing HTTP work receives a bounded drain period before sockets
are destroyed. Authentication is closed before the pool is ended so late results
cannot create credentials. An absolute shutdown deadline bounds waiting for
unsettled storage work. Forced shutdown is logged as incomplete rather than
successful draining; clients retain the existing uncertain-write/replay model.

The host tracks admitted HTTP work, readiness work and store operations,
including collaboration dependencies. The existing transport's `close()` and
authentication's `close()` are not evidence that SQL work has settled. After
stopping new admission, track actual promise settlement through the drain
deadline before ending the pool. The deadline can force process termination
with uncertain outcomes; it cannot cancel an already committed transaction.
The host retains a rejecting upgrade dispatcher until the listener is closed,
including after the collaboration adapter removes its upgrade listener.

Startup and CLI commands exit nonzero on failure and sanitize errors. They
never retry an initialization or account mutation after an uncertain commit.
Runtime errors do not print provider tokens, cookies, CSRF values or document
contents. Container startup uses an exec-form command so Node receives signals.

## Packaging and installation

Move the pinned `pg` driver into runtime dependencies and retain existing license
notices. Supply a non-root container image with the runtime modules, migrations,
prebuilt editor assets and notices. A build stage verifies generated browser
assets. Runtime performs no package installation or dependency downloads.
Configuration, TLS material and secret files are mounted read-only; database
data remains outside the application container.

A Compose reference includes PostgreSQL and OpenDoc, explicit health checks,
mounted configuration/secrets and persistent database storage. Administrative
initialization and account provisioning are documented one-time commands before
starting the application service. The reference contains no default usable
administrator credentials or automatically approved synthetic production users.
The guide documents direct TLS and private TLS ingress requirements, runtime and
administrative database permissions, restart behavior and the existing limits.

The Compose database hostname is non-loopback and therefore uses PostgreSQL TLS
with a mounted server certificate/private key and a trusted CA on the application
side. Certificate generation is an explicit installation step; private keys are
not checked into the repository. Container health uses a bundled Node probe that
connects to the configured listener, sends the canonical public Host and, in
direct TLS mode, validates the certificate for the canonical hostname/SNI using
the configured trust chain. It never disables certificate verification or
weakens Host policy to accommodate a localhost probe. Proxy-mode local probes
check the private listener; external TLS/ingress checks remain separate.

## Verification

Configuration tests cover unknown fields, wrong types, malformed origins,
duplicate schemas, missing/invalid keys, unverified remote database TLS and
unsafe development/public combinations. CLI tests cover explicit commands,
sanitized output, exit status and absence of network/listener activity during
configuration-only checking. Lifecycle tests cover bind failure, partial startup
cleanup, readiness saturation/outage and shutdown with HTTP/socket work pending.
Exercise WebSocket wrong/duplicate Host, forwarded headers, admission during
drain and a store operation that remains unsettled after transport close.

An opt-in integration suite uses a real isolated loopback PostgreSQL database and
the existing synthetic identity provider to run the actual server process.
Exercise fresh initialization, explicit account provisioning, sign-in, session
reuse across restart, REST save, concurrent live edits, viewer restrictions,
revoked membership, missing/mismatched schemas, bad session keys, restart
durability and signal shutdown. Existing synthetic loopback guards and cleanup
rules apply. No integration test targets operator or production databases.

Container verification builds the image, checks non-root execution and runtime
contents, and exercises the documented Compose startup when a container engine
is available. Unavailable container/provider environments are reported as
unverified; passing library tests does not substitute for those checks.

## Decisions and alternatives

| Decision | Chosen | Alternatives considered | Rationale |
| --- | --- | --- | --- |
| Runtime | One Node host using existing adapters and one PostgreSQL primary | Independent services and broker; Kubernetes-only runtime | Matches the approved portable architecture and minimizes new operating dependencies. |
| Trust at ingress | Exact public Host and origin; direct TLS or explicit private TLS ingress | Trust arbitrary forwarded headers | Preserves the bridge's existing origin and host protections. |
| Provisioning | Separate per-component administrative commands | Automatic startup migrations; best-effort multi-schema bootstrap | Avoids hidden mutation and makes partial installation recovery explicit. |
| Live authorization | Bind the existing transactional account guard | Rely only on socket admission membership | Maintains current write membership through commit using the adapter's lock protocol. |
| Secrets | Mounted files and structured database TLS configuration | Command-line secrets and connection-string TLS overrides | Keeps secrets out of argv and prevents URL options from weakening certificate verification. |
| Initial server features | Existing text editor, tenant roles and live transport | Simultaneous branding, ACL and rich-text expansion | A runnable host is independently testable without changing document authority or authorization semantics. |

## Open questions and future decisions

Real Ping/Entra/Google acceptance, runtime TLS certificate reload, session-key
rotation, schema upgrades, database failover, distributed fan-out, per-document
ACLs, branding, durable browser recovery, object storage and cloud provisioning
remain separate components. Their absence must remain visible in capabilities
and deployment guidance.

## References

- [Foundation architecture](../../design.md)
- [Foundation requirements](../../specs.md)
- [Browser login](../../browser-login.md)
- [Shared sessions](../../shared-sessions.md)
- [Account mapping and provisioning](../../accounts.md)
- [Guarded live storage](../../guarded-live-storage.md)
- [Deployment boundaries](../../deployment.md)
