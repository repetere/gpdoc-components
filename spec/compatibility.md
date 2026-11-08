# Client compatibility matrix

Evidence date: November 2026. “Not verified” is not a pass. This matrix separates a format contract from implementation support. No private application code is distributed here.

| Consumer | Envelope/body | Canonical source-hunk review | Presentation extensions | Verification |
| --- | --- | --- | --- | --- |
| Standalone agent skill | JSON, namespaced YAML, JSON document envelope | Explicit authoring and validation instructions | Tables, variables, themes, images and anchors guided separately | Example and relative links tested; agent behavior is not automatically certified |
| Optional public Python validator | JSON tested; optional safe YAML parsing | Reconstruction, stale ranges, flags and anchors checked | Preserved as unknown data, not rendered | Public unit tests and manifest fixtures |
| GPDoc document editor source-review implementation | Uses source baseline/proposal model | Matching model; client fixture checks tracked separately | Client-dependent | No universal version guarantee |
| Hosted/shared rich-editor integrations before adaptation | Metadata parsing does not imply review support | Single-line visible-draft assumptions conflict with canonical insertion/deletion/multiline hunks | Client-dependent | Known model mismatch; must adapt or decline mutation |
| Generic Markdown editor | Frontmatter may render as text or be stripped | No implied review UI | Markdown subset only | Verify preservation before saving |

## Certification checklist

Record client version/commit, fixture revision, operating system and each result rather than using one global “supported” badge. Test JSON and YAML envelopes separately. For each valid fixture verify body/proposal, accept-all, reject-all, selective acceptance in both orders, selective rejection, mixed decisions, save/reopen, unknown metadata and attribution preservation. Test comments after accepted changes. Invalid states must remain unchanged and report a conflict. Test BOM/CRLF bytes separately from normalized review strings.

Visual QA must additionally cover table editing, code/math/diagram preservation, image resource policy, unresolved variables, theme fallback, repeated-text anchors and source-to-rich-coordinate mapping. Browser/desktop and deployed builds need their own results. Library tests alone are not visual end-to-end certification.
