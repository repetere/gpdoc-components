# Browser OIDC login and sessions (evaluation foundation)

OpenDoc now includes a browser backend-for-frontend (BFF) adapter in
`src/browser-oidc.mjs`. It uses maintained `openid-client` for the authorization
code protocol, S256 PKCE, state, nonce, token claims and ID-token signatures.
It does not use browser-provided roles, tenant IDs or email addresses to authorize
access. The default is a **bounded, single-process, in-memory evaluation implementation**.
An optional [shared PostgreSQL auth-state adapter](shared-sessions.md) durably
shares login intents, transactions, sessions and tickets across instances. Neither
mode is production SSO certification, a Ping integration claim or air-gap validation.

## Operator-owned trust

Register an OIDC client with one exact redirect URI ending in `/auth/callback`.
Configure these values on the server, never from a browser request, document or
deployment-profile claim:

```js
import { createBrowserOidc } from '../src/browser-oidc.mjs';
import { PostgresAccountStore } from '../src/account-store.mjs';
import { attachCollaborationServer } from '../src/collaboration-server.mjs';

const accounts = new PostgresAccountStore({ pool, schema: 'opendoc_accounts' });
const browser = createBrowserOidc({
  issuer: 'https://identity.example.org',
  clientId: 'opendoc-browser',
  clientAuthentication: {
    method: 'client_secret_basic',
    clientSecret: process.env.OPENDOC_OIDC_CLIENT_SECRET,
  },
  redirectUri: 'https://documents.example.org/auth/callback',
  authorizationEndpoint: 'https://identity.example.org/authorize',
  tokenEndpoint: 'https://identity.example.org/token',
  jwksUri: 'https://identity.example.org/jwks',
  activeTenantId: 'organization',
  resolveMembership: accounts.resolveMembership.bind(accounts),
  successPath: '/',
});
const handle = browser.createHandler({ store: documentStore });
const collaboration = attachCollaborationServer({
  server: httpsServer,
  store: collaborationStore,
  authenticate: browser.authenticateCollaboration,
  allowedOrigins: ['https://documents.example.org'],
});
```

The example assumes an initialized account schema and separately provisioned
accounts/memberships. No login auto-provisions accounts. The only identity lookup
is `resolveMembership({issuer, subject, activeTenantId})`; it must return the
internal `{principalId, tenantId, role}` or `null`. Match the exact issuer and
case-sensitive subject, and do not link users by email. The active tenant comes
from server configuration. Membership and role are read again for each request
and each collaboration authentication/revalidation. Disabling the principal,
revoking its membership, changing its mapped principal or deleting the session
denies further use. Existing transport revalidation also covers idle sockets.

The supported client-authentication methods are explicitly selected
`client_secret_basic`, `client_secret_post`, or `none` (registered public client).
Secrets stay on the server. Keep them in the operator's secret system, never in
source, browser assets or logs. The current adapter deliberately supports RS256
ID tokens only. The provider must return the authorization-response `iss`
parameter; it must match the pinned issuer exactly. ID tokens must be newly
issued (within five minutes), with at most one hour between `iat` and `exp`.

There is no discovery, dynamic registration, refresh flow, UserInfo call or
provider-logout flow. Authorization, token and JWKS endpoints are explicit
operator trust. Provider access, refresh and ID-token strings are not stored in
sessions, returned to JavaScript or copied to document storage. Logging the
callback query, authorization code, cookies or token endpoint body is unsafe.

## HTTP integration contract

The adapter takes standard `Request` objects and returns `Response` objects. It
never starts a network listener. The host application must:

- Serve the application and auth routes on the configured HTTPS origin, with a
  valid certificate and appropriate HSTS policy.
- Reject untrusted Host/forwarded headers and absolute request targets. Construct
  `Request.url` from the configured canonical origin, not unchecked user headers.
- Allow the authorization response query only on `/auth/callback`. Do not rewrite
  or log its code/state. Route authenticated REST through `createHandler({store})`.
- Preserve each separate `Set-Cookie` header, for example using
  `response.headers.getSetCookie()` with a Node HTTP response array. Collapsing
  them with `Object.fromEntries(headers)` breaks login.
- Apply finite header, body, connection and request deadlines. Bound ingress
  before buffering and apply appropriate reverse-proxy rate limits. Do not add
  wildcard CORS or credentialed cross-origin access to auth routes.
- Use a strict application CSP, output escaping and dependency updates. CSRF
  defenses do not protect against same-origin XSS.

The older `startLocalServer` bearer-token demo intentionally rejects query strings
and is **not** the browser-login HTTP adapter. It cannot be reused unchanged.

`createHandler` routes `/auth/*` to the auth implementation and other paths to
the existing REST handler. Before REST writes it verifies the browser session,
exact Origin, JSON Content-Type and CSRF binding. Its underlying `authenticate`
function also checks unsafe-method CSRF, so directly supplying it to the REST
handler does not accidentally permit unchecked cookie-authenticated mutations.
Do not combine browser cookies and bearer credentials on one request. Keep the
existing access-token adapter on an explicitly separate API integration if needed.

## Browser protocol

1. POST `/auth/login` with `Origin` equal to the configured application origin,
   `Content-Type: application/json`, `X-OpenDoc-Login: 1` and body `{}`.
   The server sets a short-lived, HttpOnly transaction cookie and returns
   `{authorizationUrl}`. Navigate to this server-returned URL. The strict Origin
   and non-simple header protect this pre-session entry point; no client-selected
   return URL, principal, tenant, role or extra request fields are accepted.
2. The provider redirects to GET `/auth/callback?code=...&state=...&iss=...`.
   The server requires the matching browser transaction cookie, consumes the
   transaction before exchanging the code, verifies PKCE, nonce, issuer, audience
   and signature, and resolves the internal membership. A successful callback
   rotates the session and CSRF secret, clears the transaction cookie and returns
   HTTP 303 to the operator's fixed local `successPath`.
3. GET `/auth/session` returns only
   `{principalId, tenantId, role, csrfToken, expiresAt}`. `expiresAt` is milliseconds
   since the Unix epoch. The session bearer stays in a host-only, HttpOnly cookie.
   Keep the returned CSRF secret in memory. Session reads never extend lifetime.
4. All authenticated browser writes, including document writes, ticket creation
   and logout, send the cookie automatically, exact `Origin`,
   `Content-Type: application/json` and `X-OpenDoc-CSRF: <csrfToken>`.
   The random secret must match both the server's session record and the separate
   host-only CSRF cookie. That cookie is also HttpOnly; JavaScript obtains the
   secret only from `/auth/session`. No GET endpoint performs a state-changing
   authenticated action.
5. POST `/auth/logout` with the same CSRF headers and body `{}`. This invalidates
   the local session and every ticket belonging to it, then clears the cookies.
   It does not terminate the upstream provider's SSO session. Another login may
   therefore succeed without an upstream password prompt.

Production cookie names begin `__Host-opendoc-`, with `Path=/`, `Secure`,
`HttpOnly`, `SameSite=Lax` and no Domain attribute. There are distinct transaction,
session and CSRF cookies. Unknown, malformed or duplicate cookies cannot select
an identity. Errors are sanitized, carry no provider exception detail and use
`Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Auth success responses
also use these policies. Failed/cancelled callbacks consume and clear pending
transactions; replay and missing/mismatched state, cookie, issuer or code fail.
Starting a new login replaces the pending transaction carried by that browser,
including a callback already awaiting the provider or membership service. Logout
and session rotation cancel pending re-login callbacks associated with the old
session. Superseded or duplicate callbacks do not emit Set-Cookie headers that
could erase a newer login transaction.

## Collaboration without exposing provider tokens

POST `/auth/collaboration-ticket` with body `{roomId: 'document-room'}` and the
same CSRF headers. The response is `{ticket, expiresAt}`. Hold the opaque ticket
in memory only and send it as the existing first WebSocket frame:

```js
socket.send(JSON.stringify({type: 'authenticate', token: ticket}));
```

Never put a ticket, session token or provider token in a WebSocket URL,
subprotocol, localStorage, IndexedDB or document content. A ticket is restricted
to one room and session. On first use it binds atomically to the transport's
random, stable, frozen server-owned `{connectionId}`. Another connection cannot
reuse it. Existing authenticators remain compatible because they may ignore the
new second argument. Do not synthesize the context from a browser message.

Revalidation checks the same session, current account membership and ticket
expiry on every call, including checks after awaited dependencies. The ticket
expires even for an already connected socket, at most 60 seconds after issuance.
The browser must obtain a new ticket and reconnect when it expires. The opt-in
[live editor](live-editor.md) schedules fresh-ticket reconnects before expiry,
revalidates session and membership, and retains unconfirmed CRDT state in the
same tab. It never extends a ticket or browser session. The standalone v1 helper
still leaves renewal to its host. Room authorization remains the existing tenant-role model; this
milestone does not introduce document-specific ACLs or sharing invitations.

For a live document, send exactly `{documentId: 'document-id'}` instead of
`roomId`. The response includes `{ticket, expiresAt, path, identity}`, where
`identity` is exactly `{principalId, tenantId, role}` from authorization of this
specific issuance. A client with retained edits must compare this identity to
its original principal and tenant, not rely only on an earlier session read:
browser cookies can change between the two requests. Validate the exact live
path and current role before opening a socket or replaying state. The server
rechecks authorization on the new connection; response identity metadata does
not confer authority. Tickets for live and standalone routes are not interchangeable.

## Limits, timeouts and lifecycle

`BROWSER_OIDC_LIMITS` exports these defaults. A `limits` object can only tighten
them; values are positive integers:

| Setting | Default |
| --- | ---: |
| `sessionTtlMs` | 1,800,000 (30 minutes) |
| `transactionTtlMs` | 300,000 (5 minutes) |
| `ticketTtlMs` | 60,000 (1 minute) |
| `operationTimeoutMs` | 10,000 |
| `fetchTimeoutMs` | 5,000 |
| `maxSessions` | 1,000 |
| `maxTransactions` | 1,000 |
| `maxTickets` | 1,000 |
| `maxPendingOperations` | 32 |
| `maxProviderResponseBytes` | 262,144 |

The session deadline is the earlier of the fixed configured lifetime and the
verified ID-token expiry. Counts are bounded with admission rejection rather
than silently evicting active users. Expired entries are removed opportunistically
on state operations and `stats()`. With the default memory adapter, `close()`
clears every owned local record and rejects further work. With an external shared
adapter, it stops only this browser instance, preserving durable state and the
caller-owned pool. `stats()` returns counts only, never credentials or personal
information; it is asynchronous for PostgreSQL (`await browser.stats()`).

A timed-out operation keeps its admission slot until the underlying work really
settles. This bounds even an uncooperative membership adapter. Late results cannot
mint sessions or tickets after the response deadline. A transaction that expires
during token exchange or membership lookup cannot create a session. The originating live session and a server-owned login intent are captured before
reading the login request body or calculating PKCE. They are rechecked after
each await and again in the callback. Logout therefore also fences a login
request whose JSON body or PKCE digest is still pending, before a transaction
exists. Newer requests supersede older initiations associated with the same
session or existing browser transaction cookie. Requests from a first-time
anonymous browser without any cookie cannot yet be correlated. Session identity
is rechecked after membership lookup, so concurrent logout or rotation cannot
revive an old session or authenticate a ticket attached to it. A re-login started
while authenticated must finish while that original session is still live;
otherwise restart login after the old cookie has expired.

Provider requests use only the exact configured token endpoint (POST) and JWKS
endpoint (GET), with bounded decoded response size, finite timeout and redirects
set to `error`. The module does not use request data as a fetch destination. TLS
verification is never disabled. Endpoint pinning does not prevent compromised DNS
or an operator from configuring a private network address: production deployments
must enforce DNS/IP and egress policy at the network/proxy layer, review the
provider endpoints, and permit only required destinations. Do not interpret a
syntactically valid HTTPS URL as a complete SSRF defense.

## Explicit loopback development

Set `allowInsecureLoopback: true` only for an entirely loopback configuration:
issuer, endpoints and callback must use `localhost`, `127.0.0.1` or `[::1]`.
HTTP is then allowed for those hosts. Cookies use `opendoc-dev-*`, intentionally
without the `__Host-` prefix or Secure flag. The option never permits public HTTP
hosts and does not start or bind a listener. The caller must bind its development
HTTP server to loopback; the demonstration harness does so explicitly.

For a synthetic browser smoke test, run from `opendoc/` after `npm ci --ignore-scripts`:

```sh
OPENDOC_SYNTHETIC_LOGIN=1 node test/fixtures/browser-login-demo.mjs
```

Open the printed loopback app URL on the same computer. The fixture starts a
separate ephemeral local identity provider with synthetic accounts and keys.
Choose Sign in, select a synthetic identity, approve consent, and try creating a
document. The editor can write; viewer/commenter writes are denied. Cancel must
leave the browser signed out, and Sign out must invalidate the local session.
Restart the fixture to reset its provider session when testing another identity.
Stop it with Ctrl+C. It uses memory documents and memberships, not PostgreSQL;
the separate database integration suite covers durable account composition.
Never enter real credentials or publish/proxy either listener. This is a test
harness, not the OpenDoc web editor or a deployment server.

## Verification and remaining production work

The focused unit suite exercises protocol fault cases, real library signature
checks with synthetic keys, CSRF-enforced writes, replay, session rotation,
revocation, capacity bounds, ticket binding, expiration and late-result fencing.
Separate integration tests use a maintained local `oidc-provider` and real HTTP
code/token/JWKS requests. The provider fixture is synthetic and local only. A
Chromium smoke test on 2026-11-11 additionally verified local HTTP sign-in and
consent, editor document creation, cancellation without a session, viewer write
denial and logout. These checks do not certify Secure cookies on a public HTTPS
deployment, cross-site SameSite/CORS behavior or a full browser compatibility matrix.

This remains a foundation. The optional [shared auth adapter](shared-sessions.md)
now covers durable sessions/transactions, distributed intent/cancellation fences
and atomic ticket binding. Its serialized bounded design is not production HA.
Deployment-wide abuse defenses, production secret rotation and key operations,
provider-specific logout and policy, seamless collaboration renewal,
formal penetration review and production IdP interoperability need separate work.
Restarting the process signs default memory sessions out. PostgreSQL auth state
survives application restarts with the same operator key, namespace and pinned
configuration; bootstrap is explicit and never runs on ordinary startup. No claim
is made that live external-provider behavior, Ping policy, a public TLS deployment
or disconnected/air-gapped operation has been certified.

### Tickets for authoritative live documents

The browser can request `POST /auth/collaboration-ticket` with the exact JSON body `{ "documentId": "document-id" }`, using the current session cookie and its matching `X-OpenDoc-CSRF` header. The response includes `{ ticket, expiresAt, path }`, where `path` is `/api/v1/live-documents/document-id/collaboration`. The ticket is sent only in the initial WebSocket authentication frame, never in a URL or browser storage.

Live document tickets use a distinct internal namespace and cannot authenticate the existing standalone `/api/v1/collaboration/:roomId` route. Standalone `{ "roomId": "room-id" }` requests remain supported with their existing response shape. The live server checks that the document exists and consults current tenant membership before sending ready/state. The browser HTTP handler accepts an explicit `liveStore` option; the same authoritative store must also be attached to the WebSocket host.
