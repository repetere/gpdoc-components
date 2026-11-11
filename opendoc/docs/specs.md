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

The initial implementation narrows portability to an HTTP/auth/storage contract and profile trust. Tests do not imply enterprise login, durable storage, document ACLs, distributed collaboration, encryption-at-rest guarantees, cloud deployments or air-gap operation. A later implementation must add requirements/tests before advertising those capabilities.
