# GPDoc skills

## GPDoc Markdown

[gpdoc-markdown](gpdoc-markdown/SKILL.md) teaches a coding assistant to create and edit GPDoc Markdown, add comment threads, and record pending suggestions directly in files. It includes format references and a complete review example. It also covers JSON slide arrays, notebook cells and scripts while preserving their web/desktop dialects; structured-format review is delivered separately rather than inventing document review metadata.

No GPDoc app, extension, CLI, MCP server, login, or network connection is needed to author files. Your assistant needs ordinary file read/write tools. A standard JSON parser is sufficient for JSON frontmatter; safe YAML parsing is useful for YAML files. Rendering and cloud synchronization are separate capabilities.

### Install in Codex

Ask Codex:

> Use skill-installer to install gpdoc-markdown from https://github.com/repetere/gpdoc-components/tree/main/skills/gpdoc-markdown

Or, using Codex's bundled installer from its installed location:

```sh
python /path/to/skill-installer/scripts/install-skill-from-github.py \
  --repo repetere/gpdoc-components \
  --ref main \
  --path skills/gpdoc-markdown
```

The installer copies the complete skill folder into `$CODEX_HOME/skills` (normally `~/.codex/skills`). It will be available on the next turn. Pin a reviewed commit SHA with `--ref` for reproducible installs.

### Other agents

Copy the complete `skills/gpdoc-markdown` folder into your agent's supported skill directory, preserving `SKILL.md`, `references`, and `examples`. For Claude Code, a project-level skill can live at `.claude/skills/gpdoc-markdown`. Otherwise provide `SKILL.md` and its linked references as context; discovery conventions vary by host. No GPDoc-specific client is involved.

### Try it

- "Use gpdoc-markdown to create a GPDoc project brief at brief.md."
- "Use gpdoc-markdown to propose a clearer introduction in brief.md, leaving accepted text unchanged."
- "Add a GPDoc comment asking for evidence on the launch-date paragraph."
- "Accept only suggestion ID X and preserve the other pending suggestions."

- "Change only slide 2 in deck.gpdoc.json, preserving the slide array."
- "Edit the introduction cell in notebook.gpdoc.json without running any cells."
- "Change the greeting in script.gpdoc.json without executing it."

### Compatibility and validation

The review instructions describe the current document source-range model, checked in November 2026. Older clients and hosted integrations may use different review coordinate systems. Preserve unfamiliar metadata and verify the intended consumer instead of assuming every version is interchangeable. This is file authoring, not live collaborative editing.

Run `python -m unittest discover -s tests` from the repository root to check the complete example and local reference links. These checks validate source structure, not visual rendering or every GPDoc client. No proprietary implementation, client package, or private account data is included.
