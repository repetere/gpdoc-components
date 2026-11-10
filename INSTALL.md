# GPDoc skills

## GPDoc Markdown

[gpdoc-markdown](skills/gpdoc-markdown/SKILL.md) teaches a coding assistant to create and edit GPDoc Markdown, add comment threads, and record pending suggestions directly in files. It includes format references and a complete review example. It also covers JSON slide arrays, notebook cells and scripts while preserving their web/desktop dialects; structured-format review is delivered separately rather than inventing document review metadata.

No GPDoc app, extension, CLI, MCP server, login, or network connection is needed to author files. Your assistant needs ordinary file read/write tools. A standard JSON parser is sufficient for JSON frontmatter; safe YAML parsing is useful for YAML files. Rendering and cloud synchronization are separate capabilities.

### Quickstart: choose your agent

Install once, then ask your agent to use `gpdoc-markdown`. These are **local Claude Code and Codex** instructions, not Claude.ai/Cowork or hosted ChatGPT account installation. Review the [complete skill source](skills/gpdoc-markdown/SKILL.md) and its references before enabling it. Claude Code can install from the public marketplace or use a manual skill copy; neither requires a GPDoc login or client installation.

#### Claude Code

The recommended installation uses the public Repetere marketplace. Run in your terminal with Claude Code installed:

```bash
claude plugin marketplace add repetere/gpdoc-components
claude plugin install gpdoc-markdown@gpdoc-components
```

Start a fresh Claude Code session, then invoke the plugin's namespaced skill:

```text
/gpdoc-markdown:gpdoc-markdown Create a GPDoc project brief at brief.md.
```

Check `claude plugin list` for `gpdoc-markdown@gpdoc-components` with enabled status, and `claude plugin details gpdoc-markdown` for the `gpdoc-markdown` skill. The plugin also appears in `/plugin` after you add the marketplace. Update with `claude plugin update gpdoc-markdown@gpdoc-components`. Third-party marketplace auto-updates are off by default; review a release before updating. Keep local customizations in your own skill copy rather than editing the plugin cache.

This is Repetere's self-hosted marketplace, not an Anthropic directory listing or an entry in `claude-plugins-official`. Those are separate distribution routes and require acceptance by Anthropic. The plugin ships no hooks or MCP servers and grants no extra permissions.

**Manual alternative:** to install just the skill in one project, run from your project root (requires Git and a POSIX shell). Clone into a new `gpdoc-components` directory, inspect the skill, then copy it:

```sh
git clone https://github.com/repetere/gpdoc-components.git
# Review skills/gpdoc-markdown in the cloned repository before continuing.
mkdir -p .claude/skills
mkdir .claude/skills/gpdoc-markdown && \
  cp -R gpdoc-components/skills/gpdoc-markdown/. .claude/skills/gpdoc-markdown/
```

With the manual copy, invoke the unnamespaced skill instead:

```text
/gpdoc-markdown Create a GPDoc project brief at brief.md.
```

For all your local projects, substitute `~/.claude/skills` for `.claude/skills`. The final `mkdir` deliberately refuses an existing installation. To update, compare the old and new folders and preserve any local edits first. Claude Code discovers skill changes automatically; start a fresh session if the command does not appear.

Choose either the marketplace plugin or a manual copy to avoid duplicate skill names. Existing manual installations continue to work; do not remove a customized copy without reviewing it.

#### Codex

In Codex, ask the built-in installer:

```text
$skill-installer Install gpdoc-markdown from https://github.com/repetere/gpdoc-components/tree/main/skills/gpdoc-markdown
```

Then invoke:

```text
$gpdoc-markdown Create a GPDoc project brief at brief.md.
```

Use `/skills` to check discovery. Codex detects new skills automatically; restart if it does not appear. Let the bundled installer choose its destination. For a manual project installation, use `.agents/skills/gpdoc-markdown`; for all local projects, use `~/.agents/skills/gpdoc-markdown`:

```sh
# From your project root, after the clone and source review above:
mkdir -p .agents/skills
mkdir .agents/skills/gpdoc-markdown && \
  cp -R gpdoc-components/skills/gpdoc-markdown/. .agents/skills/gpdoc-markdown/
```

#### Manual / other agents

Download the repository using **Code → Download ZIP** on [GitHub](https://github.com/repetere/gpdoc-components), or use the clone above. Copy the **entire** `skills/gpdoc-markdown` folder into your host's supported skill directory, preserving this layout:

```text
gpdoc-markdown/
  SKILL.md
  LICENSE
  references/
    authoring.md
    format.md
    review.md
    structured-files.md
  examples/
    review.md
```

The [full SKILL.md](skills/gpdoc-markdown/SKILL.md), [authoring guide](skills/gpdoc-markdown/references/authoring.md), [format guide](skills/gpdoc-markdown/references/format.md), [review guide](skills/gpdoc-markdown/references/review.md), [structured-file guide](skills/gpdoc-markdown/references/structured-files.md), [example](skills/gpdoc-markdown/examples/review.md), and [license](skills/gpdoc-markdown/LICENSE) are all plain text. Copy their full contents, not just the short prompt. Do not flatten the folders: relative links depend on them. If your agent has no skill discovery, attach/provide these files as context and ask it to read `SKILL.md` and the relevant references before editing.

Installation downloads public files; subsequent file authoring needs no network. It does not install the repository validators or grant extra permissions. For reproducibility, check out a reviewed commit SHA in the cloned repository before copying, or give the installer a GitHub URL containing that SHA instead of `main`.

Verify with the sample prompt above: confirm the skill was selected, inspect the generated file and diff, and do not treat successful installation as proof of rendering or client interoperability.

Sources: [Claude Code skills](https://code.claude.com/docs/en/skills), [publishing Claude Code plugins](https://code.claude.com/docs/en/plugins/publish), [Codex skills](https://developers.openai.com/codex/skills/). Quickstart organization inspired by [Linked-Intent Development](https://linked-intent.dev/#quickstart).

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
