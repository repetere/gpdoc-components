# Authenticated live editor

OpenDoc's browser editor supports two explicit, separate document kinds:

- **Revision document:** existing `/api/v1/documents` JSON records. Changes are saved only by choosing Save and use revision guards. Nothing converts these documents to Yjs.
- **Live document:** `/api/v1/live-documents` records backed by one authoritative Yjs state. Choose New live document, write the initial draft, Create live document, then Connect. Existing live documents connect when opened. The JSON read API is a projection for metadata/export, not an editor initialization source.

This is a reference implementation, not a hosted service. See [live document authority](live-documents.md), [browser authentication](browser-login.md), and [deployment](deployment.md) for operator responsibilities.

## Run the synthetic local demo

Use Node 22 or newer. From `opendoc/`:

```sh
npm ci --ignore-scripts
npm run build:web
OPENDOC_SYNTHETIC_EDITOR=1 npm run demo:editor
```

The fixture prints a random IPv4 loopback URL and starts a local synthetic OIDC provider. Choose `synthetic-editor`, `synthetic-viewer`, or `synthetic-commenter`. No real credentials are needed or accepted. The fixture and its memory stores are for local QA only. Do not expose either listener publicly. All demo documents disappear on restart.

Open **Together, in real time** (`live-welcome`) in two tabs to test shared editing. The `welcome` and `field-notes` documents remain revision-based and can demonstrate an explicit save conflict.

## Host composition

Configure `createBrowserOidc` with a real operator-owned provider and current tenant membership resolver. Give the same `liveStore` instance to both the HTTP handler and WebSocket attachment:

```js
const handle = await createWebClientHandler({
  handle: auth.createHandler({ store: revisionStore, liveStore }),
  canonicalOrigin
});
const listener = createWebClientNodeListener({ handle, canonicalOrigin });
const server = createServer(listener); // Or an operator-owned HTTPS server.
const collaboration = attachCollaborationServer({
  server, liveStore,
  authenticate: auth.authenticateCollaboration,
  allowedOrigins: [canonicalOrigin]
});
```

Serve the WebSocket route through the same exact origin as the browser application. Use HTTPS/WSS outside explicitly enabled loopback development. Origin/Host validation, CSRF checks, provider configuration, durable stores, ingress limits, TLS, and session/membership policy remain required. A live document capability declaration does not itself attach a WebSocket listener.

## What the status means

- **Persisted on server:** no local edits remain without a matching durable server acknowledgement. This is not a backup, replication, or recovery guarantee beyond the selected store.
- **Pending server confirmation:** the local Yjs document contains edits not yet acknowledged. Receiving a state snapshot alone never clears this status, including delete-only edits.
- **Renewing live access:** the previous transport has closed while the same session and document permission are revalidated for a fresh short-lived ticket. Edits and IME composition remain in memory.
- **Reconnecting · attempt N of 3:** a transient connection or acknowledgement failure is being retried. Retained work is not confirmed until a matching durable acknowledgement arrives.
- **Live access ended:** session, account, tenant, or grant validation failed. Automatic attempts stop and unconfirmed text remains available read-only for download.
- **Live connection stopped:** the user chose Stop live connection, or a terminal protocol/limit problem prevented safe continuation. Choose Reconnect explicitly after addressing the problem.
- **Disconnected · changes in this tab only:** retained pending work has no active transport. It is not durable. Download a copy before closing the tab.
- **Disconnected · last changes persisted:** previously submitted local work was confirmed, but further remote edits are not being received.

While connected, edits are transmitted automatically. The transport allows only one unacknowledged update at a time and coalesces later edits into the current in-memory Yjs state. A ten-second acknowledgement timeout closes the transport without declaring success. Automatic reconnect merges authoritative server Yjs state into the retained Yjs document and replays unconfirmed updates, including delete-only changes. It never seeds a reopened document from a JSON snapshot. A committed update with a lost acknowledgement can be safely replayed as a Yjs update; a state echo alone never acknowledges it.

Browser collaboration tickets have an absolute maximum lifetime of **60 seconds** (the host can tighten it). Before expiry, the browser closes the old transport, fetches `/auth/session`, validates the original principal and tenant, and obtains a new route-bound ticket using that exact session's CSRF value. The ticket's identity, role, route, and expiry are checked before any new socket is opened. The BFF and collaboration server remain responsible for revalidating membership and session validity, including every write and idle revalidation. Renewal neither reuses a ticket nor extends its lifetime or the login session.

Rollover normally starts five seconds before ticket expiry, or 20% of the remaining lifetime for shorter tickets. The client also enforces the original absolute expiry and an elapsed-time deadline before authentication, updates, and received state. Delayed browser timers or a local wall-clock rollback cannot authorize old-ticket writes. Tickets with less than 250 milliseconds remaining are rejected rather than causing a renewal storm. Extremely short operator ticket limits may therefore require manual reconnection or a less restrictive limit.

Transient failures use at most three automatic retries with delays of 500, 1500, and 3000 milliseconds. Each attempt revalidates the session and obtains a new ticket. The failure budget resets only after 15 seconds of uninterrupted connection, so repeated short-lived connections cannot loop indefinitely. A terminal authorization, identity, protocol, or size failure stops automatic retries. Exhausting the budget leaves the document disconnected until explicit Reconnect. No online/visibility event silently restarts a stopped connection.

Pending state is bound to its original principal, tenant, and document. Account or tenant changes cannot reuse the retained document under a new identity. Viewer/commenter sessions never submit or replay updates. Session expiry, failed authorization, and role downgrades preserve the text read-only where necessary. Unfinished IME text remains pending across renewal, and a composition completed after a downgrade is retained for download instead of being submitted. Checking the session closes the old live transport; choose Reconnect to resume it.

Leaving pending work requires a confirmation. An in-flight write may already have reached the server, so leaving is not an undo. An uncertain create is never blindly resubmitted: download the draft and inspect the live library. The Stop live connection button, explicit session check, navigation, login/logout, and page teardown cancel renewal/retry timers and abort outstanding authorization requests. Generation checks reject late responses even if a request ignores abort. There is no browser-storage draft cache, durable offline queue, or promise that closing an unconfirmed tab is safe. Automatic retry is limited to the current open live document; uncertain document creation is never retried automatically.

## Editing limits and behavior

The initial editor supports plain text and Markdown, with separate Y.Text title/content fields. It does not render document HTML. Title is limited to 200 UTF-16 code units, content to 256 KiB UTF-8, and encoded Yjs state to 1 MiB, including history. Long editing histories can reach the state limit before the visible text limit. Rejected bounded input is retained read-only for download rather than sent or silently replaced. Start a new document after saving that copy.

Textarea changes apply a bounded prefix/suffix edit, preserving unchanged CRDT characters. Boundaries never split a UTF-16 surrogate pair. IME composition anchors to the pre-composition CRDT state and retains concurrent remote insertions. Remote selection positions use Yjs relative positions. This is not a rich-text editor: no awareness cursors, presence roster, rich-text marks, comments UI, undo UI, or offline disk queue is provided.

## Local, reproducible browser bundle

`npm run build:web` bundles the checked-in browser entry point, Yjs, and dependencies with pinned esbuild into `web/dist/editor.mjs`. There are no external module imports, CDN scripts, fonts, analytics, source maps, or runtime third-party requests. The static host serves only explicitly allowlisted assets with no-store and a same-origin CSP.

Yjs's lib0 configuration dependency normally probes browser persistent storage. The browser build substitutes the small original `scripts/browser-memory-storage.mjs` adapter for lib0's storage module, keeping that configuration in memory. No document, draft, ticket, CSRF value, or credential is stored in browser storage.

`web/dist/THIRD-PARTY-NOTICES.txt` includes pinned Yjs, lib0, and isomorphic.js license notices and is served at `/assets/THIRD-PARTY-NOTICES.txt`. Regenerate both files after source or dependency changes. `npm run check:web` builds in memory and fails if either checked-in artifact differs.

## Verification

`npm test` includes real synthetic OIDC + HTTP/WebSocket editor integration, two-client concurrent changes, deletion, offline replay, reopen, read-only roles, expired accounts, ticket namespace binding, stale reconnect responses, automatic short-ticket renewal, committed deletion with a lost acknowledgement, revoked-grant retry termination, identity changes between session and ticket issuance, logout/navigation/stop during pending renewal, Unicode/IME cases, bounded input, explicit acknowledgement semantics, coalescing, and all existing REST editor tests. Automated controller tests do not replace actual browser checks for cookies, CSP, focus, selection, downloads, and navigation prompts.


A Chromium loopback smoke test on 2026-11-11 exercised real synthetic sign-in,
two-tab text/title propagation, emoji replacement, disconnected edits retained
while another tab writes, Cancel on the pending-work navigation prompt, explicit
reconnect/replay, reload/reopen of the merged document, viewer read-only controls,
and sign-out. An earlier pass also exercised explicit live creation and connect.
The v0.7 pass used eight-second synthetic tickets with one-second server
revalidation. Two Chromium tabs kept sharing text/title changes across repeated
renewals. It exercised Stop and explicit Reconnect, a paused session check with
retained edits, Cancel on pending navigation, merge with a concurrently editing
tab, automatic recovery after suspending and resuming the local server, and
cross-tab logout becoming read-only without replay. These are bounded local
checks, not a real-world network or suspended-device test matrix.
All accounts and content were synthetic. IME race coverage is automated, not a
claim of a complete operating-system/input-method matrix. These checks do not
establish production TLS/cookie behavior, external provider compatibility,
cross-node fanout, database recovery, accessibility conformance or air-gap operation.
