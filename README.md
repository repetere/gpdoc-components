# GPDoc components

Open-source skills and components for GPDoc.

## Skills

- [GPDoc Markdown](skills/README.md): create and edit GPDoc Markdown, comments, and pending suggestions with ordinary file tools. No GPDoc client or additional service is required.

## Standalone document profile

- [Canonical document profile](spec/document-v1.md)
- [Client compatibility matrix](spec/compatibility.md)
- [Interoperability fixtures](fixtures/manifest.json)
- [Optional read-only validator](tools/validate_gpdoc.py), with no GPDoc client or plugin dependency

## Checks

Run `python -m unittest discover -s tests` to validate the examples, fixture expectations, review invariants and reference links. Run `python tools/validate_gpdoc.py path/to/document.md` to check a document. JSON needs only Python 3.10+; YAML validation optionally uses PyYAML.

## License

[MIT](LICENSE), copyright (c) 2026 Repetere. The standalone skill includes its own copy of the license.

