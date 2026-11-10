# File format

A managed Markdown file is frontmatter followed by the document body. Prefer namespaced YAML for new files:

```markdown
---
gpdoc_metadata:
  id: "a-new-unique-id"
  filetype: document
  filename: "Project brief"
  created_at: "2026-01-01T00:00:00.000Z"
  updated_at: "2026-01-01T00:00:00.000Z"
  meta:
    location: "/"
---
# Project brief

The document text goes here.
```

The ID and dates above illustrate the shape; generate actual values. `id`, `filename`, and `filetype` identify managed files. Keep other root YAML keys, such as publishing metadata, outside `gpdoc_metadata` and preserve them. Quote timestamps to keep them strings. `meta` is nested inside GPDoc metadata, never a competing root review object.

An existing alternative is JSON between the same `---` delimiters, with `id`, `filename`, `filetype`, dates, and `meta` directly in the JSON object, without `gpdoc_metadata`. Preserve this representation when editing it. Do not create unnamespaced YAML: support differs across readers.

In Markdown files the body is authoritative. Do not duplicate it in `gpdoc_metadata.content` or a JSON frontmatter `content` field. In `.gpdoc.json` files, by contrast, the complete file is JSON and document text belongs in `content.document`. Preserve this envelope when asked to edit that format; never replace the whole JSON object with Markdown.

Line numbers for source-based review exclude frontmatter. Blank lines and fenced-code lines count. Split the body on LF, retaining its terminal empty element if it ends with a newline; an entirely empty body has zero lines. Preserve CRLF on disk and use one consistent normalized line-ending convention for comparisons and review strings. Never silently normalize existing review data if doing so would break its anchors.

Malformed frontmatter, unexpected field types, duplicated identity blocks, or conflicting embedded/body content require repair or clarification before review metadata is added. Do not discard unknown metadata to make a parser accept the file.
