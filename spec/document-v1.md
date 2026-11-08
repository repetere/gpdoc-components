# GPDoc standalone document profile v1

Status: implementation profile, November 2026. This document defines the canonical source-review interchange contract, not a claim that every GPDoc client implements it. No account, plugin, service or proprietary library is required to author or validate a file.

## Scope and serialization

The normative serialization rules are in [format](../skills/gpdoc-markdown/references/format.md); the normative review fields and operations are in [review](../skills/gpdoc-markdown/references/review.md). Together with this document they define this profile. `filetype: document` is in scope. Notebook and slide review are not.

A writer MUST preserve identity, unknown metadata and the existing envelope. New managed files MUST have nonempty string `id`, `filename`, `created_at`, `updated_at`, and `filetype: document`. Dates SHOULD be UTC ISO 8601 strings. YAML uses `gpdoc_metadata`; direct JSON frontmatter is an alternative. A `.gpdoc.json` envelope uses `content.document`. Markdown bodies MUST NOT compete with embedded `content` fields.

Readers MUST reject duplicate mapping keys and unsafe YAML constructors. YAML aliases, anchors and explicit tags are outside this profile. Missing optional feature support MUST NOT be interpreted as permission to strip that data.

## Canonical review

The accepted body is the source of truth. A pending suggestion state stores the same `baselineContent`, a complete `proposedContent`, and nonoverlapping source-line hunks. Clients MUST validate the entire state before mutation. Empty text is zero lines; otherwise split on LF and retain a terminal empty element. Empty arrays mean no lines; `[""]` means one blank line. Arrays, not joined text alone, MUST reconstruct the proposal. Multiple hunks beginning at the same baseline position MUST be combined to avoid order ambiguity.

Transport CRLF is normalized to LF for review comparisons, including embedded review strings when importing legacy files. New writers MUST use LF in review strings and preserve transport line endings/BOM on disk. If normalization would alter an existing anchor ambiguously, stop and reconcile. Coordinates exclude frontmatter.

Accepting one item changes the baseline and saved body, leaves the proposal unchanged, removes the selected item, and rebases surviving items. Rejecting changes the proposal, leaves the baseline/body unchanged, removes the selected item and rebases survivors. Preserve surviving identities, authorship and unknown fields. Never partially mutate a stale or malformed state. Empty review state has equal body, baseline and proposal with `items: {}`.

Comments use verified 1-based source line anchors with exact `lineContent`. Line zero is a document-level anchor; clients that cannot display it MUST preserve it. Rich-editor offsets and logical block indices are separate coordinate systems, not substitutes for source lines. After a baseline edit, reanchor only where the mapping is unambiguous; otherwise retain and flag the unresolved anchor rather than silently attaching it to different text.

## Client capabilities

A client can implement preservation, source review, or presentation independently. It MUST describe which it supports. A successful parse does not certify save/reopen, visual rendering, selective acceptance or cross-client compatibility. See the [compatibility matrix](compatibility.md).

## Validation and security

[The optional validator](../tools/validate_gpdoc.py) checks document identity, envelope/body authority, source review reconstruction, comment anchors and statistics. It is read-only and never executes document text or resolves external resources. JSON requires only Python 3.10+; YAML optionally uses PyYAML. It is not a complete YAML/Markdown renderer or a validator for every GPDoc extension. It does not check timestamp ordering, author identity, image availability, theme rendering or visual layout.

Run `python tools/validate_gpdoc.py path/to/document.md`. Exit 0 means all supplied documents passed the supported profile; exit 1 means validation failed. Unsupported profiles are failures rather than silently successful checks. Run the full suite with `python -m unittest discover -s tests`.

The [fixture manifest](../fixtures/manifest.json) identifies valid and deliberately invalid cases. Consumers should test every valid case through open, preview, selective accept/reject, save and reopen, and reject invalid cases without mutation. A fixture pass in one library does not imply a deployed-client pass.
