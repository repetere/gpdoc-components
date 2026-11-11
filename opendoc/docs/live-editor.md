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
- **Disconnected · changes in this tab only:** retained pending work has no active transport. It is not durable. Download a copy before closing the tab.
- **Disconnected · last changes persisted:** previously submitted local work was confirmed, but further remote edits are not being received.

While connected, edits are transmitted automatically. The transport allows only one unacknowledged update at a time and coalesces later edits into the current in-memory Yjs state. A ten-second acknowledgement timeout disconnects without declaring success. Reconnect is explicit: it rechecks the authenticated session, obtains a fresh route-bound ticket, merges the current server Yjs state with the retained Yjs document, and replays retained changes. It never seeds a reopened document from a JSON snapshot.

Browser collaboration tickets have an absolute maximum lifetime of **60 seconds**
(the host can tighten it). The current transport revalidates that expiry for the
whole connection, not just admission, so a tab will disconnect at the next write
or idle check after expiry. Choose Reconnect to obtain a fresh ticket and resume;
there is no automatic renewal in this milestone. This is an evaluation limit,
not a seamless long-running collaborative session.

Pending state is bound to its original principal, tenant, and document. Account or tenant changes cannot reuse the retained document under a new identity. Viewer/commenter sessions never submit or replay updates. Session expiry, failed authorization, and role downgrades preserve the text read-only where necessary. Checking the session closes the old live transport; choose Reconnect to resume it.

Leaving pending work requires a confirmation. An in-flight write may already have reached the server, so leaving is not an undo. An uncertain create is never blindly resubmitted: download the draft and inspect the live library. There is no background retry, browser-storage draft cache, or promise that closing an unconfirmed tab is safe.

## Editing limits and behavior

The initial editor supports plain text and Markdown, with separate Y.Text title/content fields. It does not render document HTML. Title is limited to 200 UTF-16 code units, content to 256 KiB UTF-8, and encoded Yjs state to 1 MiB, including history. Long editing histories can reach the state limit before the visible text limit. Rejected bounded input is retained read-only for download rather than sent or silently replaced. Start a new document after saving that copy.

Textarea changes apply a bounded prefix/suffix edit, preserving unchanged CRDT characters. Boundaries never split a UTF-16 surrogate pair. IME composition anchors to the pre-composition CRDT state and retains concurrent remote insertions. Remote selection positions use Yjs relative positions. This is not a rich-text editor: no awareness cursors, presence roster, rich-text marks, comments UI, undo UI, offline disk queue, or automatic reconnection is provided.

## Local, reproducible browser bundle

`npm run build:web` bundles the checked-in browser entry point, Yjs, and dependencies with pinned esbuild into `web/dist/editor.mjs`. There are no external module imports, CDN scripts, fonts, analytics, source maps, or runtime third-party requests. The static host serves only explicitly allowlisted assets with no-store and a same-origin CSP.

Yjs's lib0 configuration dependency normally probes browser persistent storage. The browser build substitutes the small original `scripts/browser-memory-storage.mjs` adapter for lib0's storage module, keeping that configuration in memory. No document, draft, ticket, CSRF value, or credential is stored in browser storage.

`web/dist/THIRD-PARTY-NOTICES.txt` includes pinned Yjs, lib0, and isomorphic.js license notices and is served at `/assets/THIRD-PARTY-NOTICES.txt`. Regenerate both files after source or dependency changes. `npm run check:web` builds in memory and fails if either checked-in artifact differs.

## Verification

`npm test` includes real synthetic OIDC + HTTP/WebSocket editor integration, two-client concurrent changes, deletion, offline replay, reopen, read-only roles, expired accounts, ticket namespace binding, stale reconnect responses, Unicode/IME cases, bounded input, explicit acknowledgement semantics, coalescing, and all existing REST editor tests. Automated controller tests do not replace actual browser checks for cookies, CSP, focus, selection, downloads, and navigation prompts.


A Chromium loopback smoke test on 2026-11-11 exercised real synthetic sign-in,
two-tab text/title propagation, emoji replacement, disconnected edits retained
while another tab writes, Cancel on the pending-work navigation prompt, explicit
reconnect/replay, reload/reopen of the merged document, viewer read-only controls,
and sign-out. An earlier pass also exercised explicit live creation and connect.
All accounts and content were synthetic. IME race coverage is automated, not a
claim of a complete operating-system/input-method matrix. These checks do not
establish production TLS/cookie behavior, external provider compatibility,
cross-node fanout, database recovery, accessibility conformance or air-gap operation.
