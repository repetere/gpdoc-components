# OpenDoc foundation design

OpenDoc is an independently implemented, MIT-licensed foundation for portable document services. The v0.8 foundation supplies a runnable local reference API, memory and PostgreSQL document-store adapters, explicit authentication/authorization boundaries, a pinned-key access-token validator, signed deployment-profile verification, experimental authenticated Yjs collaboration, an OIDC browser-login/account-mapping foundation, optional shared auth state, a REST text editor and an opt-in live Yjs text editor with automatic short-lived ticket renewal bounded reconnect, and opt-in periodic synchronization through one shared PostgreSQL authority. It does not contain the full GPDoc application.

## Current scope

The API consumes standard `Request` objects and returns `Response` objects. A Node HTTP adapter hosts it on loopback for local evaluation. An in-memory store provides revision-checked text documents. An injected authenticator resolves a server-owned principal, tenant and role; the default demo uses temporary development bearer credentials rather than enterprise identity. The optional PostgreSQL adapter implements the same port with transactions. The optional access-token adapter verifies strict RS256 `at+jwt` tokens using operator-provided JWKS and resolves membership through a trusted server callback. Neither adapter is silently enabled by the demo.

The signed profile module verifies administrator-pinned Ed25519 keys without network access. It is a configuration trust primitive, not an OIDC login client. No document, workspace or downloaded profile can add its own trusted key.

The optional [collaboration adapter](collaboration.md) serves separate Yjs rooms over a custom authenticated WebSocket protocol. Its PostgreSQL schema is separate from the text-document schema. There is deliberately no automatic conversion or dual writing between REST text documents and Yjs rooms. The REST capabilities endpoint describes only the REST handler, so `liveCollaboration` remains false there; a host must explicitly attach the collaboration listener.

The optional [browser-login adapter](browser-login.md) handles authorization-code login with PKCE and keeps provider tokens server-side. Opaque browser sessions resolve server-owned [account mappings](accounts.md), and its REST wrapper adds CSRF checks. Short-lived room-bound tickets bridge browser sessions to the existing collaboration protocol without exposing provider tokens. This is a separate explicit host integration; the original temporary-token demo is unchanged. Optional [shared auth state](shared-sessions.md) coordinates browser transactions, sessions and tickets in PostgreSQL. It does not make collaboration fan-out multi-instance or establish a production HA deployment. The original [web client](web-client.md) edits revision-checked REST text documents. The opt-in [live editor](live-editor.md) edits a separate [live document collection](live-documents.md), whose Yjs state is authoritative. Optional [shared live synchronization](shared-collaboration.md) periodically propagates committed revisions between servers using the same fixed PostgreSQL primary and schema; it is not a distributed leader or multi-primary protocol. Snapshot replacement is not supported for live documents, and no automatic conversion or dual writing links the two collections.

## API contract

- `GET /healthz`: process liveness, no user information.
- `GET /api/v1/capabilities`: truthful implemented features and version.
- `GET /api/v1/session`: authenticated principal, active tenant and server-owned role.
- `GET /api/v1/documents`: authenticated list of documents in the active tenant.
- `POST /api/v1/documents`: create a text document for the active tenant. Body contains `id`, `title` and `content` only.
- `GET /api/v1/documents/{id}`: authenticated read with an ETag.
- `PUT /api/v1/documents/{id}`: replace title/content only, using `If-Match` with the exact ETag.

All document authorization is derived from the injected server authenticator. Request JSON, query parameters and document text cannot select another tenant or grant a role. Owners/editors may write; commenters/viewers may read. This foundation uses tenant-level roles and does not claim document-specific sharing/ACL management. No delete endpoint is provided.

The server preserves document text as an opaque UTF-8 string. It never executes embedded instructions, fetches linked resources or renders untrusted HTML. Each successful write creates a new revision. A conditional retry after a lost response may return a conflict; the client must read and reconcile, not assume mutation idempotency.

## Boundaries and limits

In-memory documents disappear when the process exits. The demo is not a production server, does not implement OIDC sign-in, and is restricted to loopback. API CORS is denied by default; an allowed-origin list is explicit. Authentication is independent of origin checks. JSON request size, content length, document IDs and list size are bounded. Responses do not cache credentials or document content.

Production work remains: production OIDC provider and desktop-login validation, production session/key operations and membership/ACL administration UI, production PostgreSQL deployment and recovery, native S3/GCS/Azure Blob adapters, event-driven collaboration scaling and database failover fencing, deliberate REST/Yjs import and export, managed client enrollment, cloud infrastructure, rich-text and extension clients, backup/restore and network-isolated acceptance. Choosing a cloud target or a profile flag is not evidence of readiness.

## Decisions and alternatives

| Decision | Choice | Reason |
| --- | --- | --- |
| Source boundary | New standalone implementation | Public format/components do not imply distribution of unrelated applications or marks. |
| Runtime | Standard Request/Response core and Node adapter | Keeps the HTTP platform separate from document/auth ports. |
| Persistence | Default memory demo; explicit PostgreSQL adapter | Keeps evaluation safe while testing SQL durability and atomic writes separately. |
| Identity | Temporary demo credentials; optional bearer validator and OIDC browser-session adapter | Test a standard local identity provider and explicit account mapping without claiming production provider interoperability. |
| Live editing | Experimental, separate authenticated Yjs rooms | PostgreSQL merges commit before broadcast; one listener provides live fan-out. Cross-instance delivery and full editor integration remain unimplemented. |

## Traceability

Requirements live in `specs.md`; tests use `@spec` identifiers. Source, fixtures and documentation use synthetic identities and endpoints. The repository's root MIT license applies to new OpenDoc code; reserved branding retains its existing notices.

## Adapter documentation

[PostgreSQL](postgres.md) defines schema creation, persistent limits, pool ownership and integration-test safety. [Authentication](authentication.md) defines the accepted token profile, operator trust configuration and server-owned membership. [Collaboration](collaboration.md) defines its custom protocol, separate schema, resource limits and reconnect contract. [Dependencies](dependencies.md) identifies pinned packages and distribution boundaries.
