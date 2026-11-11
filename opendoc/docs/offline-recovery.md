# Offline recovery boundaries

**Durable browser drafts and an offline disk queue are not implemented.**
The live editor retains its Yjs document in the current tab's memory. It can
reconnect and replay unconfirmed changes while that tab remains open, but a
reload, closed tab, browser crash, or process eviction can lose that copy.
Download unconfirmed text before leaving. A download is a separate copy, not an
automatic recovery mechanism.

Only a matching server acknowledgement marks a local edit as persisted. A
received document snapshot or successful reconnection does not. An interrupted
write may already have committed, so reconnect merges and replays the retained
Yjs state rather than replacing the server document or assuming failure.
Server persistence depends on the selected store: the memory demo is ephemeral;
PostgreSQL durability still requires operator-managed backups and tested
recovery. Neither option makes unacknowledged tab-only work durable.

The browser bundle does not store document drafts, tickets, CSRF values, or
credentials in local storage or IndexedDB. See [live editor behavior](live-editor.md)
and [authoritative live documents](live-documents.md).

## Acceptance criteria for a future disk queue

Disk persistence is a separate security and data-integrity milestone. It must
meet these criteria before the UI describes local changes as recoverable:

- **Identity isolation:** partition records by deployment/origin, stable
  principal, tenant, document ID, and storage format version. Reauthenticate and
  match the original owner before displaying or replaying recovered text. A
  document ID alone is not a safe storage key.
- **Revocation and retention:** define and test what logout, session expiry,
  account switching, deleted documents, and lost access do to retained records.
  Never submit recovered edits under another identity or a read-only role. Show
  blocked recovery explicitly, with a deliberate export or deletion path where
  the deployment's policy permits it. Retention and deletion must be visible
  choices, not accidental side effects of changing accounts.
- **Shared-device safety:** explain what remains on the device, for how long,
  and how it is removed. Same-origin scripts and compromised browser sessions
  can access browser data. Encryption alone does not protect against XSS or
  shared-device access if the application can retrieve the decryption key.
  Never persist session/provider credentials, tickets, or CSRF values in drafts.
- **Atomicity and bounded storage:** persist local Yjs changes crash-consistently,
  handle quota limits and storage denial, and surface failures before claiming
  the local copy is saved. Bound storage growth, including CRDT history, and
  never silently evict the only unconfirmed copy. Browser storage may itself be
  evicted; local persistence is not a backup guarantee.
- **Versioning and recovery:** validate records, provide safe schema migrations,
  and quarantine corrupt or incompatible data without silently discarding it.
  Recover through the authoritative Yjs protocol and current authorization,
  preserving acknowledgement uncertainty and delete-only edits. Do not
  reconstruct a live document from a stale REST snapshot.
- **Recovery UX and tests:** distinguish saved locally, awaiting server
  confirmation, persisted on server, and recovery blocked. Test crash/reload,
  lost acknowledgements, offline edits, concurrent tabs, changed accounts and
  tenants, expired/revoked grants, document deletion, corrupt records, migrations,
  quota exhaustion, storage eviction/denial, and interrupted deletion. Prove
  that none of these paths silently lose work or expose another account's text.

These are requirements for future work, not current feature or security claims.
