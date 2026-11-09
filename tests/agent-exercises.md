# Actual standalone skill exercise, 2026-11-09

A separate agent received the skill and linked references, ordinary file tools and only synthetic input files. It did not receive application source or use a GPDoc client, CLI, MCP, renderer or live session. It actually created and edited files, rather than merely running the validator. The output artifacts are in `fixtures/agent-run`; `test_agent_outputs.py` checks them independently against the original synthetic fixtures.

## Tasks and observed results

1. Directly change slide 2's revenue from 10 to 12 units. Passed: ordered string array, four elements including an empty slide, repeated titles, fenced code, other slides, custom fields and document ID preserved.
2. Change only the intro summary in a web notebook. Passed: `type`/`content`, IDs, the Python cell, output and custom fields preserved.
3. Make the same change in a desktop notebook. Passed: `cell_type`/`source`, source array representation, other cell scalar source, IDs and outputs preserved.
4. Change a greeting in each script dialect without executing it. Passed: `code` versus `script`, language and runtime metadata preserved.
5. Create a JSON slide deck, notebook and script. Passed: fresh IDs/timestamps, requested content, explicit web dialect on notebook/script, no document-body flattening.
6. Create a Markdown slide deck. Passed: namespaced YAML `filetype: slides`, two requested slides and default HTML page-break delimiter. JSON slides remained a separate array representation.
7. Review slide 2 with a proposed revenue of 15, without changing accepted content. Passed: separate human-readable proposal, no invented document suggestion metadata, originals byte-identical.
8. Review an object-array slide fixture. Passed: identified unsupported shape, preserved IDs/layout/content, declined to flatten or claim native compatibility.

The initial slide task said “nothing else,” which the agent interpreted as prohibiting the required timestamp update. The evaluator clarified that this meant content scope, then the agent updated `updated_at`. The final artifacts and assertions reflect that clarification. This was an actual ambiguity discovered during the exercise, not a first-attempt perfect result.

## Repeat the exercise

Copy `fixtures/structured` into a disposable workspace. Give a fresh agent `skills/gpdoc-markdown/SKILL.md`, its references and tasks above, specifying that targeted edits also update `updated_at`. Ask it to save outputs separately, preserve original bytes and report any ambiguity. Compare complete parsed structures, allowing only requested fields/timestamp differences; compare input bytes for review-only tasks. Use `python tools/validate_structured.py` as an additional shape check, not a substitute for those comparisons.

## Bounded evidence

The automated suite has 16 test methods plus fixture/subtest cases: all pass with optional PyYAML installed. `python -S -m unittest discover -s tests -v` passes 14 methods and skips the two optional YAML checks. The structured suite includes five valid profile fixtures, ten invalid/unsupported mutations, duplicate/nonfinite JSON checks and read-only CLI checks. Existing document fixtures continue to pass.

These saved outputs are evidence of one agent-use run. Replaying artifact assertions does not run an agent again and does not establish reliability across all prompts/models. Native structured-format review, actual client import/save/reopen, notebook/script execution and visual rendering remain unverified. Web and desktop notebook/script representations differ; preserving each dialect is not proof of cross-client interchange. All published examples and artifacts are synthetic; no private application implementation or user files are included.
