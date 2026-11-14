# Deployable server requirements

- [x] **OD-SERVER-001:** When loading server configuration or account input, the host shall enforce bounded fatal UTF-8 JSON, duplicate-key/depth rejection, closed schemas and detached validated configuration before network or listener activity.
- [x] **OD-SERVER-002:** The host shall read bounded regular mounted secret/certificate files, use verified TLS for remote PostgreSQL, require exact HTTPS public/provider origins outside explicit loopback development, and keep credentials out of argv, responses and diagnostics.
- [x] **OD-SERVER-003:** When starting, the host shall compose the existing PostgreSQL document/account/live/shared-auth adapters, browser OIDC and bundled editor, with live account-write fencing and explicit shared-primary/guarded-history options.
- [x] **OD-SERVER-004:** When startup or readiness probes run, each PostgreSQL adapter shall validate compatible schema metadata and configured session key/policy or live authority without document/session mutation, implicit bootstrap or secret disclosure.
- [x] **OD-SERVER-005:** When HTTP or WebSocket upgrade traffic arrives, the host shall reject missing/duplicate/wrong Host and forwarded headers before dispatch, preserving exact origins and route restrictions.
- [x] **OD-SERVER-006:** The host shall expose bounded, single-flight readiness and liveness responses with no-store headers; dependency failure, incompatible state and draining shall fail readiness without acknowledging unsettled work as complete.
- [x] **OD-SERVER-007:** When shutdown begins or startup fails, the host shall stop admission, close authentication and collaboration, track actual admitted storage/HTTP work, release resources and report forced shutdown at a fixed deadline without claiming uncertain commits failed or succeeded.
- [x] **OD-SERVER-008:** Administrative CLI commands shall initialize one explicitly selected fresh component or provision one explicit account using separate credentials; ordinary startup shall never migrate, initialize, enroll or retry an uncertain mutation.
- [x] **OD-SERVER-009:** Configuration checking shall validate local secrets, TLS material and bundled assets without contacting a database/provider or binding a listener, and every CLI failure shall have sanitized diagnostics and nonzero exit status.
- [x] **OD-SERVER-010:** The distribution shall include pinned runtime PostgreSQL dependencies, a non-root container, Host/TLS-correct health probe, mounted-secret Compose reference and operator instructions preserving existing experimental/production boundaries.
- [x] **OD-SERVER-011:** Isolated PostgreSQL tests shall exercise actual server composition, explicit initialization/provisioning, OIDC sign-in, persisted sessions/documents, role denial, invalid configuration/schema/key, and restart/shutdown; tests shall not target operator databases.

## Edge decisions

Public mode uses direct TLS or an explicit private TLS ingress; forwarding headers
are never trusted. Container-to-database traffic is TLS even on a Compose network.
REST and live documents keep distinct authorities. One active tenant per server
is explicit. Metadata readiness is not full database-integrity or provider-health
certification. Fresh schema bootstrap is per component, with no automatic repair.
Incompatible guarded history and shared authentication state remain unavailable.
Forced process exit preserves acknowledgement uncertainty rather than retrying.

All server behavior stays within the existing portable adapter architecture.
Document ACLs, rich text, branding, provider certification and cloud provisioning
are separate requirements and cannot be inferred from a successful server start.
