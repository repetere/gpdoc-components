# GPDoc Markdown privacy disclosure

Effective date: November 10, 2026.

This disclosure covers the standalone `gpdoc-markdown` skill and Claude Code plugin in [repetere/gpdoc-components](https://github.com/repetere/gpdoc-components). It is an instruction-only guide for formatting and editing GPDoc Markdown and related document formats. The skill itself does not collect, store, retain, or transmit document data.

This skill is separate from the GPDoc application and the GPEditor plugin. It does not open GPEditor, connect an MCP server, or sign in to a GPDoc account. This disclosure does not describe those separate products.

## What the skill provides

The skill provides format instructions and examples. It has no executable runtime, MCP server, background service, account system, telemetry, analytics, or data storage. It does not independently access files or send document content to Repetere or other services.

When you ask your assistant to use the skill, the assistant applies those instructions using its existing tools and permissions. The skill does not instruct it to upload documents or execute code contained in a document.

## Host assistant and other services

The host assistant, not a GPDoc service, performs any requested file reading or writing. Documents you provide may contain personal data, and the assistant can update their comments, suggested changes, and metadata. Only provide files and information you are authorized to use.

The host assistant processes the files you ask it to work on under that provider's terms, privacy policy, and your account settings. For Claude, see [Anthropic's Privacy Policy](https://www.anthropic.com/legal/privacy). If you use another assistant, review that provider's policy. A file in a cloud-synced folder or backup may also be stored by your chosen storage provider. Those services are separate from this plugin.

## Retention and deletion

There is no skill-side data retention and no Repetere-hosted copy of your documents. Any output files written by your assistant remain in the location you choose until you edit or delete them. Those user-controlled files are not data retained by this skill. Removing the skill does not remove your documents. Manage any host-assistant history, synced copies, and backups through their respective services.

## Children

This plugin is not designed or marketed for people under 18.

## Contact

For privacy or security questions, contact support@gpdoc.io. Do not include credentials or private document contents in public [GitHub issues](https://github.com/repetere/gpdoc-components/issues).
