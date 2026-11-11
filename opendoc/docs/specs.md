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

The current foundation narrows portability to HTTP/auth/storage contracts, profile trust and an experimental collaboration protocol. The PostgreSQL adapter tests establish the exercised local SQL behaviors, not production backup/restore, database failover or cloud operations. Token tests establish strict pinned-key validation, not a complete enterprise login. Tests do not imply document ACLs, distributed collaboration, encryption-at-rest guarantees, cloud deployments or air-gap operation. A later implementation must add requirements/tests before advertising those capabilities.

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
