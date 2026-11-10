# GPDoc components

Open-source skills and components for GPDoc.

[Website and documentation](https://repetere.github.io/gpdoc-components/)

## Skills

- [GPDoc Markdown](INSTALL.md): create and edit GPDoc Markdown, comments, and pending suggestions with ordinary file tools. No GPDoc client or additional service is required.

## Install the skill

### Claude Code marketplace

Review the [skill source](skills/gpdoc-markdown/SKILL.md), then run:

```bash
claude plugin marketplace add repetere/gpdoc-components
claude plugin install gpdoc-markdown@gpdoc-components
```

Start a fresh Claude Code session and use:

```text
/gpdoc-markdown:gpdoc-markdown Create a GPDoc project brief at brief.md.
```

The public `gpdoc-components` marketplace is maintained by Repetere. This is not a claim of inclusion in Anthropic's directory or `claude-plugins-official`; directory publication requires a separate submission and approval. See [installation, updates, and verification](INSTALL.md#claude-code).

The plugin bundles the same standalone MIT-licensed skill below. It has no MCP server, hooks, account setup, or GPDoc application dependency. It uses your agent's existing file tools and permissions. Rendering, cloud synchronization, and live collaborative editing are separate capabilities.

### Codex and manual installation

Choose [Claude Code, Codex, or manual installation](INSTALL.md#quickstart-choose-your-agent), then create your first file. The [website quickstart](https://repetere.github.io/gpdoc-components/#quickstart) includes copyable commands and the full skill instructions.

## Standalone document profile

- [Canonical document profile](spec/document-v1.md)
- [Client compatibility matrix](spec/compatibility.md)
- [Interoperability fixtures](fixtures/manifest.json)
- [Optional read-only validator](tools/validate_gpdoc.py), with no GPDoc client or plugin dependency

## Structured slides, notebooks and scripts

The same standalone skill now covers JSON slide arrays, web/desktop notebook dialect preservation and script code/source fields. See [structured file guidance](skills/gpdoc-markdown/references/structured-files.md). These formats are not interchangeable across every client. Use `python tools/validate_structured.py file.gpdoc.json` for bounded read-only shape checks, with no third-party packages. Unknown structured slide objects are deliberately reported unsupported, not flattened.

See the [actual agent exercise and limits](tests/agent-exercises.md), including saved synthetic outputs and independent preservation assertions.

## Checks

Run `python -m unittest discover -s tests` to validate the examples, fixture expectations, review invariants and reference links. Run `python tools/validate_gpdoc.py path/to/document.md` to check a document. JSON needs only Python 3.10+; YAML validation optionally uses PyYAML.

For a plugin release, run `claude plugin validate --strict .claude-plugin/plugin.json` and `claude plugin validate --strict .claude-plugin/marketplace.json`, then install from the marketplace and check `claude plugin details gpdoc-markdown`. Increment the version in `.claude-plugin/plugin.json` for each release so installed copies can update.

## License

[MIT](LICENSE), copyright (c) 2026 Repetere. The standalone skill includes its own copy of the license. The [GPDoc brand icon](assets/NOTICE.md) is excluded from the MIT license.

## Privacy and support

See the [standalone plugin's privacy disclosure](PRIVACY.md). For support, use [GitHub issues](https://github.com/repetere/gpdoc-components/issues) or support@gpdoc.io. Send private privacy or security reports by email, without posting sensitive documents in a public issue.

