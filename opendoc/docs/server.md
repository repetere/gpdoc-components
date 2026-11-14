# Deployable OpenDoc server

The server composes the PostgreSQL document, account, live-document and encrypted
shared-session adapters with browser OIDC, the existing text editor and Yjs
WebSockets. It is an experimental deployment foundation. Provider certification,
per-document sharing, rich text, durable browser offline drafts, HA/failover and
air-gap acceptance remain separate work.

## Host commands

Use Node.js 22 or newer and the pinned dependencies:

```sh
npm ci --ignore-scripts
npm run server:check -- --config /absolute/path/server.json
npm run server:init -- --config /absolute/path/server.json --component accounts
npm run server:init -- --config /absolute/path/server.json --component documents
npm run server:init -- --config /absolute/path/server.json --component live
npm run server:init -- --config /absolute/path/server.json --component sessions
npm run server:account -- --config /absolute/path/server.json --input /absolute/path/account.json
npm start -- --config /absolute/path/server.json
```

Run these commands from `opendoc/`. The configuration-only check makes no network
requests and opens no listener. Initialization needs a separately configured
administrative role and refuses an existing schema. Initialize only the remaining
fresh components after a partial installation; never delete existing data to
repeat initialization. Ordinary startup checks compatibility and never migrates,
seeds accounts/documents or rotates keys. Account provisioning takes this exact
shape, with your registered issuer/subject and internal identifiers:

```json
{
  "issuer": "https://identity.example.test/realms/opendoc",
  "subject": "the-exact-provider-subject",
  "principalId": "example-editor",
  "tenantId": "example-team",
  "role": "editor"
}
```

Do not put passwords, keys or client secrets in command arguments. Use mounted
secret files and keep configuration/account input private. Account provisioning
must match the configured issuer and active tenant. No administration route is
exposed over HTTP. Existing principal/membership conflicts and uncertain commits
fail without automatic mutation retries.

## Configuration

Start from [`deploy/server.example.json`](../deploy/server.example.json). Paths
are relative to the configuration file. The active tenant is fixed server-side.
The four non-system schemas must be distinct. JSON has a 64 KiB limit, rejects
duplicate keys and unknown fields, and is decoded as strict UTF-8.

`database` uses explicit host, port, database, user, password-file and TLS options.
Remote database TLS always verifies certificates, using `database.caFile` when
needed. `administration` supplies only a separate user and password file for the
same target database; do not mount that credential in the ordinary server.
The auth key is exactly 32 random raw bytes and stays outside PostgreSQL. Every
instance needs the same key, shared-session policy, schemas and provider settings.
An unavailable/mismatched key or schema prevents startup; there is no memory
fallback. Plan key rotation separately.

OIDC endpoints and client authentication are operator-pinned. Register exactly
`<publicOrigin>/auth/callback` with the identity provider. Supported authentication
methods are `client_secret_basic` and `client_secret_post`; RS256 and the existing
browser adapter's protocol constraints apply. No discovery or email linking is
performed. Login requires a provisioned issuer/subject binding and active tenant
membership. A successful configuration check does not establish provider access
or interoperability. See [browser login](browser-login.md).

`live.authorityId` enables the fresh guarded schema described in
[guarded live storage](guarded-live-storage.md). Omit it for existing schema-v1
live storage. The host always uses the transactional live membership guard.
`live.sharedSyncIntervalMs` explicitly enables bounded shared-primary polling.
The sample is single-primary; it must not be redirected to a restored clone,
read replica or divergent database without a separately tested recovery plan.

## TLS, ingress and probes

`server.mode` is one of:

- `direct-tls`: Node reads `tlsCertificateFile` and `tlsKeyFile` and serves HTTPS.
  Certificates must match the public hostname and be valid. `tlsCaFile` supplies
  the health probe's trust chain for a private CA.
- `proxy`: a private TLS ingress preserves the exact configured public Host and
  strips `Forwarded` and every `X-Forwarded-*` header. Set `privateIngress: true`
  explicitly. Restrict access to the private Node listener with network policy.
- `development`: both application and identity provider use loopback HTTP; the
  public origin must match the listener address/port. Plaintext PostgreSQL is
  permitted only for an explicit loopback database in this mode.

HTTP and WebSocket upgrades enforce the same exact Host and forwarded-header
policy. Configure ingress health checks accordingly. A typical ALB adds
forwarding headers; place an explicitly configured private stripping proxy in
front of the host rather than weakening its origin policy.

`GET /healthz` reports process liveness; `GET /readyz` probes compatible database
metadata and session-key/policy/live-authority bindings. These are no-store,
generic responses. They do not inspect every document/session, certify database
integrity or verify the provider's availability. Readiness is single-flight with
a finite response deadline; a timed-out operation retains its admission until
it actually settles. The default readiness deadline is 3000 ms and can be
tightened with `limits.readinessTimeoutMs`.

The container probe uses `node src/server-health.mjs /run/opendoc/server.json`.
It sends the canonical Host and verifies TLS with the configured hostname/SNI
and CA. It never disables certificate checks. Proxy-mode local readiness does
not replace an external TLS/ingress probe.

SIGINT/SIGTERM stop admission, fence authentication, close collaboration and
drain tracked HTTP/storage work before ending the pool. The default absolute
shutdown deadline is 10 seconds (configurable between 100 ms and 30 seconds).
Forced shutdown exits nonzero and explicitly leaves pending commit outcomes
uncertain. It is not safe to retry an administrative mutation blindly after a
timeout or process crash.

## TLS-enabled Compose reference

Requires Docker Engine with Compose, Node.js and OpenSSL. This is a loopback
reference deployment with persistent PostgreSQL, not a production cloud recipe.
The PostgreSQL service has no published host port. Application HTTPS is bound to
`127.0.0.1:8443`. Generated local CA credentials expire in 30 days; use your actual
public/private CA, hostname, backup policy and identity registration for a real
installation. Do not bypass a browser certificate warning: install the local CA
through your approved trust-management process first.

```sh
node opendoc/deploy/prepare-reference.mjs
docker compose -f opendoc/deploy/compose.yml build app
docker compose -f opendoc/deploy/compose.yml up -d --wait postgres
```

The preparation script refuses an existing `.reference` directory. It creates
private local credentials and certificates, not users or a production identity
provider. Edit `.reference/server.json` for your provider and copy its client
secret to `.reference/secrets/client-secret` using your secret-management tools.
Do not use `--synthetic-client` for real login: that option supplies a placeholder
only for CI's container readiness test. Keep the generated directory private;
never commit it. Ensure the mounted client-secret file is readable by container UID 1000 (or an explicitly chosen container UID), while retaining the private parent directory. File mounts make selected files readable to the non-root
container; the generated parent directory is mode 0700. Do not mount the local
CA's private key in either application or database containers.

Initialize components and grant the runtime role its required access:

```sh
for component in accounts documents live sessions; do
  docker compose -f opendoc/deploy/compose.yml --profile admin run --rm admin init --config /run/opendoc/server.json --component "$component"
done
docker compose -f opendoc/deploy/compose.yml exec -T postgres psql -v ON_ERROR_STOP=1 -U opendoc_admin -d opendoc < opendoc/deploy/runtime-grants.sql
docker compose -f opendoc/deploy/compose.yml up -d --wait app
```

The grants file applies to the sample schema names; review it if changing them.
It gives runtime account lookup/row-lock permissions without account mutation,
and document/session table permissions without schema creation. Provision an
account explicitly before signing in. When running the administrator container
with an account input file, add a read-only mount for that file and pass its
container path to `account --config ... --input ...`.

Use `docker compose ... down` to stop services while retaining the database
volume. `down -v` permanently removes the volume and is intended only for
disposable test installations. Recreating a database volume invalidates sessions
and removes documents; it is not an upgrade or backup strategy.

## Publication and acceptance

The image publication workflow runs only after the main-branch validation
workflow succeeds, including PostgreSQL 16/17 integration tests and container
TLS/readiness/restart checks. It targets `ghcr.io/repetere/opendoc` with an
immutable `sha-<commit>` tag and a moving `latest` tag. Prefer the verified digest
for deployment. Registry availability and a live application deployment are
separate release evidence; a workflow definition alone does not publish an image.

AWS deployment requires a selected host, database, public hostname/certificate,
OIDC registration, runtime secrets and operating budget. Nothing in `npm start`,
the image or this reference provisions paid resources. Production sign-in,
capacity, backup/restore and air-gap acceptance remain unverified until tested
against the actual target.

See the [server design](intent/server/server-design.md) and
[requirements](intent/server/server-specs.md) for the implementation contract.

## Verified foundation checks

[Server CI](https://github.com/repetere/gpdoc-components/actions/runs/43643316249) passed Node 22/24 tests, PostgreSQL 16/17 integration (including actual server-process OIDC sign-in, concurrent live edits and persistence across restart), and a non-root container test using TLS to PostgreSQL and the application, explicit restricted-runtime grants, health checks and restart. This evidence applies to the reference composition and synthetic provider, not an operator production environment.
