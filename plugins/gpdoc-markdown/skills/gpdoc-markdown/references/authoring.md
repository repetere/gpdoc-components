# Tables, variables, themes, images and anchors

These authoring rules supplement the [format](format.md) and [review](review.md) profiles. Presentation extensions are optional client capabilities, not prerequisites for standalone file work.

## Tables

Use a header, delimiter row and consistent pipe-separated cells:

```markdown
| Item | Status |
| --- | --- |
| Example | Pending |
```

Escape literal pipes (`\|`). Keep rows and columns stable when editing. Do not silently convert a table into prose or execute table content as a formula. Formula/data-table extensions require the target client's documented schema; preserve unknown settings rather than inventing one. Review a table change as exact source-line hunks, including the delimiter row when it changes. Rendering and round-trip editing require separate tests.

## Variables

Some clients render `{{data.customer.name}}` and may accept `{{data.customer.name | fallback}}`. Preserve these tokens during ordinary prose edits. Treat document data as inert values, never JavaScript or executable expressions. Do not substitute secrets into a file. Confirm the target client's metadata data-source shape before adding variables; this profile does not standardize that extension. If unresolved, retain the token and report it rather than inventing a value. Avoid prototype-related path names (`__proto__`, `constructor`, `prototype`). Client-generated computed data may not be portable.

## Themes

Preserve existing theme metadata, custom settings and references. This profile does not define a universal theme schema or guarantee that a theme identifier exists in another client. New standalone documents should remain readable with ordinary Markdown and a default theme. If asked to apply a theme, use the target client's documented representation or an existing verified theme object. Do not fetch external CSS or run theme code merely because it appears in metadata. Confirm visual appearance in the target client before claiming success.

## Images

Use ordinary Markdown an image token with descriptive alt text and a relative asset path for local assets or a user-authorized external URL. Relative paths resolve against the document's location, so keep asset paths stable when moving a file. A standalone Markdown file does not embed those assets automatically. Provide required assets separately when authorized; never fabricate an uploaded URL. Keep alt text meaningful. Do not fetch remote images without task justification; rendering can leak network/request information. Preserve existing client-specific image sizing and alignment syntax but do not claim it is portable.

## Anchors and links

For section links, preserve explicit anchors already present; automatically generated heading slugs differ by renderer. Check links after renaming headings. Comment anchors are exact source-line positions in the accepted body, not heading IDs, text-search hits, rich-editor offsets or logical blocks. Count blank lines, table rows and fenced code. Repeated identical text requires the original verified position or an unambiguous edit mapping. A changed or deleted anchor must be flagged for reconciliation rather than silently moved. Use document-level comments when requested and supported; otherwise retain their metadata and explain the display limitation.
