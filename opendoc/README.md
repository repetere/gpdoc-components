# OpenDoc foundation

An original, MIT-licensed foundation for portable document services in `gpdoc-components`.

**v0.2 is an adapter foundation, not a production collaborative editor.** It implements a text-document API, tenant/role boundaries, revision checks, signed deployment profiles, PostgreSQL storage and strict access-token validation. It does not include a full GPDoc web application or extension.

[OpenDoc overview](https://repetere.github.io/gpdoc-components/opendoc/) · [API design](docs/design.md) · [Deployment references](docs/deployment.md) · [Profile contract](docs/profile.md) · [PostgreSQL](docs/postgres.md) · [Authentication](docs/authentication.md)

## Run locally

Requires Node.js 22 or newer. Install the pinned dependencies before running the complete test suite. The simple memory demo itself still uses only the Node standard library. The access-token adapter uses `jose`; PostgreSQL integration tests use `pg`. See [dependency boundaries](docs/dependencies.md).

```sh
git clone https://github.com/repetere/gpdoc-components.git
cd gpdoc-components/opendoc
npm ci --ignore-scripts
npm test
npm run demo
```

The demo listens on `http://127.0.0.1:8787` and prints a random, temporary bearer token. In a second terminal, set `TOKEN` to that value. Do not put tokens in URLs, source files or shared logs.

```sh
export TOKEN='<temporary token from the local terminal>'
curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8787/api/v1/session

curl -i -X POST http://127.0.0.1:8787/api/v1/documents \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"id":"hello","title":"Hello OpenDoc","content":"# Hello\nA local document.\n"}'

curl -i -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8787/api/v1/documents/hello

curl -i -X PUT http://127.0.0.1:8787/api/v1/documents/hello \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'If-Match: "1"' \
  --data '{"title":"Hello OpenDoc","content":"# Updated\n"}'
```

The update returns ETag `"2"`. Reusing `"1"` returns `412`; read the current version and reconcile. Repeating a create returns `409`. There is no automatic mutation retry or offline queue. Stop the demo with Ctrl-C. **All documents and the token disappear on restart.** Use synthetic documents, not valuable or sensitive data.

`PORT=8788 npm run demo` changes the port. The demo cannot bind to a public interface. Do not expose it through a proxy or tunnel. It is not intended for untrusted users and has no production abuse protection.

## What works

- Standard `Request`/`Response` document API with injected authentication and storage ports.
- Server-owned tenant isolation, owner/editor writes and viewer/commenter reads.
- Text-preserving create, list, read and atomic conditional replacement in a bounded single-process memory store.
- PostgreSQL document storage with explicit versioned schema initialization, durable revisions, transactional quotas and cross-connection conditional writes. See [database setup and real integration tests](docs/postgres.md).
- Strict RS256 `at+jwt` access-token validation against operator-pinned local JWKS, with issuer/audience/time checks and a separate trusted membership resolver. See [authentication boundaries](docs/authentication.md).
- Exact origin allowlist, authentication independent of CORS, bounded JSON input and sanitized failures.
- Real local HTTP adapter and randomly generated development credentials.
- Closed-schema deployment profile validation and Ed25519 compact-JWS verification with administrator-supplied public keys, deployment binding, expiration and a caller-managed generation floor.

The API never renders document HTML, executes document instructions or fetches linked content. Profiles are metadata, not credentials or permission grants. The profile verifier is a standalone library; the demo does not consume a profile or implement client enrollment.

The default demo remains memory-only with a temporary token. It does not automatically connect to PostgreSQL, create schemas, fetch identity keys or sign anyone in. The new adapters are explicit imports for a host application; they do not turn the default demo into a production server.

## Integration ports

```js
import { createOpenDocHandler } from './src/api.mjs';
import { MemoryDocumentStore } from './src/memory-store.mjs';

const handle = createOpenDocHandler({
  store: new MemoryDocumentStore(),
  authenticate: async request => {
    // Replace with server-side token verification and trusted membership lookup.
    // Returning null denies access. Never trust request JSON or profile roles.
    return null;
  },
  allowedOrigins: ['https://editor.example.test']
});
```

The authenticator returns `{ principalId, tenantId, role }` only after verification. Principal/document IDs must match `[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}`. Tenant IDs match the profile contract: `[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}`. Map an external issuer/subject to a stable internal principal ID instead of treating arbitrary provider subjects as these IDs. Every member currently has a role for the entire active tenant, not a per-document ACL. The `commenter` role is read-only until a separate comment API exists.

Store adapters implement `list(tenantId)`, `get(tenantId, id)`, `create(tenantId, input)` and `replace(tenantId, id, expectedRevision, input)`. They must scope every query to the tenant and perform the revision comparison and write atomically. `get` returns `null` for missing documents; conflicts use `StoreError` from `src/memory-store.mjs`. Reference store bounds are 100 documents per tenant, 1,000 documents total and 16 MiB of combined ID/title/content bytes. These are evaluation bounds, not production quotas or complete process-memory limits.

See [the design](docs/design.md) for routes, statuses and decisions, and [specs](docs/specs.md) for test traceability. Source imports are supported directly. The package is marked `private` only to prevent accidental npm publication; its original code is covered by the root MIT license.

## What remains

- Complete enterprise OIDC/Ping login, provider-specific interoperability, live key rotation/revocation and tenant membership administration. The new validator supports a strict RFC 9068-style token profile, not every provider’s default token format.
- Production PostgreSQL operations and upgrades, persistent ACL/membership management, object-storage adapters and backup/restore validation.
- Document-specific sharing, public-link policy, audit export and Yjs collaboration.
- Configurable web and rebrandable extension clients with managed enrollment.
- Executable cloud infrastructure and provider integration tests.
- Air-gap bundle with a complete deployment SBOM/license inventory, blocked-egress tests and offline operational validation.

AWS, GCP, Azure and open-source Kubernetes are **reference targets**, not deployed implementations. Read the [configuration and acceptance checklist](docs/deployment.md). No cloud account, paid resource or third-party identity application is created by this repository.

## License and contribution boundary

The repository's [MIT license](../LICENSE) covers this new OpenDoc code. This does not grant rights to unrelated applications, third-party services, logos or trademarks. Existing [brand reservations](../assets/NOTICE.md) still apply. Contribute original code or code with verified compatible licenses and provenance. Do not copy proprietary applications or organization-specific configuration into this public repository.

Security issues should be reported privately to the contact in the [repository README](../README.md#privacy-and-support), without attaching credentials or real documents to public issues. This reference has tests but has not undergone an external security audit.
