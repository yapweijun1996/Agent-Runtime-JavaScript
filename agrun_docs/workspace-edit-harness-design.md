# Workspace Edit Harness Design

## Scope

This note records the design boundary for agrun virtual workspace mutation
tools after research against coding-agent edit systems.

The goal is not to make runtime write or repair reports. The goal is to make
AI-authored workspace edits observable, rejectable, and version-locked before
they mutate the workspace.

## Research Findings

Claude Code's file edit contract is exact-edit first:

- `Edit` replaces an exact `old_string` with `new_string`.
- The file must have been read first and must not have changed since that read.
- The target string must match exactly.
- The target string must be unique unless the model explicitly chooses
  replace-all behavior.
- `Write` can overwrite, but existing files also require a prior read.

Source: <https://code.claude.com/docs/en/tools-reference>

OpenAI's apply-patch guidance follows the same harness shape:

- The model emits a patch with explicit add/update/delete operations.
- The patch parser loads current files, parses the patch, converts it into a
  commit, and only then writes/removes files.
- Alternative successful diff formats still share the key idea: explicit old
  code and explicit new code with clear delimiters.

Source: <https://developers.openai.com/api/docs/guides/prompt-guidance>

OpenTelemetry browser instrumentation can help debug runtime behavior, but it
is not a replacement for AI-visible harness facts. The OpenTelemetry browser
guide currently describes client instrumentation as experimental and mostly
unspecified.

Source: <https://opentelemetry.io/docs/languages/js/getting-started/browser/>

Gemini thinking controls are useful for live-test tuning. Gemini 3/3.5 models
support `thinkingLevel`, where low/minimal settings reduce latency/cost and
high increases reasoning depth and may increase first-token latency.

Source: <https://ai.google.dev/gemini-api/docs/thinking>

## Design Rules

1. AI owns edit intent and content.
2. Runtime validates current state, matchability, risk, and version.
3. Runtime does not synthesize missing report content or invent a repair.
4. Preview is a first-class observation, not hidden internal behavior.
5. Apply is locked to the latest valid preview.
6. Failed previews must produce compact, actionable diagnostics.
7. Workspace publish protocol remains separate: finalize, read latest
   candidate, then publish.

## Current agrun Contract

`workspace_propose_patch` is preview-only. It stores one latest pending patch
and returns compact facts:

- `patchId`
- `baseVersion`
- `beforeWords`
- `afterWords`
- `deltaWords`
- `changed`
- `status`
- `riskFlags`
- `previewSummary`
- optional `structureBefore` / `structureAfter`

`workspace_apply_patch` applies only the latest valid pending patch. It rejects
stale versions, patch id mismatches, invalid previews, and preview hash drift.

Patch operations are structured for weak-model reliability:

- `replace { find, replace, replace_all? }`
- `append { content, separator? }`
- `insert_after_section { heading, content, separator? }`
- `normalize_headings { headings:[{ lineNumber, text }] }`

`normalize_headings` is intentionally narrow:

- AI provides the exact line number and new heading text.
- Runtime verifies the line exists.
- Runtime verifies the line is currently a Markdown heading.
- Runtime only changes that one heading line.
- Runtime previews before/after structure.
- Runtime permits zero word growth only when structure improves.

This keeps it a generic edit primitive, not a report-specific fixer.

## Boundaries

Allowed runtime validation:

- path validation
- read/version/base hash checks
- exact match / ambiguity checks
- heading-line validation
- word delta calculation
- structure regression detection
- compact preview summaries
- operation audit trail

Not allowed:

- runtime inventing replacement prose
- runtime choosing which headings should exist
- runtime auto-generating a patch after failed AI attempts
- runtime silently applying a risky preview
- hardcoded report section templates
- bypassing existing finalize/read/publish protocol

## Review Result

Current `normalize_headings` stays inside the boundary. It is safe because the
AI still supplies the edit target and replacement text, while runtime only
checks whether the target line is a heading and whether the preview improves
observable structure.

The remaining weak spot is behavior, not mechanism: weak models may still mix
`normalize_headings` with fragile `replace` operations. The correct next
improvement is action-surface/prompt nudging and Inspector visibility, not
runtime-generated repair content.

