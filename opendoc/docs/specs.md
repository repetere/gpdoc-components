# OpenDoc foundation requirements

- **OD-API-001:** The runtime shall accept standard Requests and return Responses without a cloud-provider SDK dependency.
- **OD-API-002:** When a request lacks valid authentication, protected routes shall return 401 without exposing document data.
- **OD-API-003:** When a principal accesses documents, the runtime shall derive tenant scope and role from server authentication rather than client payloads.
- **OD-API-004:** When a viewer or commenter attempts a write, the runtime shall return 403 before changing state.
- **OD-API-005:** When an update lacks the current ETag, the runtime shall reject it without overwriting the document.
- **OD-API-006:** When JSON, paths or request bodies exceed supported bounds or contain unknown fields, the runtime shall reject them safely.
- **OD-API-007:** The runtime shall preserve text without executing, rendering or fetching document content.
- **OD-API-008:** When a browser origin is supplied, the runtime shall reject origins outside the configured allowlist.
- **OD-API-009:** Capabilities and documentation shall identify volatile storage, tenant-level roles and unimplemented production features accurately.
- **OD-API-010:** The Node demo shall bind only to loopback and shall not accept URL-carried bearer credentials.
- **OD-PROFILE-001:** Profile validation shall reject malformed, unknown, expired or unsupported configuration before using endpoints.
- **OD-PROFILE-002:** Signed profile verification shall use externally supplied trusted keys and shall reject embedded key or URL trust overrides.
- **OD-PROFILE-003:** Signed profile verification shall enforce deployment identity and a caller-provided generation floor.
- **OD-PROFILE-004:** The profile module shall make no network or filesystem calls.
- **OD-PROFILE-005:** Profiles shall contain no secrets or client-supplied role grants.

Profile tests use descriptive sub-contract tags: `OD-PROFILE-SCHEMA` and `OD-PROFILE-TIME` implement 001/005; `OD-PROFILE-SIGNATURE` and `OD-PROFILE-ENCODING` implement 002; `OD-PROFILE-BINDING` implements 003; `OD-PROFILE-LOCAL` implements 004. The profile contract defines their exact encoding and host responsibilities.

## Intent edge audit

The current foundation narrows portability to HTTP/auth/storage contracts, profile trust, a bounded browser login adapter and an experimental collaboration protocol. The PostgreSQL adapter tests establish the exercised local SQL behaviors, not production backup/restore, database failover or cloud operations. Token and browser-login tests establish pinned identity verification with a synthetic local provider, not enterprise SSO certification. Tests do not imply document ACLs, distributed collaboration, encryption-at-rest guarantees, cloud deployments or air-gap operation. A later implementation must add requirements/tests before advertising those capabilities.

## Adapter requirements

- **OD-PG-001:** Schema initialization shall be explicit and shall refuse existing schemas; constructors shall not migrate or connect implicitly.
- **OD-PG-002:** Every PostgreSQL document operation shall bind tenant scope as a parameter and return detached snapshots.
- **OD-PG-003:** Conditional replacement shall be transactional across connections; at most one writer may consume a revision.
- **OD-PG-004:** Capacity limits and counters shall persist and change atomically with document mutations across connections.
- **OD-PG-005:** Opaque document strings and revisions shall survive connection and application-process restarts.
- **OD-PG-006:** Listing shall return the full bounded tenant list or fail explicitly rather than silently truncate when capacity is inconsistent.
- **OD-PG-007:** Driver failures shall be sanitized; transactions shall roll back and connections shall be released or discarded appropriately.
- **OD-PG-008:** Integration tests shall require explicit synthetic loopback targets and clean up only objects they created.
- **OD-AUTH-001:** Access-token validation shall verify pinned RS256 signatures, the exact supported access-token type, issuer, audience and bounded temporal claims before membership lookup.
- **OD-AUTH-002:** Only trusted server membership shall determine internal principal, active tenant and role; token roles and tenant claims shall not authorize access.
- **OD-AUTH-003:** Keys and issuer policy shall come from operator configuration, never token URLs or payloads; validation shall not fetch keys or enroll clients.
- **OD-AUTH-004:** Invalid credentials shall deny access, while membership outages shall remain sanitized operational failures.


## Experimental collaboration requirements

- **OD-COLLAB-001:** The WebSocket adapter shall authenticate before returning room data, derive scope/role only from trusted membership, enforce an exact origin policy and reject URL-carried credentials.
- **OD-COLLAB-002:** Writes shall merge Yjs state durably before acknowledging or broadcasting. Replaying the same update shall not create a new revision when state is unchanged.
- **OD-COLLAB-003:** Tenant/room scope shall be bound to the authenticated connection. Read-only members shall not change room state; receivers shall be reauthorized before snapshots and fan-out, with idle revalidation.
- **OD-COLLAB-004:** Independent clients shall converge after concurrent edits and reconnect with retained local edits. Stored snapshots shall survive service and connection-pool restarts.
- **OD-COLLAB-005:** Collaboration schemas shall be explicitly initialized in fresh namespaces, separate from REST documents. Room quotas and snapshots shall change atomically across database connections.
- **OD-COLLAB-006:** Untrusted Yjs parsing shall run in disposable time/heap-limited workers with bounded bytes, structures, nesting and pending state. This is not an OS memory sandbox or a complete denial-of-service guarantee.
- **OD-COLLAB-007:** Connections, queues, dependency work and send buffers shall be bounded. Dependency errors shall be sanitized and uncertain writes shall not be acknowledged as successful.
- **OD-COLLAB-008:** Clients shall use the documented custom protocol, keep credentials out of URLs, reject malformed state frames and stop on oversized replay rather than silently discard local edits.

The integration suite composes synthetic signed access tokens, real loopback WebSockets, multiple Y.Docs and real PostgreSQL. It does not exercise a browser editor, an external identity provider, multiple live fan-out instances, database crash recovery or a disconnected network deployment. The REST capabilities endpoint remains scoped to the REST handler; collaboration must be attached separately.

## Browser login and account requirements

- **OD-LOGIN-001:** Browser login shall use authorization code with S256 PKCE, single-use state bound to a browser transaction cookie, nonce and verified RS256 ID-token signatures against operator-pinned endpoints and issuer. Invalid, cancelled, replayed or expired flows shall not establish a session.
- **OD-LOGIN-002:** Provider tokens shall remain server-side and shall not be retained in local sessions. Browsers shall receive opaque, bounded, non-sliding HttpOnly sessions with Secure host-only cookies outside explicitly enabled loopback development. Unsafe authenticated requests shall require exact-origin, JSON and session-bound CSRF verification.
- **OD-LOGIN-003:** Only fresh server-owned membership shall authorize requests and collaboration. Login shall not auto-enroll identities. Logout, session rotation, expiry and superseded login intents shall fence pending work, including a stalled request body, PKCE digest, token exchange or membership lookup.
- **OD-LOGIN-004:** Browser collaboration tickets shall be short-lived, room/session-bound and bound to one server-generated connection ID. Session or membership revocation shall deny subsequent use; credentials shall never travel in WebSocket URLs.
- **OD-LOGIN-005:** Session, transaction, ticket and dependency concurrency shall be bounded. Unsettled timed-out work shall retain its admission slot, and late results shall not mint credentials. Pinned provider fetches shall reject redirects and enforce response/time limits.
- **OD-ACCOUNT-001:** Account bootstrap shall be explicit in a fresh schema. Exact issuer/subject bindings shall be immutable, length-bounded and lossless for well-formed Unicode; malformed encodings or conflicting associations shall fail closed.
- **OD-ACCOUNT-002:** Principals, identity bindings and tenant memberships shall be provisioned only by explicit administrative APIs. Client claims and email addresses shall never link accounts or grant roles. Provisioning shall not reactivate a disabled principal.
- **OD-ACCOUNT-003:** Membership lookups shall bind the active tenant and read current roles, revocations and principal state under the documented database barrier. Runtime lookup privileges shall be separable from administrative writes.
- **OD-ACCOUNT-004:** Administrative mutations and quotas shall be atomic across connections, persistent across pool/process restart and fail closed on uncertain outcomes without automatic mutation retries. Database failures shall remain sanitized.

`browser-oidc.test.mjs` covers protocol and lifecycle failures; `browser-login.integration.test.mjs` covers real local provider HTTP/JWKS flows, REST and WebSocket composition. `account-store.test.mjs` covers account validation and driver failure contracts. The PostgreSQL account and browser-account integration suites cover actual database isolation, persistence and revocation. A local Chromium smoke test additionally exercises synthetic consent, cancellation, editor writes, viewer denial and logout. This does not establish production TLS/SameSite behavior, external-provider compatibility or production multi-instance service safety.

## Shared authentication and REST editor requirements

- **OD-SHARED-001:** Shared authentication state shall be bound to the operator's deployment trust and policy configuration. Mismatched configuration, encryption keys, corrupted records and unavailable storage shall fail closed rather than silently create another authority.
- **OD-SHARED-002:** Login-intent supersession, callback consumption, session rotation/logout and ticket binding shall be atomic across instances. No database lock shall span identity-provider or membership I/O. A completed revocation shall fence pending work that attempts to reuse the revoked state.
- **OD-SHARED-003:** Persisted credential material shall be authenticated-encrypted with an operator-owned key kept outside the database and repository. A successful state write shall not imply that a timed-out client received credentials; uncertain outcomes shall not be blindly retried.
- **OD-SHARED-004:** Bootstrap shall require a fresh explicit schema, durable state and expiry shall be bounded, and constructors shall not implicitly migrate. Instances sharing a namespace shall enforce compatible quotas and use database time for durable expiry decisions.
- **OD-SHARED-005:** Tests shall exercise login/callback across instances, cross-instance session use/logout, replay, delayed completion, ticket binding and process restart against real local PostgreSQL. Passing these tests shall not imply database failover, key rotation, multi-instance collaboration or production HA certification.
- **OD-EDITOR-001:** The browser editor shall treat title/content as plain text and shall not execute or render document HTML, fetch document links, or persist document bodies or credentials in browser storage.
- **OD-EDITOR-002:** Document mutations shall carry session-bound CSRF and the exact current revision. The interface shall distinguish editable and read-only roles, while the server remains the authorization authority.
- **OD-EDITOR-003:** Dirty navigation, sign-out and conflict recovery shall preserve unsaved work until the user makes an explicit discard/reconciliation choice. A lost write response shall not be treated as evidence of failure or success without reconciliation.
- **OD-EDITOR-004:** Delayed or repeated operations shall not overwrite newer navigation, edits or account state. Drafts belonging to one principal/tenant shall never become writable as another account after session expiry or replacement.
- **OD-EDITOR-005:** Client hosting shall use explicit same-origin routes and security headers without document-controlled paths, filesystem traversal or external client assets. Synthetic login/demo listeners shall remain opt-in loopback evaluation fixtures.

The REST editor does not claim live collaboration, offline persistence, document sharing or rich-text rendering. Shared authentication state is independent of the separate experimental Yjs room/fan-out model.
