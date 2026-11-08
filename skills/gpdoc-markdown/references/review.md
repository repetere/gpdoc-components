# Portable document review

This guide targets the current document editor's source-range review model. Older line-only suggestions and some hosted/editor integrations use different coordinate models. Preserve legacy data and do not claim automatic cross-version migration. If the target consumer is known to require another schema, verify that schema before writing it.

All paths below start at the GPDoc metadata object (under `gpdoc_metadata` for namespaced YAML).

## Comments

`meta.comments.threads` is an object keyed by unique thread ID, not a flat array. A new thread has this shape:

```json
{
  "id": "thread-example",
  "position": {"lineNumber": 3, "column": 1, "lineContent": "The launch date is provisional."},
  "resolved": false,
  "resolvedBy": null,
  "resolvedAt": null,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "comments": [{
    "id": "comment-example",
    "text": "Which dependency determines the launch date?",
    "author": {"userId": "local-agent", "name": "AI assistant"},
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z"
  }]
}
```

Generate unique IDs/current timestamps. Use truthful local-agent attribution, not an invented human account. Anchor `lineContent` to the exact source line and use a 1-based source `lineNumber`. Do not invent rich-editor `from`, `to`, or `logicalBlockNumber` values: those are a different coordinate system. A document-level comment can use `position: {"lineNumber": 0}` where the consumer supports it. For ambiguous existing anchors, leave the thread unchanged and explain the ambiguity.

Append replies to `comments` in the same thread, retaining prior comments. Update thread `updatedAt`. Maintain `meta.comments.metadata`: `totalComments` counts individual comments in all threads; `resolvedComments` counts resolved threads; `lastCommentAt` is the latest comment creation time. To resolve a requested thread, set `resolved: true` and `resolvedAt` to the current timestamp; reopening sets `resolved: false` and `resolvedAt: null`. Do not fabricate a human resolver identity.

## Pending suggestions

Store `meta.suggestions` with `enabled: true`, `baselineContent` (the accepted body), `proposedContent` (the complete proposed body), and `items` (an object keyed by stable suggestion ID). The Markdown body stays equal to the baseline until acceptance.

Use contiguous changed line hunks, not a naive line-index comparison after an insertion. Each item contains:

- `id`: unique and identical to its map key.
- `oldStart`, `oldEnd`: zero-based, half-open baseline line range.
- `newStart`, `newEnd`: zero-based, half-open proposed line range.
- `oldLines`, `newLines`: exact arrays of removed/replacement lines, without newline characters inside elements.
- `oldLineNumber = oldStart + 1`, `lineNumber = newStart + 1`.
- `oldLineCount`, `newLineCount`: array lengths.
- `oldContent`, `newContent`: corresponding arrays joined with LF.
- `changeType`: `added` when oldLines is empty, `deleted` when newLines is empty, otherwise `modified`. Do not use `inserted`.
- `applied: false`, `suggestedAt`: current ISO timestamp. Optional `suggestedBy` can honestly identify the agent with `id` and `name`.

See [the complete example](../examples/review.md). A replacement spanning several lines remains one hunk. For insertion, the old range is empty; for deletion, the new range is empty. Do not represent deletion as one empty string: `[]` means no line, while `[""]` means one blank line.

### Required invariants

1. Sort hunks by oldStart then newStart. They must not overlap. At each hunk, `newStart` equals `oldStart` plus the cumulative length delta from earlier hunks.
2. Each range length equals its array length. Every `oldLines` array exactly matches that slice of the baseline.
3. Replace baseline slices in reverse order to reconstruct the proposal. It must exactly match `proposedContent`, including blank lines and terminal newline semantics. Each new range must match its slice of the reconstructed proposal.
4. Existing suggestions must reconstruct cleanly before adding more. Start additional work from that reconstructed proposal, retain unchanged IDs/attribution, and rebuild all resulting ranges against the same accepted baseline. If existing edits overlap ambiguously or use an incompatible legacy schema, stop rather than erase them.
5. Never accept/reject another author's work implicitly while editing unrelated text.

### Accept/reject

First validate baseline, proposed body, and all hunks. For acceptance of one hunk, replace its baseline range with `newLines`; leave the proposal unchanged. For rejection, replace its proposed range with `oldLines`; leave the baseline unchanged. Remove the selected item and rebase/recompute all remaining hunks, retaining their stable identity and authorship where the change survives. Save the accepted baseline as the body. If none remain, retain unrelated suggestion metadata and set `items: {}` and both content strings to the accepted body (or remove completed review state if that is the file's established convention).

Do not infer a safe target from repeated text alone. A stale range, mismatched old text, or a body that matches neither the stored baseline nor a verified expected representation requires reconciliation before mutation.
