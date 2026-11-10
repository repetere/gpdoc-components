# GPDoc Markdown

Create and edit GPDoc Markdown and related document formats with your assistant's ordinary file tools. This standalone skill explains document metadata, comments, and reviewable suggestions, plus JSON slides, notebook cells, and script source formats.

It is a format guide, not the GPEditor application or an MCP integration. It has no executable runtime, account, background service, telemetry, or document storage. Your assistant performs the file work using its existing permissions. The skill itself does not collect, retain, or transmit data.

## Use the skill

In Claude Code 2.1.275 or later, install with `/plugin install gpdoc-markdown --marketplace repetere/gpdoc-components`.

After installation, invoke `/gpdoc-markdown:gpdoc-markdown` in Claude Code or ask your assistant to use GPDoc Markdown. Examples:

- Create a GPDoc project brief at `brief.md`.
- Propose a clearer introduction in `brief.md`, leaving accepted text unchanged.
- Add a comment asking for evidence on the launch-date paragraph.
- Accept only the selected suggestion and preserve all other pending suggestions.

Read the [complete skill](skills/gpdoc-markdown/SKILL.md) and the relevant references before editing. See the [installation guide](https://github.com/repetere/gpdoc-components/blob/main/INSTALL.md) and [format documentation](https://repetere.github.io/gpdoc-components/).

## Limits

This skill works on source files. It does not synchronize a cloud document, update an unsaved GPEditor session, notify collaborators, render the document, or execute code contained in a document. Structured file formats and review coordinates differ between clients. Preserve the existing representation and verify the intended consumer rather than assuming universal compatibility.

## Privacy and support

The [privacy disclosure](PRIVACY.md) separates this instruction-only skill from the host assistant's processing and user-controlled output files. For support, privacy, or security questions, contact support@gpdoc.io. Use [GitHub issues](https://github.com/repetere/gpdoc-components/issues) for public bug reports without private documents or credentials.

## License

The skill and documentation are [MIT licensed](LICENSE). The [GPDoc brand icon](assets/NOTICE.md) is excluded from that license.
