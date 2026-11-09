# GPDoc components

Open-source skills and components for GPDoc.

## Skills

- [GPDoc Markdown](skills/README.md): create and edit GPDoc Markdown, comments, and pending suggestions with ordinary file tools. No GPDoc client or additional service is required.

## Install the skill

Choose [Claude Code, Codex, or manual installation](skills/README.md#quickstart-choose-your-agent), then create your first file. The [website quickstart](https://repetere.github.io/gpdoc-components/#quickstart) includes copyable commands and the full skill instructions.

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

## License

[MIT](LICENSE), copyright (c) 2026 Repetere. The standalone skill includes its own copy of the license.

