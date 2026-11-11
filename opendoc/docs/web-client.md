# OpenDoc authenticated web editor

`web/` is an original, dependency-free browser client for the OpenDoc REST API.
It is a usable plain-text/Markdown editor, not a rendering or live-collaboration
mockup. It uses the existing browser OIDC backend-for-frontend (BFF) for sign-in,
server-owned tenant membership, session cookies, CSRF protection and sign-out.
No identity provider, database, public listener or cloud service is selected by
the client. The public project page is not a hosted document service.

## What it does

- Lists documents in the authenticated tenant and opens their saved revisions.
- Creates new documents on the first explicit save. Further saves use the last
  read revision in `If-Match`; typing does not send document content.
- Allows owner/editor roles to write. Viewer/commenter roles can read and download
  but cannot edit, create, or save. The API still makes all authorization decisions.
- Tracks unsaved title/content changes, supports Ctrl/Cmd+S, and asks before
  discarding changes for document navigation, new drafts, login or logout.
  Browser reload/close uses the standard `beforeunload` warning where supported.
- Preserves edits typed while a save is pending. Repeated writes are locked,
  and late responses cannot overwrite a newer document or signed-out state.
- On `412` (stale revision), `409` (duplicate create ID), or uncertain network/save
  results, retains the entire local buffer and retrieves the saved version for
  review. It never retries a write automatically. Compare both versions, copy
  needed changes into the editable buffer, then explicitly choose **Keep my text**
  and Save. That next save is conditional on the reviewed revision. **Use saved
  version** asks before discarding unsaved changes. A newer competing save can
  produce another conflict; it is not silently overwritten.
- Keeps unsaved text available after session expiry or permission failure.
  **Check session** can restore the same account or reflect a downgraded role.
  A forbidden response suspends writes until that session check succeeds.
  Drafts remain bound to their original principal and tenant even after expiry;
  a different account cannot adopt and save another account's draft. Download the
  text and reload to switch accounts. Sign-out success clears local document state.
- Offers an explicit **Download copy** action for the current body as a Markdown
  file. This is a user-requested local download, not automatic persistence.

The REST document model has no formatting metadata, rich-text controls, comments,
sharing UI, document-specific ACLs, search service, offline sync, or revision
history endpoint. The latest saved revision is not a complete version history.

### Separate from experimental Yjs

Revision-document mode makes REST reads and conditional saves only. That mode
never opens a WebSocket, requests a collaboration ticket, or performs dual
REST/Yjs writes. The optional live mode is described separately below.
The experimental Yjs transport and its rooms remain a separate integration with
a separate persistence model. The revision mode does not claim live multi-user cursors,
automatic merges, or seamless collaborative reconnection.

## Security and data handling

- All app requests use relative, same-origin routes, `credentials: 'same-origin'`,
  `cache: 'no-store'`, and `redirect: 'error'`. Only the server-returned OIDC
  authorization URL is used for top-level navigation.
- Login sends `POST /auth/login` with JSON and `X-OpenDoc-Login: 1`. Session reads
  use `/auth/session`. Every other mutation, including logout, sends JSON and
  the in-memory `X-OpenDoc-CSRF` secret. The browser supplies its own Origin.
- Provider tokens are never requested or used by the UI. Session/CSRF cookies
  remain HttpOnly. There is no localStorage, sessionStorage, IndexedDB, service
  worker, URL-based credential/document transport, analytics, or external font.
  The CSRF token and document bodies exist only in the current page's memory
  until an explicit save/download. A closed or reloaded tab loses unsaved work.
- Document titles, bodies and messages use text nodes, input values and textarea
  values only. Markdown and HTML remain literal text. No HTML is rendered from
  document content. Static assets include no inline scripts or event handlers.
- The hosting adapter applies a self-only CSP for scripts/styles/connections,
  `frame-ancestors 'none'`, `base-uri 'none'`, a no-referrer policy, no-store,
  nosniff and denied camera/microphone/geolocation permissions. Login deliberately
  navigates to the configured provider; do not loosen script/connect CSP for it.
- Drafts are not backed up automatically. Before login or leaving a tab with
  important unsaved text, download a copy. Browser unload dialogs are not
  guaranteed on every browser or mobile lifecycle event.

The UI is a convenience layer, never a replacement for server authentication,
CSRF checks, atomic revision checks, input limits or tenant isolation.

## Static hosting and HTTP integration

`src/web-client.mjs` exports:

- `createWebClientHandler({ handle, canonicalOrigin, allowInsecureLoopback? })`:
  asynchronously loads the four fixed assets, serves `/` and `/assets/*`, and
  delegates every other route to the supplied BFF handler. No filesystem path
  comes from a request. GET/HEAD static responses have correct MIME types.
- `createWebClientNodeListener({ handle, canonicalOrigin,
  allowInsecureLoopback?, maxBodyBytes?, requestTimeoutMs? })`: a Node HTTP(S)
  listener function, not a server starter. It constructs Request URLs from the
  operator's exact canonical origin, requires exactly one matching Host, rejects
  all Forwarded/X-Forwarded-* headers, absolute targets, backslashes, normalized
  traversal paths, and queries outside `/auth/callback`. It preserves separate
  Set-Cookie response headers, streams bodies with a finite cap, and bounds the
  response deadline. Defaults are a 20-second response deadline and the REST
  transport maximum of 6 MiB + 4 KiB; options may only tighten those limits.
- `WEB_CLIENT_CSP`: the static Content-Security-Policy string.

The host must provide HTTPS, finite server header/request/socket timeouts,
connection and global admission limits, ingress rate limiting, a trusted proxy
boundary, TLS certificates, HSTS policy and safe logging. In particular, never
log callback queries, cookie values or request bodies. The Node bridge does not
trust forwarding headers; a deliberately configured trusted proxy must strip
those headers and send the exact configured application Host. The bridge does
not establish which proxy is trusted, apply a distributed rate limiter, or stop
an uncooperative custom backend after its HTTP deadline. Do not expose a second
unguarded path to the REST handler. Do not add wildcard credentialed CORS.

Static assets can alternatively be hosted by a reviewed same-origin web server
with equivalent headers and routing. Do not put the app and cookie-authenticated
API on separate origins. Keep `/auth/callback` available exactly as registered.

### Production-neutral composition

The following is server-side composition, not a complete deployment launcher.
`pool`, `tlsOptions`, `oidcConfig` and `authEncryptionKey` must be supplied by the
operator. The schemas and memberships must already be provisioned. No runtime
migration, cloud resource creation, default provider or default credential is
performed. Install the PostgreSQL driver as a deployment dependency if using it.

```js
import { createServer } from 'node:https';
import { PostgresDocumentStore } from '../src/postgres-store.mjs';
import { PostgresAccountStore } from '../src/account-store.mjs';
import { PostgresBrowserAuthState } from '../src/postgres-browser-auth-state.mjs';
import { createBrowserOidc } from '../src/browser-oidc.mjs';
import {
  createWebClientHandler,
  createWebClientNodeListener,
} from '../src/web-client.mjs';

const canonicalOrigin = 'https://documents.example.org';
const documents = new PostgresDocumentStore({ pool, schema: 'opendoc_documents' });
const accounts = new PostgresAccountStore({ pool, schema: 'opendoc_accounts' });
const authState = new PostgresBrowserAuthState({
  pool,
  schema: 'opendoc_browser_auth',
  encryptionKey: authEncryptionKey, // operator-owned 32-byte Uint8Array
});
const browser = createBrowserOidc({
  ...oidcConfig, // explicit issuer, client authentication, auth/token/JWKS endpoints
  redirectUri: `${canonicalOrigin}/auth/callback`,
  activeTenantId: 'organization',
  resolveMembership: accounts.resolveMembership.bind(accounts),
  successPath: '/',
  authState,
});
const handle = await createWebClientHandler({
  handle: browser.createHandler({ store: documents }),
  canonicalOrigin,
});
const server = createServer({
  ...tlsOptions,
  maxHeaderSize: 16 * 1024,
  headersTimeout: 10000,
  requestTimeout: 30000,
}, createWebClientNodeListener({ handle, canonicalOrigin }));
server.setTimeout(30000, socket => socket.destroy());
// The operator chooses listener binding, startup, shutdown, proxy and HSTS policy.
```

For a fresh administrative bootstrap, initialize document/account schemas using
their dedicated bootstrap APIs, bind the browser trust configuration by constructing
`createBrowserOidc`, then explicitly call `await authState.initialize()` once for
a fresh auth schema. Do not put initialization in every runtime startup or use
runtime schema-creation privileges. See [browser login](browser-login.md),
[shared sessions](shared-sessions.md), [PostgreSQL](postgres.md), and
[account mapping](accounts.md) for requirements and limits. Shared sessions are
optional; omitting `authState` uses the bounded process-local evaluation state.

## Opt-in synthetic local editor

From `opendoc/` after installing dependencies:

```sh
OPENDOC_SYNTHETIC_EDITOR=1 node test/fixtures/editor-demo.mjs
```

Open the printed loopback URL on that same computer. The real editor runs with
an ephemeral maintained OIDC provider, synthetic memberships, and an in-memory
document store. Both listeners bind to `127.0.0.1`. No production credential,
external provider, PostgreSQL instance or public endpoint is used. Never enter
real credentials, publish the fixture, or proxy either listener publicly.
Everything resets when the fixture stops.

Identities:

- `synthetic-editor`: may read/create/save.
- `synthetic-viewer` and `synthetic-commenter`: read-only editor access.
- `synthetic-unmapped`: login must be denied.

Seed documents are `welcome` ("A place for your next idea") and `field-notes`.
For a conflict, sign in, open the same document in two tabs, save in the first,
then save different text in the second. The second tab must keep its buffer and
show the latest saved version. For a different provider identity, use a fresh
browser profile or restart the fixture; local OpenDoc logout intentionally does
not end the provider's SSO session. A cancelled provider flow is an auth callback
error, not a custom editor route; navigate back to the app root to retry.

## Verification

Run `npm test`, or the focused suite:

```sh
node --test test/editor-controller.test.mjs test/editor-integration.test.mjs test/web-client.test.mjs
```

The browser uses the same controller module exercised by unit tests. Tests cover
creation, conditional saves, text typed during save, repeated clicks, stale
navigation/logout responses, dirty-state cancellation, 412/409 recovery, uncertain
save results, role downgrade, expiry, and cross-account draft isolation. HTTP
integration tests use real local OIDC code/token/JWKS requests, the actual REST
API and editor controller, including two-client conflicts and read-only roles.
Host tests cover static security headers, exact origin/Host, forwarding headers,
raw targets, independent Set-Cookie headers, body bounds and response deadlines.
No DOM-testing dependency is needed. The shared browser entry point is now
bundled using pinned esbuild; run `npm run check:web` to verify source/artifact
consistency. See the [live editor build notes](live-editor.md).

A Chromium loopback smoke test on 2026-11-11 additionally verified synthetic
sign-in/consent, document creation and saves, a two-tab revision conflict with
both versions retained, explicit rebase/save, cancelled dirty navigation and
logout, confirmed logout, another tab becoming read-only after sign-out, provider
cancellation, viewer-only controls, and an actual Markdown download whose bytes
matched the synthetic document. No real credentials or documents were used.

Those tests are not proof of browser-specific cookies, CSP enforcement, production
TLS, a particular external identity provider, proxy behavior, distributed service
availability or a complete accessibility/browser compatibility audit. Browser QA
should additionally cover keyboard use, narrow screens, actual provider cancel,
two tabs, dirty navigation Cancel/Discard, download, session expiry and sign-out.

## Optional live document editor

The revision flow described above remains supported unchanged. The browser now also offers a separate, explicitly created live document mode. See [Authenticated live editor](live-editor.md) for local bundle generation, synthetic demo, host composition, persistence status, and recovery limits. Revision documents are never automatically converted or synchronized into this mode.
